const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});

// Serve static files (index.html, etc.)
app.use(express.static(path.join(__dirname, "public")));

// rooms: { "ABCD": { hostId, members: [socketId, ...], syncState: {...} } }
const rooms = {};

const MAX_MEMBERS = 5;

function generateRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no confusing chars
  let code = "";
  for (let i = 0; i < 4; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return rooms[code] ? generateRoomCode() : code; // retry if collision
}

io.on("connection", (socket) => {
  console.log(`🔌 Connected: ${socket.id}`);

  // ── CREATE ROOM ──────────────────────────────────────────────────────────
  socket.on("create_room", (callback) => {
    const code = generateRoomCode();
    rooms[code] = {
      hostId: socket.id,
      members: [socket.id],
      syncState: null,
    };
    socket.join(code);
    socket.roomCode = code;
    socket.isHost = true;

    console.log(`🏠 Room created: ${code} by ${socket.id}`);
    callback({ success: true, code, memberCount: 1 });
  });

  // ── JOIN ROOM ─────────────────────────────────────────────────────────────
  socket.on("join_room", (code, callback) => {
    const room = rooms[code];

    if (!room) {
      return callback({ success: false, error: "Room not found" });
    }
    if (room.members.length >= MAX_MEMBERS) {
      return callback({ success: false, error: "Room is full (max 5)" });
    }

    room.members.push(socket.id);
    socket.join(code);
    socket.roomCode = code;
    socket.isHost = false;

    // Tell everyone else someone joined
    socket.to(code).emit("member_joined", { memberCount: room.members.length });

    console.log(`👋 ${socket.id} joined room ${code} (${room.members.length}/5)`);

    // Send current sync state so late joiners catch up immediately
    callback({
      success: true,
      code,
      memberCount: room.members.length,
      syncState: room.syncState, // null if nothing playing yet
    });
  });

  // ── HOST SENDS SYNC ───────────────────────────────────────────────────────
  // payload: { trackUrl, startedAt, paused, pausedAt }
  socket.on("sync", (payload) => {
    const code = socket.roomCode;
    const room = rooms[code];

    if (!room) return;
    if (room.hostId !== socket.id) {
      return socket.emit("error", "Only the host can sync");
    }

    // Save state so late joiners can catch up
    room.syncState = { ...payload, updatedAt: Date.now() };

    // Broadcast to everyone else in the room
    socket.to(code).emit("sync", room.syncState);

    console.log(`🎵 Sync in ${code}: ${payload.paused ? "PAUSED" : "PLAYING"} — ${payload.trackUrl}`);
  });

  // ── HOST CHANGES TRACK ────────────────────────────────────────────────────
  socket.on("change_track", (payload) => {
    const code = socket.roomCode;
    const room = rooms[code];

    if (!room || room.hostId !== socket.id) return;

    room.syncState = {
      trackUrl: payload.trackUrl,
      startedAt: payload.startedAt,
      paused: false,
      pausedAt: null,
      updatedAt: Date.now(),
    };

    io.to(code).emit("sync", room.syncState); // send to ALL including host
    console.log(`🔀 Track changed in ${code}: ${payload.trackUrl}`);
  });

  // ── DISCONNECT ────────────────────────────────────────────────────────────
  socket.on("disconnect", () => {
    const code = socket.roomCode;
    const room = rooms[code];
    if (!room) return;

    room.members = room.members.filter((id) => id !== socket.id);
    console.log(`❌ ${socket.id} left room ${code} (${room.members.length}/5)`);

    if (room.members.length === 0) {
      delete rooms[code];
      console.log(`🗑️  Room ${code} deleted (empty)`);
      return;
    }

    // If host left, promote the next member
    if (room.hostId === socket.id) {
      room.hostId = room.members[0];
      io.to(room.hostId).emit("promoted_to_host");
      console.log(`👑 ${room.hostId} promoted to host in ${code}`);
    }

    io.to(code).emit("member_left", { memberCount: room.members.length });
  });
});

// ── Health check endpoint ─────────────────────────────────────────────────
app.get("/", (req, res) => {
  const roomSummary = Object.entries(rooms).map(([code, r]) => ({
    code,
    members: r.members.length,
    playing: !!r.syncState && !r.syncState.paused,
  }));
  res.json({ status: "ok", activeRooms: roomSummary });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🎶 StereoSync server running on http://localhost:${PORT}\n`);
});
