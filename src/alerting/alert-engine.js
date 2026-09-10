const axios = require('axios');
const nodemailer = require('nodemailer');
const config = require('../config/config');

let transporter = null;

function init() {
  if (config.alerting.smtpHost && config.alerting.smtpUser) {
    transporter = nodemailer.createTransport({ host: config.alerting.smtpHost, port: config.alerting.smtpPort, secure: false, auth: { user: config.alerting.smtpUser, pass: config.alerting.smtpPass } });
  }
}

async function notify(alert, message) {
  if (config.alerting.webhookUrl) {
    axios.post(config.alerting.webhookUrl, { text: message, severity: alert.severity, source: 'Web-NMS' }, { timeout: 10000 }).catch(() => {});
  }
  if (config.alerting.telegramToken && config.alerting.telegramChatId) {
    axios.post(`https://api.telegram.org/bot${config.alerting.telegramToken}/sendMessage`, { chat_id: config.alerting.telegramChatId, text: message }, { timeout: 10000 }).catch(() => {});
  }
  if (transporter && config.alerting.emailTo) {
    transporter.sendMail({ from: config.alerting.emailFrom || 'webnms@localhost', to: config.alerting.emailTo, subject: `[Web-NMS] ${alert.severity}`, text: message }).catch(() => {});
  }
}

module.exports = { init, notify };
