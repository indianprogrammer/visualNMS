const path = require('path');

module.exports = {
  server: {
    port: parseInt(process.env.PORT) || 3000,
    host: '0.0.0.0',
    jwtSecret: process.env.JWT_SECRET || 'web-nms-secret-key-2026',
    jwtExpiresIn: '7d'
  },
  database: {
    path: path.join(__dirname, '..', 'data', 'webnms.db')
  },
  poller: {
    intervalMs: parseInt(process.env.POLL_INTERVAL) || 10000,
    pingIntervalMs: parseInt(process.env.PING_INTERVAL) || 5000,
    snmpIntervalMs: parseInt(process.env.SNMP_INTERVAL) || 60000,
    pingTimeoutMs: 3000,
    snmpTimeoutMs: 1500,
    snmpRetries: 0
  },
  syslog: { port: parseInt(process.env.SYSLOG_PORT) || 1514 },
  trap: { port: parseInt(process.env.TRAP_PORT) || 10162 },
  auth: {
    defaultUser: process.env.ADMIN_USER || 'admin',
    defaultPass: process.env.ADMIN_PASS || 'admin'
  },
  alerting: {
    webhookUrl: process.env.WEBHOOK_URL || '',
    telegramToken: process.env.TELEGRAM_BOT_TOKEN || '',
    telegramChatId: process.env.TELEGRAM_CHAT_ID || '',
    smtpHost: process.env.SMTP_HOST || '',
    smtpPort: parseInt(process.env.SMTP_PORT) || 587,
    smtpUser: process.env.SMTP_USER || '',
    smtpPass: process.env.SMTP_PASS || '',
    emailFrom: process.env.SMTP_FROM || '',
    emailTo: process.env.ALERT_EMAIL_TO || ''
  }
};
