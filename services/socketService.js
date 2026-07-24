const jwt = require("jsonwebtoken");
let io = null;

const init = (server, options = {}) => {
  if (io) return io;
  const { Server } = require("socket.io");

  const allowed =
    options.allowedOrigins === undefined ? true : options.allowedOrigins;

  const corsOrigin = (origin, callback) => {
    try {
      console.log("Socket CORS origin check:", origin);
      if (!origin) return callback(null, true);
      if (allowed === true) return callback(null, true);
      if (Array.isArray(allowed) && allowed.includes(origin))
        return callback(null, true);
      if (typeof allowed === "string" && allowed === origin)
        return callback(null, true);
      console.warn("Socket CORS blocked origin:", origin);
      return callback(new Error("Origin not allowed"), false);
    } catch (e) {
      console.error(
        "Error in corsOrigin check:",
        e && e.message ? e.message : e,
      );
      return callback(null, false);
    }
  };

  io = new Server(server, {
    cors: {
      origin: corsOrigin,
      credentials: true,
    },
  });

  // Log low-level engine connection errors to help diagnose failed handshakes/upgrades
  if (io.engine && typeof io.engine.on === "function") {
    io.engine.on("connection_error", (err) => {
      console.error(
        "Socket engine connection_error:",
        err && err.message ? err.message : err,
      );
    });
  }

  // Log low-level engine connections to capture transport, headers and remote address
  try {
    if (io.engine && typeof io.engine.on === "function") {
      io.engine.on("connection", (engineSocket) => {
        try {
          const req = engineSocket.request || {};
          const ip =
            req.socket && req.socket.remoteAddress
              ? req.socket.remoteAddress
              : null;
          console.log("Socket engine connection:", {
            transport:
              engineSocket.transport && engineSocket.transport.name
                ? engineSocket.transport.name
                : null,
            url: req.url,
            ip,
            origin:
              req.headers && req.headers.origin ? req.headers.origin : null,
          });
        } catch (e) {
          console.error(
            "Error logging engine connection:",
            e && e.message ? e.message : e,
          );
        }

        engineSocket.on("error", (err) => {
          console.error(
            "Engine socket error:",
            err && err.message ? err.message : err,
          );
        });

        engineSocket.on("close", (reason) => {
          console.log("Engine socket closed:", reason);
        });
      });
    }
  } catch (e) {
    console.warn(
      "Failed to attach engine connection logger:",
      e && e.message ? e.message : e,
    );
  }
  io.on("connection", (socket) => {
    // Support auth via handshake (recommended) or via explicit 'authenticate' event.
    const handshakeToken =
      socket.handshake?.auth?.token || socket.handshake?.query?.token;
    if (handshakeToken) {
      try {
        const decoded = jwt.verify(handshakeToken, process.env.JWT_SECRET);
        const userId = decoded && decoded.id ? decoded.id : null;
        if (userId) {
          socket.join(`user:${userId}`);
          socket.userId = userId;
          socket.emit("authenticated", { ok: true, userId });
          console.log("Socket authenticated (handshake)", {
            socketId: socket.id,
            userId,
          });
        } else {
          socket.emit("unauthorized", { error: "Invalid token payload" });
        }
      } catch (err) {
        socket.emit("unauthorized", { error: "Invalid token" });
      }
    }

    socket.on("authenticate", (token) => {
      if (!token)
        return socket.emit("unauthorized", { error: "No token provided" });
      try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const userId = decoded && decoded.id ? decoded.id : null;
        if (userId) {
          socket.join(`user:${userId}`);
          socket.userId = userId;
          socket.emit("authenticated", { ok: true, userId });
          console.log("Socket authenticated (event)", {
            socketId: socket.id,
            userId,
          });
        } else {
          socket.emit("unauthorized", { error: "Invalid token payload" });
        }
      } catch (err) {
        socket.emit("unauthorized", { error: "Invalid token" });
      }
    });

    socket.on("subscribe_notifications", (data) => {
      const userId = socket.userId || (data && data.userId);
      if (userId) {
        socket.join(`user:${userId}`);
        console.log("Socket subscribed to notifications", {
          socketId: socket.id,
          userId,
        });
      }
    });

    socket.on("disconnect", () => {
      console.log("Socket disconnected", {
        socketId: socket.id,
        userId: socket.userId || null,
      });
    });
  });

  return io;
};

const getIO = () => io;

const emitNotification = (userId, payload) => {
  if (!io || !userId) {
    console.warn("socketService.emitNotification skipped: no io or userId", {
      hasIo: Boolean(io),
      userId,
    });
    return;
  }
  try {
    io.to(`user:${userId}`).emit("notification", payload);
    console.log("socketService.emitNotification -> emitted", {
      userId,
      payload,
    });
  } catch (e) {
    console.error(
      "socketService.emitNotification error:",
      e && e.message ? e.message : e,
    );
  }
};

module.exports = {
  init,
  getIO,
  emitNotification,
};
