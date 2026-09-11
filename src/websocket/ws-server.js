const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const config = require('../config/config');
const db = require('../database/db');

let io = null;

function init(server) {
  io = new Server(server, { cors: { origin: '*' } });
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error('No token'));
    try { socket.user = jwt.verify(token, config.server.jwtSecret); next(); }
    catch { next(new Error('Invalid token')); }
  });
  io.on('connection', (socket) => {
    console.log(`[WS] Connected: ${socket.user?.username}`);
    socket.on('subscribe:device', (id) => socket.join(`device:${id}`));
    socket.on('subscribe:map', (id) => socket.join(`map:${id}`));
    // Realtime link graph history, oldest-first, precomputed server rates.
    socket.on('link:history', (q, cb) => {
      const done = (rows) => { try { if (typeof cb === 'function') cb(rows); } catch {} };
      try {
        const devId = parseInt(q && q.deviceId);
        const ifName = q && q.ifName;
        if (!devId || !ifName) return done([]);
        const limit = Math.min(Math.max(parseInt((q && q.limit)) || 120, 1), 500);
        const rows = db.prepare(
          `SELECT rx_bps, tx_bps, timestamp FROM link_rate_history WHERE device_id=? AND interface_name=? ORDER BY timestamp DESC LIMIT ?`
        ).all(devId, ifName, limit);
        done(rows.reverse());
      } catch { done([]); }
    });
    socket.on('disconnect', () => {});
  });
  return io;
}

function getIO() { return io; }

module.exports = { init, getIO };
