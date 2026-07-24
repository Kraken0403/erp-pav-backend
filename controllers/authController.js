const db = require("../config/db");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const nodemailer = require("nodemailer");
const { signAccessToken, signRefreshToken } = require("../utils/tokens");

/* =====================================================
   SIGNUP
===================================================== */
exports.signup = async (req, res) => {
  try {
    const { name, email, phone_number, password, roleId } = req.body;
    const normalizedPhone = String(phone_number || "").trim() || null;

    const hashedPassword = await bcrypt.hash(password, 10);

    let finalRoleId = roleId || null;
    let finalRoleName = "customer";

    // If no roleId provided, default website signups to the 'customer' role (if exists)
    if (!finalRoleId) {
      const [customerRoleRows] = await db.query(
        `SELECT id, name FROM roles WHERE name = 'customer' LIMIT 1`,
      );
      if (customerRoleRows.length) {
        finalRoleId = customerRoleRows[0].id;
        finalRoleName = customerRoleRows[0].name;
      } else {
        finalRoleId = null;
      }
    } else {
      const [roles] = await db.query(
        `SELECT id, name FROM roles WHERE id = ? LIMIT 1`,
        [finalRoleId],
      );

      if (!roles.length) {
        return res.status(400).json({ error: "Invalid role selected" });
      }

      finalRoleId = roles[0].id;
      finalRoleName = roles[0].name || "user";
    }

    if (normalizedPhone) {
      const [phoneRows] = await db.query(
        `SELECT id FROM users WHERE phone_number = ? LIMIT 1`,
        [normalizedPhone],
      );

      if (phoneRows.length) {
        return res
          .status(400)
          .json({ error: "Phone number is already used by another user" });
      }
    }

    await db.query(
      `INSERT INTO users (name, email, phone_number, password, role, role_id) 
       VALUES (?, ?, ?, ?, ?, ?)`,
      [name, email, normalizedPhone, hashedPassword, finalRoleName, finalRoleId],
    );

    res.status(201).json({ message: "User registered successfully" });
  } catch (err) {
    console.error("SIGNUP ERROR:", err);
    if (err?.code === "ER_DUP_ENTRY") {
      if (String(err.message || "").includes("email")) {
        return res
          .status(400)
          .json({ error: "Email is already used by another user" });
      }
      if (
        String(err.message || "").includes("phone_number") ||
        String(err.message || "").includes("uniq_users_phone_number")
      ) {
        return res
          .status(400)
          .json({ error: "Phone number is already used by another user" });
      }
      return res.status(400).json({ error: "Duplicate user details found" });
    }
    res.status(400).json({ error: err.message });
  }
};

/* =====================================================
   LOGOUT
===================================================== */
exports.logout = async (req, res) => {
  try {
    const token = req.cookies.refreshToken;

    console.debug("LOGOUT: incoming request", {
      tokenMask: token ? String(token).substring(0, 8) + "..." : null,
      cookies: req.headers?.cookie || null,
      ip: req.ip || null,
    });

    if (token) {
      await db.query(
        `UPDATE users 
         SET refresh_token = NULL, 
             refresh_token_expires = NULL 
         WHERE refresh_token = ?`,
        [token],
      );
      console.debug("LOGOUT: cleared refresh_token row for token mask", {
        tokenMask: String(token).substring(0, 8) + "...",
      });
    } else {
      console.debug("LOGOUT: no refresh token cookie present");
    }

    res.clearCookie("refreshToken");
    console.debug("LOGOUT: cleared refreshToken cookie");
    res.json({ message: "Logged out successfully" });
  } catch (err) {
    console.error("LOGOUT ERROR:", err);
    res.status(500).json({ error: "Logout failed" });
  }
};

/* =====================================================
   LOGIN
===================================================== */
exports.login = async (req, res) => {
  try {
    const { email, password } = req.body;

    const [result] = await db.query(
      `
      SELECT u.*, r.name AS role_name
      FROM users u
      LEFT JOIN roles r ON r.id = u.role_id
      WHERE u.email = ?
      LIMIT 1
      `,
      [email],
    );

    if (!result.length) {
      return res.status(401).json({ error: "User not found" });
    }

    const user = result[0];

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(401).json({ error: "Incorrect password" });
    }

    const effectiveRole = user.role_name || user.role || "user";

    const accessToken = signAccessToken({
      id: user.id,
      role: effectiveRole,
    });

    const refreshToken = signRefreshToken({
      id: user.id,
    });

    await db.query(
      `UPDATE users 
       SET refresh_token = ?, 
           refresh_token_expires = DATE_ADD(NOW(), INTERVAL 7 DAY)
       WHERE id = ?`,
      [refreshToken, user.id],
    );

    res.cookie("refreshToken", refreshToken, {
      httpOnly: true,
      secure: false, // TRUE in production (HTTPS)
      sameSite: "strict",
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    res.json({
      accessToken,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        phone_number: user.phone_number || null,
        role: effectiveRole,
        roleId: user.role_id || null,
        roleName: user.role_name || effectiveRole,
      },
    });
  } catch (err) {
    console.error("LOGIN ERROR:", err);
    res.status(500).json({ error: "Login failed" });
  }
};

/* =====================================================
   FORGOT PASSWORD
===================================================== */
exports.forgotPassword = async (req, res) => {
  try {
    const { email } = req.body;

    const resetToken = jwt.sign({ email }, process.env.JWT_SECRET, {
      expiresIn: "1h",
    });

    await db.query(
      `UPDATE users 
       SET reset_token = ?, 
           reset_token_expires = DATE_ADD(NOW(), INTERVAL 15 MINUTE)
       WHERE email = ?`,
      [resetToken, email],
    );

    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: process.env.EMAIL,
        pass: process.env.EMAIL_PASSWORD,
      },
    });

    await transporter.sendMail({
      from: process.env.EMAIL,
      to: email,
      subject: "Password Reset",
      text: `Use this token to reset your password: ${resetToken}`,
    });

    res.json({ message: "Password reset email sent" });
  } catch (err) {
    console.error("FORGOT PASSWORD ERROR:", err);
    res.status(500).json({ error: "Email failed to send" });
  }
};

/* =====================================================
   RESET PASSWORD
===================================================== */
exports.resetPassword = async (req, res) => {
  try {
    const { token, newPassword } = req.body;

    const [result] = await db.query(
      `SELECT * FROM users 
       WHERE reset_token = ? 
       AND reset_token_expires > NOW()`,
      [token],
    );

    if (!result.length) {
      return res.status(400).json({ error: "Invalid or expired token" });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);

    await db.query(
      `UPDATE users 
       SET password = ?, 
           reset_token = NULL, 
           reset_token_expires = NULL 
       WHERE id = ?`,
      [hashedPassword, result[0].id],
    );

    res.json({ message: "Password reset successful" });
  } catch (err) {
    console.error("RESET PASSWORD ERROR:", err);
    res.status(500).json({ error: "Password reset failed" });
  }
};

/* =====================================================
   REFRESH TOKEN
===================================================== */
exports.refreshToken = async (req, res) => {
  try {
    const token = req.cookies.refreshToken;

    if (!token) {
      return res.status(401).json({ error: "No refresh token" });
    }

    const decoded = jwt.verify(token, process.env.JWT_REFRESH_SECRET);

    const [result] = await db.query(
      `
      SELECT u.*, r.name AS role_name
      FROM users u
      LEFT JOIN roles r ON r.id = u.role_id
      WHERE u.id = ?
      AND u.refresh_token = ?
      AND u.refresh_token_expires > NOW()
      LIMIT 1
      `,
      [decoded.id, token],
    );

    if (!result.length) {
      return res.status(401).json({ error: "Refresh token expired" });
    }

    const user = result[0];
    const effectiveRole = user.role_name || user.role || "user";

    const newAccessToken = jwt.sign(
      { id: user.id, role: effectiveRole },
      process.env.JWT_SECRET,
      { expiresIn: "10m" },
    );

    res.json({ accessToken: newAccessToken });
  } catch (err) {
    console.error("REFRESH TOKEN ERROR:", err);
    res.status(401).json({ error: "Invalid refresh token" });
  }
};
