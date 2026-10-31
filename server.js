"use strict";

const crypto = require("node:crypto");
const http = require("node:http");
const path = require("node:path");
const express = require("express");
const helmet = require("helmet");
const cookieParser = require("cookie-parser");
const { parse: parseCookie } = require("cookie");
const { Pool } = require("pg");
const bcrypt = require("bcryptjs");
const rateLimit = require("express-rate-limit");
const { Server } = require("socket.io");

const PORT = Number(process.env.PORT || 10000);
const COOKIE_NAME = "sandbox_session";
const SESSION_DAYS = 30;
const isProduction = process.env.NODE_ENV === "production" || Boolean(process.env.RENDER);
const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000
    })
  : null;

let dbReady = false;
const onlineUsers = new Map();
const pendingCalls = new Map();
const activeCalls = new Map();

const app = express();
app.set("trust proxy", 1);
app.disable("x-powered-by");
app.use(helmet({
  crossOriginEmbedderPolicy: false,
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'"],
      imgSrc: ["'self'", "data:", "blob:"],
      mediaSrc: ["'self'", "blob:"],
      connectSrc: ["'self'", "ws:", "wss:"],
      fontSrc: ["'self'", "data:"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      frameAncestors: ["'none'"]
    }
  }
}));
app.use(express.json({ limit: "16kb" }));
app.use(cookieParser());

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 12,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Too many sign-in attempts. Please try again later." }
});

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function validUuid(value) {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function setSessionCookie(res, token) {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure: isProduction,
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_DAYS * 24 * 60 * 60 * 1000
  });
}

function clearSessionCookie(res) {
  res.clearCookie(COOKIE_NAME, {
    httpOnly: true,
    secure: isProduction,
    sameSite: "lax",
    path: "/"
  });
}

function requireDatabase(req, res, next) {
  if (!pool || !dbReady) {
    return res.status(503).json({
      error: "The database is not configured or is temporarily unavailable.",
      code: "DATABASE_UNAVAILABLE"
    });
  }
  next();
}

function sameOrigin(req, res, next) {
  const origin = req.get("origin");
  if (origin) {
    try {
      if (new URL(origin).host !== req.get("host")) {
        return res.status(403).json({ error: "Cross-origin request rejected." });
      }
    } catch (_error) {
      return res.status(403).json({ error: "Invalid request origin." });
    }
  }
  next();
}

async function requireAuth(req, res, next) {
  if (!pool || !dbReady) {
    return res.status(503).json({ error: "Database unavailable.", code: "DATABASE_UNAVAILABLE" });
  }
  const token = req.cookies[COOKIE_NAME];
  if (!token || typeof token !== "string") {
    return res.status(401).json({ error: "Please sign in.", code: "AUTH_REQUIRED" });
  }
  try {
    const result = await pool.query(
      "SELECT u.id, u.username, s.id AS session_id FROM sandbox_sessions s JOIN sandbox_users u ON u.id = s.user_id WHERE s.token_hash = $1 AND s.expires_at > NOW()",
      [sha256(token)]
    );
    if (!result.rowCount) {
      clearSessionCookie(res);
      return res.status(401).json({ error: "Your session has expired. Please sign in again.", code: "AUTH_REQUIRED" });
    }
    req.user = result.rows[0];
    pool.query("UPDATE sandbox_sessions SET last_seen_at = NOW() WHERE id = $1", [req.user.session_id]).catch(() => {});
    next();
  } catch (error) {
    console.error("Authentication lookup failed:", error.message);
    res.status(503).json({ error: "Authentication is temporarily unavailable." });
  }
}

async function createSession(userId, res) {
  const token = crypto.randomBytes(32).toString("base64url");
  const id = crypto.randomUUID();
  await pool.query(
    "INSERT INTO sandbox_sessions (id, user_id, token_hash, expires_at) VALUES ($1, $2, $3, NOW() + INTERVAL '30 days')",
    [id, userId, sha256(token)]
  );
  setSessionCookie(res, token);
}

async function migrateDatabase() {
  await pool.query(
    "CREATE TABLE IF NOT EXISTS sandbox_users (" +
    "id UUID PRIMARY KEY, " +
    "username VARCHAR(24) NOT NULL, " +
    "password_hash TEXT NOT NULL, " +
    "created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()" +
    "); " +
    "CREATE UNIQUE INDEX IF NOT EXISTS sandbox_users_username_ci_unique ON sandbox_users (LOWER(username)); " +
    "CREATE TABLE IF NOT EXISTS sandbox_sessions (" +
    "id UUID PRIMARY KEY, " +
    "user_id UUID NOT NULL REFERENCES sandbox_users(id) ON DELETE CASCADE, " +
    "token_hash CHAR(64) NOT NULL UNIQUE, " +
    "created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), " +
    "last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), " +
    "expires_at TIMESTAMPTZ NOT NULL" +
    "); " +
    "CREATE INDEX IF NOT EXISTS sandbox_sessions_user_id_idx ON sandbox_sessions(user_id); " +
    "CREATE INDEX IF NOT EXISTS sandbox_sessions_expiry_idx ON sandbox_sessions(expires_at); " +
    "CREATE TABLE IF NOT EXISTS sandbox_friend_requests (" +
    "id UUID PRIMARY KEY, " +
    "requester_id UUID NOT NULL REFERENCES sandbox_users(id) ON DELETE CASCADE, " +
    "recipient_id UUID NOT NULL REFERENCES sandbox_users(id) ON DELETE CASCADE, " +
    "status VARCHAR(12) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined')), " +
    "created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), " +
    "updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), " +
    "CHECK (requester_id <> recipient_id)" +
    "); " +
    "CREATE INDEX IF NOT EXISTS sandbox_friend_requests_requester_idx ON sandbox_friend_requests(requester_id, status); " +
    "CREATE INDEX IF NOT EXISTS sandbox_friend_requests_recipient_idx ON sandbox_friend_requests(recipient_id, status);"
  );
}

function online(userId) {
  const sockets = onlineUsers.get(userId);
  return Boolean(sockets && sockets.size);
}

async function broadcastPresence(userId, isOnline) {
  if (!pool || !dbReady) return;
  try {
    const result = await pool.query(
      "SELECT CASE WHEN requester_id = $1 THEN recipient_id ELSE requester_id END AS friend_id " +
      "FROM sandbox_friend_requests WHERE status = 'accepted' AND (requester_id = $1 OR recipient_id = $1)",
      [userId]
    );
    for (const row of result.rows) {
      io.to("user:" + row.friend_id).emit("presence:update", {
        userId,
        online: isOnline
      });
    }
  } catch (error) {
    console.error("Presence broadcast failed:", error.message);
  }
}

const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 1e6,
  pingInterval: 25000,
  pingTimeout: 20000
});

app.use("/api", sameOrigin);
app.get("/api/health", (_req, res) => {
  res.status(200).json({
    status: dbReady ? "ok" : "needs-database",
    database: dbReady ? "connected" : "not-configured-or-unavailable"
  });
});

app.get("/api/config", (_req, res) => {
  const iceServers = [{ urls: ["stun:stun.l.google.com:19302"] }];
  const turnUrls = String(process.env.TURN_URLS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (turnUrls.length && process.env.TURN_SHARED_SECRET) {
    const expiresAt = Math.floor(Date.now() / 1000) + 3600;
    const username = expiresAt + ":" + crypto.randomUUID();
    const credential = crypto.createHmac("sha1", process.env.TURN_SHARED_SECRET)
      .update(username)
      .digest("base64");
    iceServers.push({ urls: turnUrls, username, credential });
  }
  res.json({ rtcConfiguration: { iceServers, iceCandidatePoolSize: 4 } });
});

app.post("/api/auth/register", authLimiter, requireDatabase, async (req, res) => {
  const username = String(req.body && req.body.username || "").trim();
  const password = String(req.body && req.body.password || "");
  if (!/^[A-Za-z0-9_]{3,24}$/.test(username)) {
    return res.status(400).json({ error: "Username must be 3–24 characters using letters, numbers, or underscores." });
  }
  if (password.length < 10 || Buffer.byteLength(password, "utf8") > 72) {
    return res.status(400).json({ error: "Password must be at least 10 characters and no more than 72 UTF-8 bytes." });
  }
  try {
    const passwordHash = await bcrypt.hash(password, 12);
    const userId = crypto.randomUUID();
    const result = await pool.query(
      "INSERT INTO sandbox_users (id, username, password_hash) VALUES ($1, $2, $3) RETURNING id, username, created_at",
      [userId, username, passwordHash]
    );
    await createSession(userId, res);
    res.status(201).json({ user: result.rows[0] });
  } catch (error) {
    if (error.code === "23505") {
      return res.status(409).json({ error: "That username is already taken." });
    }
    console.error("Registration failed:", error.message);
    res.status(500).json({ error: "Could not create the account." });
  }
});

app.post("/api/auth/login", authLimiter, requireDatabase, async (req, res) => {
  const username = String(req.body && req.body.username || "").trim();
  const password = String(req.body && req.body.password || "");
  if (!username || !password) {
    return res.status(400).json({ error: "Enter your username and password." });
  }
  try {
    const result = await pool.query(
      "SELECT id, username, password_hash FROM sandbox_users WHERE LOWER(username) = LOWER($1)",
      [username]
    );
    const user = result.rows[0];
    const matches = user ? await bcrypt.compare(password, user.password_hash) : false;
    if (!matches) {
      return res.status(401).json({ error: "Incorrect username or password." });
    }
    await createSession(user.id, res);
    res.json({ user: { id: user.id, username: user.username } });
  } catch (error) {
    console.error("Login failed:", error.message);
    res.status(500).json({ error: "Could not sign in." });
  }
});

app.post("/api/auth/logout", async (req, res) => {
  const token = req.cookies[COOKIE_NAME];
  if (pool && token) {
    pool.query("DELETE FROM sandbox_sessions WHERE token_hash = $1", [sha256(token)]).catch(() => {});
  }
  clearSessionCookie(res);
  res.status(204).end();
});

app.get("/api/me", requireAuth, (req, res) => {
  res.json({ user: { id: req.user.id, username: req.user.username } });
});

app.get("/api/sandbox_users/search", requireAuth, async (req, res) => {
  const query = String(req.query.q || "").trim();
  if (query.length < 2 || query.length > 24) {
    return res.json({ sandbox_users: [] });
  }
  try {
    const result = await pool.query(
      "SELECT u.id, u.username FROM sandbox_users u " +
      "WHERE u.id <> $1 AND LOWER(u.username) LIKE LOWER($2) " +
      "AND NOT EXISTS (SELECT 1 FROM sandbox_friend_requests fr WHERE fr.status = 'accepted' " +
      "AND ((fr.requester_id = $1 AND fr.recipient_id = u.id) " +
      "OR (fr.requester_id = u.id AND fr.recipient_id = $1))) " +
      "ORDER BY LOWER(u.username) LIMIT 20",
      [req.user.id, "%" + query.replace(/[%_]/g, "\\$&") + "%"]
    );
    res.json({ sandbox_users: result.rows.map((user) => ({ ...user, online: online(user.id) })) });
  } catch (error) {
    console.error("User search failed:", error.message);
    res.status(500).json({ error: "Search is temporarily unavailable." });
  }
});

app.get("/api/friends", requireAuth, async (req, res) => {
  try {
    const [friends, requests] = await Promise.all([
      pool.query(
        "SELECT u.id, u.username FROM sandbox_friend_requests fr " +
        "JOIN sandbox_users u ON u.id = CASE WHEN fr.requester_id = $1 THEN fr.recipient_id ELSE fr.requester_id END " +
        "WHERE fr.status = 'accepted' AND (fr.requester_id = $1 OR fr.recipient_id = $1) " +
        "ORDER BY LOWER(u.username)",
        [req.user.id]
      ),
      pool.query(
        "SELECT fr.id, fr.requester_id, fr.recipient_id, fr.created_at, u.username, " +
        "CASE WHEN fr.requester_id = $1 THEN 'outgoing' ELSE 'incoming' END AS direction " +
        "FROM sandbox_friend_requests fr " +
        "JOIN sandbox_users u ON u.id = CASE WHEN fr.requester_id = $1 THEN fr.recipient_id ELSE fr.requester_id END " +
        "WHERE fr.status = 'pending' AND (fr.requester_id = $1 OR fr.recipient_id = $1) " +
        "ORDER BY fr.created_at DESC",
        [req.user.id]
      )
    ]);
    res.json({
      friends: friends.rows.map((friend) => ({ ...friend, online: online(friend.id) })),
      requests: requests.rows
    });
  } catch (error) {
    console.error("Friend list failed:", error.message);
    res.status(500).json({ error: "Could not load friends." });
  }
});

app.post("/api/friends/requests", requireAuth, async (req, res) => {
  const recipientId = req.body && req.body.userId;
  if (!validUuid(recipientId) || recipientId === req.user.id) {
    return res.status(400).json({ error: "Choose a valid player." });
  }
  try {
    const target = await pool.query("SELECT id FROM sandbox_users WHERE id = $1", [recipientId]);
    if (!target.rowCount) return res.status(404).json({ error: "Player not found." });

    const existing = await pool.query(
      "SELECT id, status, requester_id, recipient_id FROM sandbox_friend_requests " +
      "WHERE (requester_id = $1 AND recipient_id = $2) " +
      "OR (requester_id = $2 AND recipient_id = $1) " +
      "ORDER BY created_at DESC LIMIT 1",
      [req.user.id, recipientId]
    );
    if (existing.rowCount) {
      const row = existing.rows[0];
      if (row.status === "accepted") return res.status(409).json({ error: "You are already friends." });
      if (row.status === "pending") return res.status(409).json({ error: "A friend request is already pending." });
    }

    const id = crypto.randomUUID();
    await pool.query(
      "INSERT INTO sandbox_friend_requests (id, requester_id, recipient_id, status) VALUES ($1, $2, $3, 'pending')",
      [id, req.user.id, recipientId]
    );
    io.to("user:" + recipientId).emit("friend:request", {
      requestId: id,
      from: { id: req.user.id, username: req.user.username }
    });
    res.status(201).json({ ok: true, requestId: id });
  } catch (error) {
    console.error("Friend request failed:", error.message);
    res.status(500).json({ error: "Could not send friend request." });
  }
});

app.post("/api/friends/requests/:requestId/respond", requireAuth, async (req, res) => {
  const requestId = req.params.requestId;
  const status = req.body && req.body.status;
  if (!validUuid(requestId) || !["accepted", "declined"].includes(status)) {
    return res.status(400).json({ error: "Invalid friend request action." });
  }
  try {
    const result = await pool.query(
      "UPDATE sandbox_friend_requests SET status = $1, updated_at = NOW() " +
      "WHERE id = $2 AND recipient_id = $3 AND status = 'pending' " +
      "RETURNING requester_id, recipient_id",
      [status, requestId, req.user.id]
    );
    if (!result.rowCount) return res.status(404).json({ error: "Friend request not found." });
    const requesterId = result.rows[0].requester_id;
    io.to("user:" + requesterId).emit("friend:response", { status });
    if (status === "accepted") {
      await broadcastPresence(req.user.id, true);
      await broadcastPresence(requesterId, online(requesterId));
    }
    res.json({ ok: true, status });
  } catch (error) {
    console.error("Friend request response failed:", error.message);
    res.status(500).json({ error: "Could not update friend request." });
  }
});

app.use(express.static(path.join(__dirname, "public"), {
  extensions: ["html"],
  maxAge: isProduction ? "1h" : 0
}));
app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

function emitSocketError(socket, message, code) {
  socket.emit("app:error", { message, code });
}

io.use(async (socket, next) => {
  if (!pool || !dbReady) return next(new Error("DATABASE_UNAVAILABLE"));
  try {
    const cookies = parseCookie(socket.handshake.headers.cookie || "");
    const token = cookies[COOKIE_NAME];
    if (!token) return next(new Error("AUTH_REQUIRED"));
    const result = await pool.query(
      "SELECT u.id, u.username FROM sandbox_sessions s JOIN sandbox_users u ON u.id = s.user_id " +
      "WHERE s.token_hash = $1 AND s.expires_at > NOW()",
      [sha256(token)]
    );
    if (!result.rowCount) return next(new Error("AUTH_REQUIRED"));
    socket.user = result.rows[0];
    next();
  } catch (_error) {
    next(new Error("AUTH_UNAVAILABLE"));
  }
});

async function isFriend(userA, userB) {
  const result = await pool.query(
    "SELECT 1 FROM sandbox_friend_requests WHERE status = 'accepted' " +
    "AND ((requester_id = $1 AND recipient_id = $2) " +
    "OR (requester_id = $2 AND recipient_id = $1)) LIMIT 1",
    [userA, userB]
  );
  return result.rowCount > 0;
}

function getPublicUser(userId) {
  return pool.query("SELECT id, username FROM sandbox_users WHERE id = $1", [userId])
    .then((result) => result.rows[0] || null);
}

function endCall(callId, actorId, reason) {
  const call = activeCalls.get(callId);
  if (!call || !call.participants.includes(actorId)) return false;
  activeCalls.delete(callId);
  for (const participantId of call.participants) {
    io.to("user:" + participantId).emit("call:ended", {
      callId,
      byUserId: actorId,
      reason: reason || "ended"
    });
  }
  return true;
}

io.on("connection", (socket) => {
  const userId = socket.user.id;
  socket.join("user:" + userId);
  let userSockets = onlineUsers.get(userId);
  const wasOffline = !userSockets || userSockets.size === 0;
  if (!userSockets) {
    userSockets = new Set();
    onlineUsers.set(userId, userSockets);
  }
  userSockets.add(socket.id);
  if (wasOffline) broadcastPresence(userId, true).catch(() => {});
  socket.emit("session:ready", { user: socket.user });

  socket.on("call:invite", async (payload) => {
    const targetId = payload && payload.targetUserId;
    const video = Boolean(payload && payload.video);
    if (!validUuid(targetId) || targetId === userId) {
      return emitSocketError(socket, "Choose a valid friend to call.", "INVALID_CALL_TARGET");
    }
    try {
      if (!(await isFriend(userId, targetId))) {
        return emitSocketError(socket, "You can only call accepted friends.", "NOT_FRIENDS");
      }
      if (!online(targetId)) {
        return emitSocketError(socket, "That friend is offline.", "USER_OFFLINE");
      }
      const activeForCaller = Array.from(activeCalls.values()).some((call) => call.participants.includes(userId));
      const activeForTarget = Array.from(activeCalls.values()).some((call) => call.participants.includes(targetId));
      if (activeForCaller || activeForTarget) {
        return emitSocketError(socket, "One of the players is already in a call.", "CALL_BUSY");
      }
      const callId = crypto.randomUUID();
      const caller = { id: userId, username: socket.user.username };
      pendingCalls.set(callId, {
        callId,
        callerId: userId,
        calleeId: targetId,
        video,
        expiresAt: Date.now() + 45000
      });
      io.to("user:" + targetId).emit("call:incoming", { callId, from: caller, video });
      socket.emit("call:outgoing", { callId, targetUserId: targetId, video });
      setTimeout(() => {
        const pending = pendingCalls.get(callId);
        if (pending && pending.expiresAt <= Date.now()) {
          pendingCalls.delete(callId);
          io.to("user:" + pending.callerId).emit("call:missed", { callId });
          io.to("user:" + pending.calleeId).emit("call:missed", { callId });
        }
      }, 45000);
    } catch (error) {
      console.error("Call invitation failed:", error.message);
      emitSocketError(socket, "Could not start the call.", "CALL_FAILED");
    }
  });

  socket.on("call:accept", async (payload) => {
    const callId = payload && payload.callId;
    const pending = pendingCalls.get(callId);
    if (!pending || pending.calleeId !== userId || pending.expiresAt <= Date.now()) {
      return emitSocketError(socket, "This call invitation has expired.", "CALL_EXPIRED");
    }
    pendingCalls.delete(callId);
    activeCalls.set(callId, {
      callId,
      participants: [pending.callerId, pending.calleeId],
      video: pending.video
    });
    const callerProfile = await getPublicUser(pending.callerId);
    const calleeProfile = await getPublicUser(pending.calleeId);
    io.to("user:" + pending.callerId).emit("call:accepted", {
      callId,
      peer: calleeProfile,
      video: pending.video,
      role: "caller"
    });
    io.to("user:" + pending.calleeId).emit("call:accepted", {
      callId,
      peer: callerProfile,
      video: pending.video,
      role: "callee"
    });
  });

  socket.on("call:reject", (payload) => {
    const callId = payload && payload.callId;
    const pending = pendingCalls.get(callId);
    if (!pending || pending.calleeId !== userId) return;
    pendingCalls.delete(callId);
    io.to("user:" + pending.callerId).emit("call:rejected", { callId });
  });

  socket.on("call:signal", (payload) => {
    const callId = payload && payload.callId;
    const type = payload && payload.type;
    const data = payload && payload.data;
    const call = activeCalls.get(callId);
    if (!call || !call.participants.includes(userId) ||
        !["offer", "answer", "ice"].includes(type) ||
        !data || JSON.stringify(data).length > 100000) {
      return;
    }
    const peerId = call.participants.find((participantId) => participantId !== userId);
    io.to("user:" + peerId).emit("call:signal", {
      callId,
      fromUserId: userId,
      type,
      data
    });
  });

  socket.on("call:end", (payload) => {
    const callId = payload && payload.callId;
    if (callId) endCall(callId, userId, "ended");
  });

  socket.on("disconnect", () => {
    const sockets = onlineUsers.get(userId);
    if (sockets) {
      sockets.delete(socket.id);
      if (!sockets.size) {
        onlineUsers.delete(userId);
        broadcastPresence(userId, false).catch(() => {});
      }
    }
    for (const [callId, pending] of pendingCalls.entries()) {
      if (pending.callerId === userId || pending.calleeId === userId) {
        pendingCalls.delete(callId);
        const otherId = pending.callerId === userId ? pending.calleeId : pending.callerId;
        io.to("user:" + otherId).emit("call:ended", {
          callId,
          byUserId: userId,
          reason: "disconnected"
        });
      }
    }
    for (const [callId, call] of activeCalls.entries()) {
      if (call.participants.includes(userId)) endCall(callId, userId, "disconnected");
    }
  });
});

async function start() {
  if (pool) {
    try {
      await pool.query("SELECT 1");
      await migrateDatabase();
      dbReady = true;
      console.log("PostgreSQL connected and schema is ready.");
    } catch (error) {
      dbReady = false;
      console.error("PostgreSQL is not ready:", error.message);
    }
  } else {
    console.warn("DATABASE_URL is not set. The web app will start, but accounts and calls are disabled until it is configured.");
  }

  server.listen(PORT, "0.0.0.0", () => {
    console.log("Testing Sandbox listening on port " + PORT);
  });
}

process.on("SIGTERM", async () => {
  server.close();
  if (pool) await pool.end().catch(() => {});
  process.exit(0);
});

start().catch((error) => {
  console.error("Startup failed:", error);
  process.exit(1);
});
