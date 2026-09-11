const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const config = require('../config/config');

const dbDir = path.dirname(config.database.path);
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

const db = new Database(config.database.path);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT DEFAULT 'admin',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS devices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  ip_address TEXT NOT NULL UNIQUE,
  mac_address TEXT,
  device_type TEXT DEFAULT 'generic',
  status TEXT DEFAULT 'unknown',
  snmp_community TEXT DEFAULT 'public',
  snmp_version TEXT DEFAULT '2c',
  snmp_port INTEGER DEFAULT 161,
  snmp_user TEXT,
  snmp_auth_pass TEXT,
  snmp_priv_pass TEXT,
  snmp_auth_protocol TEXT,
  snmp_priv_protocol TEXT,
  api_type TEXT,
  http_url TEXT,
  latitude REAL,
  longitude REAL,
  last_seen DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS maps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  background_image TEXT,
  parent_map_id INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(parent_map_id) REFERENCES maps(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS map_nodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  map_id INTEGER NOT NULL,
  device_id INTEGER,
  sub_map_id INTEGER,
  x_position INTEGER DEFAULT 100,
  y_position INTEGER DEFAULT 100,
  custom_label TEXT,
  icon_name TEXT,
  FOREIGN KEY(map_id) REFERENCES maps(id) ON DELETE CASCADE,
  FOREIGN KEY(device_id) REFERENCES devices(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS map_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  map_id INTEGER NOT NULL,
  source_node_id INTEGER NOT NULL,
  target_node_id INTEGER NOT NULL,
  source_interface TEXT,
  target_interface TEXT,
  max_speed_bps INTEGER DEFAULT 1000000000,
  FOREIGN KEY(map_id) REFERENCES maps(id) ON DELETE CASCADE,
  FOREIGN KEY(source_node_id) REFERENCES map_nodes(id) ON DELETE CASCADE,
  FOREIGN KEY(target_node_id) REFERENCES map_nodes(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS interfaces (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id INTEGER NOT NULL,
  if_index INTEGER NOT NULL,
  if_name TEXT,
  if_type INTEGER,
  if_speed INTEGER DEFAULT 0,
  if_oper_status INTEGER DEFAULT 0,
  if_admin_status INTEGER DEFAULT 0,
  if_in_octets INTEGER DEFAULT 0,
  if_out_octets INTEGER DEFAULT 0,
  if_in_errors INTEGER DEFAULT 0,
  if_out_errors INTEGER DEFAULT 0,
  last_updated DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(device_id) REFERENCES devices(id) ON DELETE CASCADE,
  UNIQUE(device_id, if_index)
);

CREATE TABLE IF NOT EXISTS metric_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id INTEGER NOT NULL,
  metric_type TEXT NOT NULL,
  interface_name TEXT,
  value REAL NOT NULL,
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(device_id) REFERENCES devices(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_mh_dev_time ON metric_history(device_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_mh_dev_type ON metric_history(device_id, metric_type, timestamp);

CREATE TABLE IF NOT EXISTS last_metrics (
  device_id INTEGER NOT NULL,
  metric_type TEXT NOT NULL,
  value REAL,
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (device_id, metric_type),
  FOREIGN KEY(device_id) REFERENCES devices(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id INTEGER,
  severity TEXT NOT NULL,
  message TEXT NOT NULL,
  status TEXT DEFAULT 'active',
  acknowledged_by INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  acknowledged_at DATETIME,
  resolved_at DATETIME,
  FOREIGN KEY(device_id) REFERENCES devices(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS alert_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  device_id INTEGER,
  metric_type TEXT NOT NULL,
  condition_op TEXT DEFAULT 'gt',
  threshold REAL NOT NULL,
  severity TEXT DEFAULT 'warning',
  cooldown_seconds INTEGER DEFAULT 300,
  notify_webhook INTEGER DEFAULT 0,
  notify_email INTEGER DEFAULT 0,
  notify_telegram INTEGER DEFAULT 0,
  notify_browser INTEGER DEFAULT 1,
  enabled INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(device_id) REFERENCES devices(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS event_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id INTEGER,
  event_type TEXT NOT NULL,
  message TEXT NOT NULL,
  source TEXT DEFAULT 'system',
  severity TEXT DEFAULT 'info',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(device_id) REFERENCES devices(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_el_time ON event_log(created_at);

CREATE TABLE IF NOT EXISTS snmp_profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  snmp_version TEXT DEFAULT '2c',
  snmp_community TEXT,
  snmp_port INTEGER DEFAULT 161,
  snmp_user TEXT,
  snmp_auth_protocol TEXT,
  snmp_auth_pass TEXT,
  snmp_priv_protocol TEXT,
  snmp_priv_pass TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
INSERT OR IGNORE INTO snmp_profiles (id,name,snmp_version,snmp_community,snmp_port) VALUES (1,'Default v2c','2c','public',161);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
INSERT OR IGNORE INTO settings (key,value) VALUES ('snmp_interval_ms','5000');
INSERT OR IGNORE INTO settings (key,value) VALUES ('ping_interval_ms','5000');

CREATE TABLE IF NOT EXISTS discovery_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subnet TEXT NOT NULL,
  status TEXT DEFAULT 'pending',
  total_ips INTEGER DEFAULT 0,
  found_devices INTEGER DEFAULT 0,
  started_at DATETIME,
  completed_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
`);

db.getSetting = function (key, fallback) {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
    if (!row || row.value === null || row.value === undefined || row.value === '') return fallback;
    const n = parseInt(row.value);
    return isNaN(n) ? fallback : n;
  } catch (e) { return fallback; }
};

db.setSetting = function (key, value) {
  db.prepare(`INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(key, String(value));
};

module.exports = db;
