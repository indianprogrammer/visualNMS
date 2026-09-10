const dgram = require('dgram');
const db = require('../database/db');
const config = require('../config/config');
let server = null;

function start(io) {
  server = dgram.createSocket('udp4');
  server.on('message', (msg, rinfo) => {
    try {
      const dev = db.prepare('SELECT id FROM devices WHERE ip_address=?').get(rinfo.address);
      const message = `SNMP Trap from ${rinfo.address}: ${msg.length} bytes`;
      db.prepare(`INSERT INTO event_log (device_id,event_type,message,source,severity) VALUES (?,?,?,?)`).run(dev?.id||null, 'trap', message, 'snmp-trap', 'info');
      if (io) io.emit('trap:received', { agentIp: rinfo.address, timestamp: new Date().toISOString() });
    } catch {}
  });
  server.on('error', () => {});
  server.bind(config.trap.port, '0.0.0.0');
  console.log(`[Trap] Listening on UDP :${config.trap.port}`);
}

function stop() { if (server) { server.close(); server = null; } }
module.exports = { start, stop };
