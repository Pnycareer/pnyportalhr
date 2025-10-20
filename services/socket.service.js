const { Server } = require("socket.io");
const jwt = require("jsonwebtoken");
const cookie = require("cookie");

let ioInstance = null;

function buildCorsValidator(allowlist = []) {
  const allowed = new Set(allowlist);
  return function validateOrigin(origin, callback) {
    if (!origin) return callback(null, true);
    if (allowed.has(origin)) return callback(null, true);
    return callback(new Error("Not allowed by CORS"));
  };
}

function initSocket(httpServer, allowlist = []) {
  if (!httpServer) {
    throw new Error("HTTP server instance is required to initialise Socket.IO");
  }

  const io = new Server(httpServer, {
    cors: {
      origin: buildCorsValidator(allowlist),
      credentials: true,
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    },
  });

  io.use((socket, next) => {
    try {
      const header = socket.request.headers?.cookie || "";
      const parsed = header ? cookie.parse(header) : {};
      const token = parsed.token;
      if (!token) {
        return next(new Error("Unauthorized"));
      }
      const payload = jwt.verify(token, process.env.JWT_SECRET);
      socket.user = payload;
      return next();
    } catch (error) {
      return next(new Error("Unauthorized"));
    }
  });

  io.on("connection", (socket) => {
    const user = socket.user || {};
    const userId = user.id ? String(user.id) : null;

    if (userId) {
      socket.join(userId);
    }
    if (user.role) {
      socket.join(`role:${user.role}`);
    }
    if (user.isTeamLead) {
      socket.join("team-leads");
    }

    socket.on("disconnect", () => {
      // no-op: useful for logging if needed
    });
  });

  ioInstance = io;
  return io;
}

function getIO() {
  if (!ioInstance) {
    throw new Error("Socket.IO has not been initialised");
  }
  return ioInstance;
}

function emitToUser(userId, event, payload) {
  if (!ioInstance || !userId) return;
  ioInstance.to(String(userId)).emit(event, payload);
}

function emitToRole(role, event, payload) {
  if (!ioInstance || !role) return;
  ioInstance.to(`role:${role}`).emit(event, payload);
}

module.exports = {
  initSocket,
  getIO,
  emitToUser,
  emitToRole,
};
