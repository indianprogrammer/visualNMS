const dgram = require('dgram');
const db = require('../database/db');
const config = require('../config/config');
let server = null;

function start(io) {
  server = dgram.createSocket('udp4');
  server.on('message', (msg, rinfo) => {
    try {
      const str = msg.toString();
      const m = str.match(/^<(\d+)>\S+\s+\S+\s+(\S+):\s*(.*)/);
      const pri = m ? parseInt(m[1]) : 0;
      const host = m ? m[2] : rinfo.address;
      const message = m ? m[3] : str;
      const sev = pri % 8 <= 2 ? 'critical' : pri % 8 <= 4 ? 'warning' : 'info';
      const dev = db.prepare('SELECT id FROM devices WHERE ip_address=?').get(rinfo.address);
      db.prepare(`INSERT INTO event_log (device_id,event_type,message,source,severity) VALUES (?,?,?,?)`).run(dev?.id||null, 'syslog', `[${host}] ${message}`, 'syslog', sev);
      if (io) io.emit('syslog:message', { hostname: host, message, severity: sev, sourceIp: rinfo.address, timestamp: new Date().toISOString() });
    } catch {}
  });
  server.on('error', () => {});
  server.bind(config.syslog.port, '0.0.0.0');
  console.log(`[Syslog] Listening on UDP :${config.syslog.port}`);
}

function stop() { if (server) { server.close(); server = null; } }
module.exports = { start, stop };
