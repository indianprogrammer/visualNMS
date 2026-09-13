const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const db = require('../database/db');
const config = require('../config/config');
const perms = require('./permissions');

async function initAdmin() {
  try {
    const existing = await db.findOne('users', { username: config.auth.defaultUser });
    if (!existing) {
      const hash = await bcrypt.hash(config.auth.defaultPass, 10);
      await db.ins('users', { username: config.auth.defaultUser, password_hash: hash, role: 'admin' });
      console.log(`[Auth] Created admin user: ${config.auth.defaultUser}`);
    }
  } catch (e) { console.error('[Auth] initAdmin error:', e.message); }
}

function signToken(user) {
  return jwt.sign({ id: user.id, username: user.username, role: user.role }, config.server.jwtSecret, { expiresIn: config.server.jwtExpiresIn });
}

function requireAuth(req, res, next) {
  const hdr = req.headers.authorization;
  if (!hdr || !hdr.startsWith('Bearer ')) return res.status(401).json({ error: 'No token' });
  try {
    req.user = jwt.verify(hdr.slice(7), config.server.jwtSecret);
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

function requireRole(role) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'No token' });
    if (req.user.role !== role) return res.status(403).json({ error: 'Forbidden: admin only' });
    next();
  };
}

// Live permission check: reads the user's current record so permission changes
// apply immediately without a re-login. Admins bypass all checks.
function requirePerm(kind, key) {
  return async (req, res, next) => {
    try {
      if (!req.user) return res.status(401).json({ error: 'No token' });
      if (req.user.role === 'admin') return next();
      const u = await db.findOne('users', { id: db.id(req.user.id) });
      if (!u) return res.status(401).json({ error: 'Unknown user' });
      if (u.role === 'admin') return next();
      // Missing permissions block: fall back to the role template semantics.
      const p = u.permissions || {};
      if (!Array.isArray(p[kind])) {
        if (kind === 'pages') return next();
        return u.role === 'readwrite' ? next() : res.status(403).json({ error: 'Forbidden' });
      }
      if (!perms.has(p, kind, key)) return res.status(403).json({ error: 'Forbidden' });
      next();
    } catch (e) { next(e); }
  };
}

module.exports = { initAdmin, signToken, requireAuth, requireRole, requirePerm, permissions: perms };
