const axios = require('axios');
const nodemailer = require('nodemailer');
const config = require('../config/config');
const db = require('../database/db');

let transporter = null;

// DB-stored notification settings override env (set via Settings UI).
async function cfg(key, envVal) {
  try {
    const v = await db.getSettingRaw('notify_' + key, null);
    if (v !== null && v !== undefined && String(v) !== '') return v;
  } catch {}
  return envVal;
}

async function init() {
  const host = await cfg('smtp_host', config.alerting.smtpHost);
  const user = await cfg('smtp_user', config.alerting.smtpUser);
  if (host && user) {
    transporter = nodemailer.createTransport({ host, port: config.alerting.smtpPort, secure: false, auth: { user, pass: await cfg('smtp_pass', config.alerting.smtpPass) } });
  }
}

async function notify(alert, message, channels) {
  const want = (k) => !channels || channels[k] === undefined || !!channels[k];
  const webhookUrl = want('webhook') && await cfg('webhook_url', config.alerting.webhookUrl);
  if (webhookUrl) {
    axios.post(webhookUrl, { text: message, severity: alert.severity, source: 'Web-NMS' }, { timeout: 10000 }).catch(() => {});
  }
  const tgToken = want('telegram') && await cfg('telegram_token', config.alerting.telegramToken);
  const tgChat = want('telegram') && await cfg('telegram_chat_id', config.alerting.telegramChatId);
  if (tgToken && tgChat) {
    axios.post(`https://api.telegram.org/bot${tgToken}/sendMessage`, { chat_id: tgChat, text: message }, { timeout: 10000 }).catch(() => {});
  }
  // Transporter rebuilt from current settings so UI saves apply without restart.
  if (!want('email')) {
    if (transporter && config.alerting.emailTo && !channels) {
      transporter.sendMail({ from: config.alerting.emailFrom || 'webnms@localhost', to: config.alerting.emailTo, subject: `[Web-NMS] ${alert.severity}`, text: message }).catch(() => {});
    }
    return;
  }
  try {
    const host = await cfg('smtp_host', config.alerting.smtpHost);
    const user = await cfg('smtp_user', config.alerting.smtpUser);
    const emailTo = await cfg('alert_email_to', config.alerting.emailTo);
    if (host && user && emailTo) {
      const t = nodemailer.createTransport({ host, port: config.alerting.smtpPort, secure: false, auth: { user, pass: await cfg('smtp_pass', config.alerting.smtpPass) } });
      t.sendMail({ from: config.alerting.emailFrom || 'webnms@localhost', to: emailTo, subject: `[Web-NMS] ${alert.severity}`, text: message }).catch(() => {});
    } else if (transporter && config.alerting.emailTo) {
      transporter.sendMail({ from: config.alerting.emailFrom || 'webnms@localhost', to: config.alerting.emailTo, subject: `[Web-NMS] ${alert.severity}`, text: message }).catch(() => {});
    }
  } catch {}
}

module.exports = { init, notify };
