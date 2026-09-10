const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const db = require('../database/db');
const config = require('../config/config');

function initAdmin() {
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(config.auth.defaultUser);
  if (!existing) {
    const hash = bcrypt.hashSync(config.auth.defaultPass, 10);
    db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run(config.auth.defaultUser, hash, 'admin');
    console.log(`[Auth] Created admin user: ${config.auth.defaultUser}`);
  }
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
