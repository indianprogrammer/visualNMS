const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const config = require('../config/config');

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
    socket.on('disconnect', () => {});
  });
  return io;
}

function getIO() { return io; }

module.exports = { init, getIO };
