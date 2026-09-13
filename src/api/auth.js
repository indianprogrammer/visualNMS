const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const db = require('../database/db');
const config = require('../config/config');

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

module.exports = { initAdmin, signToken, requireAuth };
