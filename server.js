const http = require('http');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');

const config = require('./src/config/config');
const db = require('./src/database/db');
const auth = require('./src/api/auth');
const routes = require('./src/api/routes');
const wsServer = require('./src/websocket/ws-server');
const pollerEngine = require('./src/pollers/poller-engine');
const maintenance = require('./src/database/maintenance');
const alertEngine = require('./src/alerting/alert-engine');
const syslogListener = require('./src/syslog/syslog-listener');
const trapListener = require('./src/traps/trap-listener');

const app = express();
const server = http.createServer(app);

async function main() {
  try {
    await db.connect();
  } catch (e) {
    console.error('[Mongo] Failed to connect:', e.message);
    process.exit(1);
  }

  const io = wsServer.init(server);

  pollerEngine.setIO(io);
  await alertEngine.init();

  app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
  app.use(cors());
  app.use(express.json({ limit: '10mb' }));
  app.use(rateLimit({ windowMs: 60000, max: 300 }));
  app.use(express.static(path.join(__dirname, 'public')));
  app.use('/api', routes);

  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  });

  // Retain/downsample background job: every 10 minutes once the server is up.
  const maintTimer = setInterval(() => maintenance.runMaintenance().catch(() => {}), 10 * 60 * 1000);

  process.on('SIGINT', () => { clearInterval(maintTimer); pollerEngine.stop(); syslogListener.stop(); trapListener.stop(); server.close(); process.exit(0); });
  process.on('SIGTERM', () => { clearInterval(maintTimer); pollerEngine.stop(); syslogListener.stop(); trapListener.stop(); server.close(); process.exit(0); });

  server.listen(config.server.port, config.server.host, async () => {
    console.log(`\n  ╔══════════════════════════════════════╗`);
    console.log(`  ║   Web-NMS Network Management System  ║`);
    console.log(`  ║   http://localhost:${config.server.port}              ║`);
    console.log(`  ╚══════════════════════════════════════╝\n`);
    await auth.initAdmin();
    pollerEngine.start().catch((e) => console.error('[Poller] start error:', e.message));
    try { syslogListener.start(io); } catch {}
    try { trapListener.start(io); } catch {}
    await db.addEvent(null, 'system', 'Server started', 'system', 'info');
    maintenance.runMaintenance().catch((e) => console.error('[Maint] startup run failed:', e.message));
  });
}

main();
