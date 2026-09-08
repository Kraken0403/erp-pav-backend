
// Fetch all users
const db = require('../config/db');
const bcrypt = require('bcryptjs');
const { ensureVendorSchema } = require('../utils/pavilionSchema');

const VISIBILITY_MODULE_KEYS = [
  'dashboard',
  'leads',
  'quotations',
  'work_orders',
  'kots',
  'deliveries',
  'invoices',
  'payment_reminders',
  'payments',
  'products',
  'vendors',
  'passbook',
  'settings',
  'reports',
  'users',
];

const getDefaultVisibilityPermissions = () => {
  return VISIBILITY_MODULE_KEYS.reduce((acc, key) => {
    acc[key] = true;
    return acc;
  }, {});
};

const mapPermissionRowToObject = (row) => {
  return VISIBILITY_MODULE_KEYS.reduce((acc, key) => {
    acc[key] = Object.prototype.hasOwnProperty.call(row, key) ? Boolean(row[key]) : true;
    return acc;
  }, {});
};

const getAuthenticatedUserId = (req) =>
  Number(req.user?.id ?? req.user?.userId ?? req.user?.user_id ?? 0);

const isAuthenticatedAdmin = (req) =>
  String(req.user?.role || req.user?.roleName || '').toLowerCase() === 'admin';

const USER_PROFILE_ADDRESS_COLUMNS = [
  'shipping_address',
  'shipping_landmark',
  'shipping_pincode',
  'billing_address',
  'billing_landmark',
  'billing_pincode',
];

const getAvailableUserProfileColumns = async () => {
  try {
    const [rows] = await db.query(
      `
      SELECT COLUMN_NAME
      FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'users'
        AND COLUMN_NAME IN (${USER_PROFILE_ADDRESS_COLUMNS.map(() => '?').join(', ')})
      `,
      USER_PROFILE_ADDRESS_COLUMNS
    );
    return new Set(rows.map((row) => row.COLUMN_NAME));
  } catch (_) {
    return new Set();
  }
};

const loadUserProfileRecord = async (userId) => {
  const availableColumns = await getAvailableUserProfileColumns();
  const optionalSelect = USER_PROFILE_ADDRESS_COLUMNS
    .filter((column) => availableColumns.has(column))
    .map((column) => `u.\`${column}\``);
  const [rows] = await db.query(
    `
    SELECT
      u.id,
      u.name,
      u.email,
      u.phone_number,
      u.role,
      u.role_id,
      r.name AS role_name
      ${optionalSelect.length ? `, ${optionalSelect.join(', ')}` : ''}
    FROM users u
    LEFT JOIN roles r ON r.id = u.role_id
    WHERE u.id = ?
    LIMIT 1
    `,
    [userId]
  );
  return { profile: rows[0] || null, availableColumns };
};

const USER_ASSIGNMENT_COLUMN_CANDIDATES = [
  'assigned_to',
  'owner_id',
  'salesman_id',
  'salesperson_id',
  'user_id',
  'assigned_user_id',
  'created_by_id',
  'updated_by_id',
  'handled_by_id',
];

const EXCLUDED_IMPACT_TABLES = new Set([
  'users',
  'roles',
  'user_visibility_permissions',
  'role_visibility_permissions',
]);

const isSafeIdentifier = (value) => /^[a-zA-Z0-9_]+$/.test(value);

const getUserAssignmentImpact = async (userId) => {
  const [columnRows] = await db.query(
    `
    SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND COLUMN_NAME IN (${USER_ASSIGNMENT_COLUMN_CANDIDATES.map(() => '?').join(', ')})
      AND DATA_TYPE IN ('int', 'bigint', 'mediumint', 'smallint', 'tinyint')
    `,
    USER_ASSIGNMENT_COLUMN_CANDIDATES
  );

  const assignments = [];

  for (const row of columnRows) {
    const tableName = row.TABLE_NAME;
    const columnName = row.COLUMN_NAME;

    if (EXCLUDED_IMPACT_TABLES.has(tableName)) {
      continue;
    }

    if (!isSafeIdentifier(tableName) || !isSafeIdentifier(columnName)) {
      continue;
    }

    const [countRows] = await db.query(
      `SELECT COUNT(*) AS count FROM \`${tableName}\` WHERE \`${columnName}\` = ?`,
      [userId]
    );

    const count = Number(countRows?.[0]?.count || 0);
    if (count > 0) {
      assignments.push({
        table: tableName,
        column: columnName,
        count,
      });
    }
  }

  const totalAssignments = assignments.reduce((total, item) => total + item.count, 0);

  return {
    totalAssignments,
    assignments,
    canDirectDelete: totalAssignments === 0,
  };
};

const reassignUserAssignments = async (connection, fromUserId, toUserId) => {
  const [columnRows] = await connection.query(
    `
    SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND COLUMN_NAME IN (${USER_ASSIGNMENT_COLUMN_CANDIDATES.map(() => '?').join(', ')})
      AND DATA_TYPE IN ('int', 'bigint', 'mediumint', 'smallint', 'tinyint')
    `,
    USER_ASSIGNMENT_COLUMN_CANDIDATES
  );

  for (const row of columnRows) {
    const tableName = row.TABLE_NAME;
    const columnName = row.COLUMN_NAME;

    if (EXCLUDED_IMPACT_TABLES.has(tableName)) {
      continue;
    }

    if (!isSafeIdentifier(tableName) || !isSafeIdentifier(columnName)) {
      continue;
    }

    await connection.query(
      `UPDATE \`${tableName}\` SET \`${columnName}\` = ? WHERE \`${columnName}\` = ?`,
      [toUserId, fromUserId]
    );
  }
};

/* --------------------------------------------------
   GET ALL USERS
-------------------------------------------------- */
exports.getAllUsers = async (req, res) => {
  try {
    const [users] = await db.query(
      `
      SELECT
        u.id,
        u.name,
        u.email,
        u.phone_number,
        u.role,
        u.role_id,
        r.name AS role_name
      FROM users u
      LEFT JOIN roles r ON r.id = u.role_id
      ORDER BY u.id DESC
      `
    );

    return res.status(200).json(users);

  } catch (err) {
    console.error('getAllUsers error:', err);
    return res.status(500).json({
      error: 'Failed to fetch users',
      details: err.message
    });
  }
};


/* --------------------------------------------------
   GET USER BY ID
-------------------------------------------------- */
exports.getUserById = async (req, res) => {
  try {
    const userId = req.params.id;

    const [rows] = await db.query(
      `
        SELECT
          u.id,
          u.name,
          u.email,
          u.phone_number,
          u.role,
          u.role_id,
          r.name AS role_name,
          u.shipping_address,
          u.shipping_landmark,
          u.shipping_pincode,
          u.billing_address,
          u.billing_landmark,
          u.billing_pincode
        FROM users u
        LEFT JOIN roles r ON r.id = u.role_id
        WHERE u.id = ?
        LIMIT 1
        `,
        [userId]
      );

    if (!rows.length) {
      return res.status(404).json({
        message: 'User not found'
      });
    }

    return res.status(200).json(rows[0]);

  } catch (err) {
    console.error('getUserById error:', err);
    return res.status(500).json({
      error: 'Failed to fetch user',
      details: err.message
    });
  }
};


/* --------------------------------------------------
   UPDATE USER
-------------------------------------------------- */
exports.updateUser = async (req, res) => {
  try {
    const userId = Number(req.params.id);
    const { name, email, phone_number, roleId } = req.body;
    const normalizedPhone = String(phone_number || '').trim() || null;

    if (!Number.isInteger(userId)) {
      return res.status(400).json({ error: 'Invalid user id' });
    }

    const [targetUserRows] = await db.query(
      `
      SELECT u.id, u.role_id, COALESCE(r.name, u.role) AS role_name
      FROM users u
      LEFT JOIN roles r ON r.id = u.role_id
      WHERE u.id = ?
      LIMIT 1
      `,
      [userId]
    );

    if (!targetUserRows.length) {
      return res.status(404).json({ message: 'User not found' });
    }

    const targetUser = targetUserRows[0];
    const isTargetAdmin = String(targetUser.role_name || '').toLowerCase() === 'admin';

    if (isTargetAdmin && roleId && Number(roleId) !== Number(targetUser.role_id)) {
      return res.status(403).json({ error: 'Admin role cannot be changed' });
    }

    let finalRoleId = roleId || null;
    let finalRoleName = targetUser.role_name || 'user';

    if (finalRoleId) {
      const [roleRows] = await db.query(
        `SELECT id, name FROM roles WHERE id = ? LIMIT 1`,
        [finalRoleId]
      );

      if (!roleRows.length) {
        return res.status(400).json({ error: 'Invalid role selected' });
      }

      finalRoleId = roleRows[0].id;
      finalRoleName = roleRows[0].name || finalRoleName;
    }

    if (normalizedPhone) {
      const [existingPhoneRows] = await db.query(
        `SELECT id FROM users WHERE phone_number = ? AND id <> ? LIMIT 1`,
        [normalizedPhone, userId]
      );

      if (existingPhoneRows.length) {
        return res.status(400).json({ error: 'Phone number is already used by another user' });
      }
    }

    const [result] = await db.query(
      `
      UPDATE users
      SET name = ?, email = ?, phone_number = ?, role = ?, role_id = ?
      WHERE id = ?
      `,
      [name, email, normalizedPhone, finalRoleName, finalRoleId, userId]
    );

    if (!result.affectedRows) {
      return res.status(404).json({
        message: 'User not found'
      });
    }

    return res.status(200).json({
      message: 'User updated successfully',
      userId
    });

  } catch (err) {
    console.error('updateUser error:', err);
    if (err?.code === 'ER_DUP_ENTRY') {
      if (String(err.message || '').includes('email')) {
        return res.status(400).json({ error: 'Email is already used by another user' });
      }
      if (String(err.message || '').includes('phone_number') || String(err.message || '').includes('uniq_users_phone_number')) {
        return res.status(400).json({ error: 'Phone number is already used by another user' });
      }
      return res.status(400).json({ error: 'Duplicate user details found' });
    }
    return res.status(500).json({
      error: 'Failed to update user',
      details: err.message
    });
  }
};

exports.getMyProfile = async (req, res) => {
  try {
    const userId = getAuthenticatedUserId(req);

    if (!Number.isInteger(userId) || userId <= 0) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { profile } = await loadUserProfileRecord(userId);

    if (!profile) {
      return res.status(404).json({ error: 'User not found' });
    }

    // attempt to fetch a matching customer record by email to prefill profile
    try {
      if (profile.email) {
        const [custRows] = await db.query(
          `SELECT id, name, email, phone, address, landmark, city, state, pincode FROM customers WHERE email = ? LIMIT 1`,
          [profile.email]
        );
        if (custRows && custRows[0]) {
          profile.customer = custRows[0];
          // prefer customer fields for shipping/billing when available
          profile.shipping_address = profile.shipping_address || custRows[0].address || null;
          profile.shipping_landmark = profile.shipping_landmark || custRows[0].landmark || null;
          profile.shipping_pincode = profile.shipping_pincode || custRows[0].pincode || null;
          profile.phone_number = profile.phone_number || custRows[0].phone || null;
        }
      }
    } catch (e) {
      console.error('getMyProfile: customer lookup error', e && e.message ? e.message : e);
    }

    return res.status(200).json(profile);
  } catch (err) {
    console.error('getMyProfile error:', err);
    return res.status(500).json({ error: 'Failed to fetch profile', details: err.message });
  }
};

exports.updateMyProfile = async (req, res) => {
  try {
    const userId = getAuthenticatedUserId(req);
    const {
      name,
      email,
      phone_number,
      // support single-address payload keys: address, landmark, pincode
      address,
      landmark,
      pincode,
      // legacy detailed keys (kept for backward compatibility)
      shipping_address,
      shipping_landmark,
      shipping_pincode,
      billing_address,
      billing_landmark,
      billing_pincode,
    } = req.body || {};
    if (!Number.isInteger(userId) || userId <= 0) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const [existingRows] = await db.query(
      `SELECT id, name, email, phone_number FROM users WHERE id = ? LIMIT 1`,
      [userId]
    );

    if (!existingRows.length) {
      return res.status(404).json({ error: 'User not found' });
    }

    const existing = existingRows[0] || {};

    const finalName = (typeof name !== 'undefined' && name !== null) ? String(name).trim() : existing.name;
    const finalEmail = (typeof email !== 'undefined' && email !== null) ? String(email).trim() : existing.email;
    const finalPhone = (typeof phone_number !== 'undefined' && phone_number !== null) ? String(phone_number).trim() || null : existing.phone_number;

    // Validate email uniqueness only if changed
    if (finalEmail && finalEmail !== existing.email) {
      const [existingEmailRows] = await db.query(
        `SELECT id FROM users WHERE email = ? AND id <> ? LIMIT 1`,
        [finalEmail, userId]
      );
      if (existingEmailRows.length) {
        return res.status(400).json({ error: 'Email is already used by another user' });
      }
    }

    // Validate phone uniqueness only if provided and changed
    if (finalPhone && finalPhone !== existing.phone_number) {
      const [existingPhoneRows] = await db.query(
        `SELECT id FROM users WHERE phone_number = ? AND id <> ? LIMIT 1`,
        [finalPhone, userId]
      );
      if (existingPhoneRows.length) {
        return res.status(400).json({ error: 'Phone number is already used by another user' });
      }
    }

    const availableColumns = await getAvailableUserProfileColumns();
    const addressValues = {
      shipping_address: typeof address !== 'undefined' ? address : shipping_address,
      shipping_landmark: typeof landmark !== 'undefined' ? landmark : shipping_landmark,
      shipping_pincode: typeof pincode !== 'undefined' ? pincode : shipping_pincode,
      billing_address: typeof address !== 'undefined' ? address : billing_address,
      billing_landmark: typeof landmark !== 'undefined' ? landmark : billing_landmark,
      billing_pincode: typeof pincode !== 'undefined' ? pincode : billing_pincode,
    };
    const setClauses = ['name = ?', 'email = ?', 'phone_number = ?'];
    const values = [finalName, finalEmail, finalPhone];
    USER_PROFILE_ADDRESS_COLUMNS.forEach((column) => {
      if (availableColumns.has(column) && typeof addressValues[column] !== 'undefined') {
        const value = addressValues[column];
        setClauses.push(`\`${column}\` = ?`);
        values.push(value === null || value === '' ? null : String(value).trim());
      }
    });
    values.push(userId);
    const [result] = await db.query(
      `UPDATE users SET ${setClauses.join(', ')} WHERE id = ?`,
      values
    );

    if (!result.affectedRows) {
      return res.status(404).json({ error: 'User not found' });
    }

    const { profile } = await loadUserProfileRecord(userId);

    return res.status(200).json({
      message: 'Profile updated successfully',
      user: profile,
    });
  } catch (err) {
    console.error('updateMyProfile error:', err);
    if (err?.code === 'ER_DUP_ENTRY') {
      if (String(err.message || '').includes('email')) {
        return res.status(400).json({ error: 'Email is already used by another user' });
      }
      if (String(err.message || '').includes('phone_number') || String(err.message || '').includes('uniq_users_phone_number')) {
        return res.status(400).json({ error: 'Phone number is already used by another user' });
      }
      return res.status(400).json({ error: 'Duplicate user details found' });
    }
    return res.status(500).json({ error: 'Failed to update profile', details: err.message });
  }
};

exports.changeMyPassword = async (req, res) => {
  try {
    const userId = getAuthenticatedUserId(req);
    const { currentPassword, newPassword } = req.body || {};
    if (!Number.isInteger(userId) || userId <= 0 || !currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Current password and new password are required' });
    }
    if (String(newPassword).length < 8) {
      return res.status(400).json({ error: 'New password must be at least 8 characters' });
    }
    const [rows] = await db.query('SELECT password FROM users WHERE id = ? LIMIT 1', [userId]);
    if (!rows.length || !(await bcrypt.compare(String(currentPassword), rows[0].password))) {
      return res.status(400).json({ error: 'Current password is incorrect' });
    }
    await db.query('UPDATE users SET password = ?, reset_token = NULL, reset_token_expiry = NULL WHERE id = ?', [await bcrypt.hash(String(newPassword), 10), userId]);
    return res.status(200).json({ message: 'Password updated successfully' });
  } catch (err) {
    console.error('changeMyPassword error:', err);
    return res.status(500).json({ error: 'Failed to update password' });
  }
};


/* --------------------------------------------------
   DELETE USER
-------------------------------------------------- */
exports.deleteUser = async (req, res) => {
  try {
    const userId = Number(req.params.id);

    if (!Number.isInteger(userId)) {
      return res.status(400).json({ error: 'Invalid user id' });
    }

    if (req.user?.role !== 'admin') {
      return res.status(403).json({ error: 'Only admins can delete users' });
    }

    if (Number(req.user?.id) === userId) {
      return res.status(400).json({ error: 'You cannot delete your own account' });
    }

    const [users] = await db.query(
      `SELECT id, name, email FROM users WHERE id = ? LIMIT 1`,
      [userId]
    );

    if (!users.length) {
      return res.status(404).json({ message: 'User not found' });
    }

    const impact = await getUserAssignmentImpact(userId);
    if (impact.totalAssignments > 0) {
      return res.status(409).json({
        error: 'User has linked records. Reassign before delete.',
        impact,
      });
    }

    const [result] = await db.query(
      `DELETE FROM users WHERE id = ?`,
      [userId]
    );

    if (!result.affectedRows) {
      return res.status(404).json({
        message: 'User not found'
      });
    }

    return res.status(200).json({
      message: 'User deleted successfully',
      userId
    });

  } catch (err) {
    console.error('deleteUser error:', err);
    return res.status(500).json({
      error: 'Failed to delete user',
      details: err.message
    });
  }
};

exports.getUserDeleteImpact = async (req, res) => {
  try {
    const userId = Number(req.params.id);

    if (!Number.isInteger(userId)) {
      return res.status(400).json({ error: 'Invalid user id' });
    }

    if (req.user?.role !== 'admin') {
      return res.status(403).json({ error: 'Only admins can view delete impact' });
    }

    const [users] = await db.query(
      `SELECT id, name, email FROM users WHERE id = ? LIMIT 1`,
      [userId]
    );

    if (!users.length) {
      return res.status(404).json({ message: 'User not found' });
    }

    const impact = await getUserAssignmentImpact(userId);
    return res.status(200).json({
      user: users[0],
      impact,
    });
  } catch (err) {
    console.error('getUserDeleteImpact error:', err);
    return res.status(500).json({
      error: 'Failed to fetch user delete impact',
      details: err.message,
    });
  }
};

exports.deleteUserWithReassignment = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const userId = Number(req.params.id);
    const reassignToUserId = Number(req.body?.reassignToUserId);

    if (!Number.isInteger(userId) || !Number.isInteger(reassignToUserId)) {
      return res.status(400).json({ error: 'Valid userId and reassignToUserId are required' });
    }

    if (req.user?.role !== 'admin') {
      return res.status(403).json({ error: 'Only admins can delete users' });
    }

    if (Number(req.user?.id) === userId) {
      return res.status(400).json({ error: 'You cannot delete your own account' });
    }

    if (userId === reassignToUserId) {
      return res.status(400).json({ error: 'Reassignment user must be different' });
    }

    const [sourceUsers] = await connection.query(
      `SELECT id, name, email FROM users WHERE id = ? LIMIT 1`,
      [userId]
    );

    if (!sourceUsers.length) {
      return res.status(404).json({ message: 'User not found' });
    }

    const [targetUsers] = await connection.query(
      `SELECT id, name, email FROM users WHERE id = ? LIMIT 1`,
      [reassignToUserId]
    );

    if (!targetUsers.length) {
      return res.status(400).json({ error: 'Reassignment user not found' });
    }

    const impact = await getUserAssignmentImpact(userId);

    await connection.beginTransaction();
    await reassignUserAssignments(connection, userId, reassignToUserId);
    await connection.query(`DELETE FROM users WHERE id = ?`, [userId]);
    await connection.commit();

    return res.status(200).json({
      message: 'User reassigned and deleted successfully',
      deletedUserId: userId,
      reassignedToUserId: reassignToUserId,
      reassignedRecords: impact.totalAssignments,
    });
  } catch (err) {
    await connection.rollback();
    console.error('deleteUserWithReassignment error:', err);
    return res.status(500).json({
      error: 'Failed to delete user with reassignment',
      details: err.message,
    });
  } finally {
    connection.release();
  }
};


/* --------------------------------------------------
   GET USER VISIBILITY PERMISSIONS
-------------------------------------------------- */
exports.getUserVisibilityPermissions = async (req, res) => {
  try {
    await ensureVendorSchema(db);
    const userId = Number(req.params.id);

    if (!Number.isInteger(userId)) {
      return res.status(400).json({ error: 'Invalid user id' });
    }

    if (!isAuthenticatedAdmin(req) && getAuthenticatedUserId(req) !== userId) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const [rows] = await db.query(
      `SELECT * FROM user_visibility_permissions WHERE user_id = ? LIMIT 1`,
      [userId]
    );

    if (!rows.length) {
      return res.status(200).json({
        userId,
        permissions: getDefaultVisibilityPermissions(),
        source: 'default'
      });
    }

    const permissions = mapPermissionRowToObject(rows[0]);

    return res.status(200).json({
      userId,
      permissions,
      source: 'db'
    });
  } catch (err) {
    console.error('getUserVisibilityPermissions error:', err);
    return res.status(500).json({
      error: 'Failed to fetch visibility permissions',
      details: err.message
    });
  }
};


/* --------------------------------------------------
   UPSERT USER VISIBILITY PERMISSIONS
-------------------------------------------------- */
exports.upsertUserVisibilityPermissions = async (req, res) => {
  try {
    await ensureVendorSchema(db);
    const userId = Number(req.params.id);
    const { permissions } = req.body || {};

    if (!Number.isInteger(userId)) {
      return res.status(400).json({ error: 'Invalid user id' });
    }

    if (!isAuthenticatedAdmin(req) && getAuthenticatedUserId(req) !== userId) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    if (!permissions || typeof permissions !== 'object') {
      return res.status(400).json({ error: 'permissions object is required' });
    }

    const [userRows] = await db.query(
      `SELECT id FROM users WHERE id = ? LIMIT 1`,
      [userId]
    );

    if (!userRows.length) {
      return res.status(404).json({ message: 'User not found' });
    }

    // Fetch global settings to check business_type
    const [settingsRows] = await db.query(
      `SELECT business_type FROM settings WHERE id = 1 LIMIT 1`
    );
    const businessType = settingsRows?.[0]?.business_type || 'GENERAL';
    const isCateringBusiness = ['CATERING', 'HYBRID'].includes(String(businessType || '').toUpperCase());

    const normalized = VISIBILITY_MODULE_KEYS.reduce((acc, key) => {
      let value = Object.prototype.hasOwnProperty.call(permissions, key)
        ? permissions[key]
        : true;

      // Force catering modules to 0 if not CATERING business
      if (['kots', 'deliveries'].includes(key) && !isCateringBusiness) {
        value = 0;
      }

      acc[key] = value ? 1 : 0;
      return acc;
    }, {});

    await db.query(
      `
      INSERT INTO user_visibility_permissions (
        user_id, dashboard, leads, quotations, work_orders,
        kots, deliveries, invoices, payment_reminders, payments,
        products, vendors, passbook, settings, reports, users
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        dashboard = VALUES(dashboard),
        leads = VALUES(leads),
        quotations = VALUES(quotations),
        work_orders = VALUES(work_orders),
        kots = VALUES(kots),
        deliveries = VALUES(deliveries),
        invoices = VALUES(invoices),
        payment_reminders = VALUES(payment_reminders),
        payments = VALUES(payments),
        products = VALUES(products),
        vendors = VALUES(vendors),
        passbook = VALUES(passbook),
        settings = VALUES(settings),
        reports = VALUES(reports),
        users = VALUES(users),
        updated_at = CURRENT_TIMESTAMP
      `,
      [
        userId,
        normalized.dashboard,
        normalized.leads,
        normalized.quotations,
        normalized.work_orders,
        normalized.kots,
        normalized.deliveries,
        normalized.invoices,
        normalized.payment_reminders,
        normalized.payments,
        normalized.products,
        normalized.vendors,
        normalized.passbook,
        normalized.settings,
        normalized.reports,
        normalized.users,
      ]
    );

    return res.status(200).json({
      message: 'Visibility permissions saved successfully',
      userId,
      permissions: VISIBILITY_MODULE_KEYS.reduce((acc, key) => {
        acc[key] = Boolean(normalized[key]);
        return acc;
      }, {})
    });
  } catch (err) {
    console.error('upsertUserVisibilityPermissions error:', err);
    return res.status(500).json({
      error: 'Failed to save visibility permissions',
      details: err.message
    });
  }
};


/* --------------------------------------------------
  GET EFFECTIVE USER VISIBILITY PERMISSIONS
  Priority: user permissions > default-all
-------------------------------------------------- */
exports.getUserEffectiveVisibilityPermissions = async (req, res) => {
  try {
    await ensureVendorSchema(db);
    const userId = Number(req.params.id);

    if (!Number.isInteger(userId)) {
      return res.status(400).json({ error: 'Invalid user id' });
    }

    if (!isAuthenticatedAdmin(req) && getAuthenticatedUserId(req) !== userId) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const [userRows] = await db.query(
      `SELECT id FROM users WHERE id = ? LIMIT 1`,
      [userId]
    );

    if (!userRows.length) {
      return res.status(404).json({ message: 'User not found' });
    }

    const [userPermissionRows] = await db.query(
      `SELECT * FROM user_visibility_permissions WHERE user_id = ? LIMIT 1`,
      [userId]
    );

    if (userPermissionRows.length) {
      return res.status(200).json({
        userId,
        permissions: mapPermissionRowToObject(userPermissionRows[0]),
        source: 'user'
      });
    }

    return res.status(200).json({
      userId,
      permissions: getDefaultVisibilityPermissions(),
      source: 'default'
    });
  } catch (err) {
    console.error('getUserEffectiveVisibilityPermissions error:', err);
    return res.status(500).json({
      error: 'Failed to fetch effective permissions',
      details: err.message
    });
  }
};
