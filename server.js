// server.js
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const { twiml: { VoiceResponse } } = require('twilio');
const chrono = require('chrono-node');
const nodemailer = require('nodemailer');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// ---------- Data (file-based) ----------
const DB_FILE = path.join(__dirname, 'data', 'leaves.json');
fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });

function readDB() {
  if (!fs.existsSync(DB_FILE)) return { employees: {} };
  return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
}
function writeDB(db) { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); }

// Seed balances for demo
const SEED = { CL: 8, PL: 10, SL: 9, PAT: 8 };

function getEmp(db, email) {
  const key = email.toLowerCase();
  if (!db.employees[key]) {
    db.employees[key] = {
      balances: { ...SEED },
      requests: []
    };
  }
  return db.employees[key];
}

// ---------- Email ----------
let mailer = null;
if (process.env.SMTP_HOST) {
  mailer = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: false,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });
}
async function emailConfirmation(toEmail, body) {
  if (!mailer) return;
  try {
    const htmlBody = `
      <div style="font-family: Arial, sans-serif; padding:20px; border:1px solid #ddd;">
        <h2 style="color:#0072c6;">NTT DATA HR SERVICES</h2>
        <p>Hello,</p>
        <p>${body}</p>
        <p>Regards,<br/>NTT DATA HR Assistant</p>
        <hr/>
        <small style="color:#555;">This is an automated message from the NTT DATA HR Assistant MVP.</small>
      </div>`;
    await mailer.sendMail({
      from: process.env.SMTP_FROM || 'NTT HR SERVICES <chan2006@gmail.com>',
      to: toEmail,
      subject: 'Leave Application Confirmation',
      text: body,
      html: htmlBody
    });
  } catch (e) {
    console.error('Email send failed:', e?.message || e);
  }
}

// ---------- Helpers ----------
const sessions = new Map();
const S = sid => (sessions.has(sid) ? sessions.get(sid) : (sessions.set(sid, {}), sessions.get(sid)));

const LEAVE_MAP = {
  'casual': 'CL', 'casual leave': 'CL', 'cl': 'CL',
  'personal': 'PL', 'personal leave': 'PL', 'pl': 'PL',
  'paternity': 'PAT', 'paternity leave': 'PAT', 'pat': 'PAT',
  'sick': 'SL', 'sick leave': 'SL', 'sl': 'SL'
};

function parseLeaveType(s) {
  if (!s) return null;
  const t = s.toLowerCase();
  for (const k of Object.keys(LEAVE_MAP)) if (t.includes(k)) return LEAVE_MAP[k];
  return null;
}

function parseDates(s) {
  const r = chrono.parse(s, { timezone: 'Asia/Kolkata' });
  if (!r.length) return null;
  const start = r[0].start?.date();
  const end = r[1]?.start?.date() || start;
  if (!start || !end) return null;
  return { start, end };
}

const say = (vr, t) => vr.say({ voice: 'alice', language: 'en-IN' }, t);
const gather = (vr, a = {}) => vr.gather({
  input: 'speech dtmf',
  numDigits: a.numDigits || 1,
  timeout: a.timeout || 6,
  action: a.action,
  method: 'POST',
  speechTimeout: 'auto',
  hints: a.hints
});

// Email regex (6 digits @ nttdata.com or ntt.data.com)
const EMAIL_RE = /^\s*(\d{6})@(nttdata\.com|ntt\.data\.com)\s*$/i;

function normalizeEmail(s) {
  if (!s) return null;
  let t = s.toLowerCase();
  t = t.replace(/\s+/g, '');
  t = t.replace(/at/g, '@');
  t = t.replace(/dot/g, '.');
  t = t.replace(/[^\w@.]+/g, ''); // remove invalid chars
  t = t.replace(/\.+$/, '');      // strip trailing dots
  return t;
}

// ---------- Logger ----------
app.use((req, _res, next) => { console.log('[REQ]', req.method, req.path); next(); });

// ---------- IVR FLOW ----------
app.all('/voice', (req, res) => {
  const vr = new VoiceResponse();
  const g = gather(vr, { action: '/id', numDigits: 50 });
  say(g, 'Welcome to N T T Data H R Assistant. Please say your employee portal I D, for example 2 4 6 4 3 3 at n t t data dot com.');
  res.set('Content-Type', 'text/xml; charset=utf-8');
  res.status(200).send(vr.toString());
});

app.all('/id', (req, res) => {
  const vr = new VoiceResponse();
  console.log('[ID] SpeechResult=', req.body.SpeechResult, 'Digits=', req.body.Digits);

  const spoken = req.body.SpeechResult;
  const digits = req.body.Digits;
  let email = normalizeEmail(spoken) || (digits ? String(digits) : null);

  if (!email) {
    say(vr, 'Sorry, no input received. Thank you.');
    return res.type('text/xml').send(vr.toString());
  }

  if (!EMAIL_RE.test(email)) {
    say(vr, 'Invalid employee portal I D. Please try again later. Thank you.');
    return res.type('text/xml').send(vr.toString());
  }

  const sess = S(req.body.CallSid);
  sess.email = email;

  const g = gather(vr, { action: '/menu' });
  say(g, 'Thank you. Please choose menu carefully. Option 1, apply leave. Option 2, check your leave status.');
  res.set('Content-Type', 'text/xml; charset=utf-8');
  res.send(vr.toString());
});

// (rest of your /menu, /apply/type, /apply/dates, /status routes unchanged …)
