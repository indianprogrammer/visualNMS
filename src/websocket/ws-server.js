const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);
const config = require('../config/config');
const db = require('../database/db');
const { parseMtrReport } = require('../tools/traceroute');

let io = null;

// Live MTR sessions: one per socket. Each cycle runs a 1-shot mtr report and
// merges it into cumulative per-hop stats (MikroTik-style: sent/loss/last/
// avg/best/worst keep accumulating until stopped).
const _mtrSessions = new Map(); // socket.id -> { stopped, timer, autoStop }
const _targetOk = (t) => /^[a-zA-Z0-9._-]+$/.test(t || '');

function stopMtr(socket) {
  try {
    const s = _mtrSessions.get(socket.id);
    if (s) { s.stopped = true; if (s.timer) clearTimeout(s.timer); if (s.autoStop) clearTimeout(s.autoStop); }
  } catch {}
  _mtrSessions.delete(socket.id);
}

async function mtrLoop(socket, target) {
  const sess = _mtrSessions.get(socket.id);
  if (!sess || sess.stopped) return;
  try {
    const { stdout } = await execAsync(`mtr --report --report-wide --report-cycles 2 -n ${target}`, { timeout: 120000 });
    if (_mtrSessions.get(socket.id) !== sess || sess.stopped) return;
    const hops = parseMtrReport(stdout || '');
    for (const h of hops) {
      const a = sess.agg[h.hop] || (sess.agg[h.hop] = { hop: h.hop, host: h.host, sent: 0, recv: 0, last: null, sum: 0, best: null, worst: null });
      a.host = h.host || a.host;
      const sent = h.sent || 0;
      const recv = Math.max(0, Math.round(sent * (1 - (h.loss || 0) / 100)));
      a.sent += sent; a.recv += recv;
      if (h.last != null) a.last = h.last;
      if (recv > 0 && h.avg != null) {
        a.sum += h.avg * recv;
        a.best = a.best == null ? h.best : Math.min(a.best, h.best != null ? h.best : a.best);
        a.worst = a.worst == null ? h.worst : Math.max(a.worst, h.worst != null ? h.worst : a.worst);
      }
    }
    const rows = Object.values(sess.agg).sort((x, y) => x.hop - y.hop).map((a) => ({
      hop: a.hop, host: a.host, sent: a.sent,
      loss: a.sent ? Math.round((1 - a.recv / a.sent) * 1000) / 10 : 100,
      last: a.last, avg: a.recv ? Math.round((a.sum / a.recv) * 10) / 10 : null,
      best: a.best, worst: a.worst
    }));
    try { socket.emit('tool:mtr-data', { target, hops: rows, cycles: ++sess.cycles }); } catch {}
  } catch (e) {
    try { socket.emit('tool:mtr-data', { target, error: String((e.stderr || e.message || '')).trim().slice(0, 200) }); } catch {}
  }
  if (!_mtrSessions.get(socket.id) || sess.stopped) return;
  sess.timer = setTimeout(() => mtrLoop(socket, target), 1500);
}

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
    socket.on('link:history', async (q, cb) => {
      const done = (rows) => { try { if (typeof cb === 'function') cb(rows); } catch {} };
      try {
        const devId = db.id(q && q.deviceId);
        const ifName = q && q.ifName;
        if (!devId || !ifName) return done([]);
        const limit = Math.min(Math.max(parseInt((q && q.limit)) || 120, 1), 500);
        const rows = await db.rateHistory(devId, ifName, limit);
        done(rows.reverse());
      } catch { done([]); }
    });
    socket.on('disconnect', () => { stopMtr(socket); });
    socket.on('tool:mtr-start', (q) => {
      try {
        stopMtr(socket);
        const target = q && q.target;
        if (!_targetOk(target)) { socket.emit('tool:mtr-data', { target, error: 'Invalid target' }); return; }
        _mtrSessions.set(socket.id, { stopped: false, timer: null, autoStop: null, agg: {}, cycles: 0 });
        const sess = _mtrSessions.get(socket.id);
        sess.autoStop = setTimeout(() => { stopMtr(socket); try { socket.emit('tool:mtr-data', { target, stopped: true }); } catch {} }, 10 * 60 * 1000);
        mtrLoop(socket, target);
      } catch {}
    });
    socket.on('tool:mtr-stop', () => { stopMtr(socket); });
  });
  return io;
}

function getIO() { return io; }

module.exports = { init, getIO };
