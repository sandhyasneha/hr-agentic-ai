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

// ---------- Email parsing & validation ----------
// 1) Normalizer tolerant to ASR quirks
function normalizeEmail(s) {
  if (!s) return null;
  let t = String(s).toLowerCase();

  // common ASR: " at " / " dot "
  t = t.replace(/\s+at\s+/g, '@');
  t = t.replace(/\s+dot\s+/g, '.');

  // remove all spaces (handles "n t t data")
  t = t.replace(/\s+/g, '');

  // sometimes ASR returns unicode punctuation; keep only email-ish chars
  t = t.replace(/[^a-z0-9@._-]+/g, '');

  // collapse multiple dots
  t = t.replace(/\.+/g, '.');

  // strip trailing dots or stray punctuation
  t = t.replace(/[._-]+$/g, '');

  return t;
}

// 2) Relaxed validator that still enforces your rule (6 digits @ nttdata.com / ntt.data.com)
function isValidNTTEmail(email) {
  if (!email) return false;

  // Try strict first
  const strict = /^\s*(\d{6})@(nttdata\.com|ntt\.data\.com)\s*$/i;
  if (strict.test(email)) return true;

  // Fallback: extract first email-like token, then check pattern
  const m = email.match(/(\d{6})@([a-z0-9.-]+)/i);
  if (!m) return false;
  const six = m[1];
  const domain = m[2];

  // Accept "nttdata.com" or "ntt.data.com" (sometimes ASR inserts or removes a dot)
  const okDomain = /^(ntt\.?data\.com)$/.test(domain);
  return /^\d{6}$/.test(six) && okDomain;
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

  const spoken = req.body.SpeechResult;
  const digits = req.body.Digits;

  const normalized = normalizeEmail(spoken) || (digits ? String(digits) : null);

  // Debug: see raw & normalized in Render logs
  console.log('[ID] SpeechResult =', spoken);
  console.log('[ID] Normalized   =', normalized);

  if (!normalized) {
    say(vr, 'Sorry, no input received. Thank you.');
    return res.type('text/xml').send(vr.toString());
  }

  if (!isValidNTTEmail(normalized)) {
    say(vr, 'Invalid employee portal I D. Please try again later. Thank you.');
    return res.type('text/xml').send(vr.toString());
  }

  const sess = S(req.body.CallSid);
  sess.email = normalized;

  const g = gather(vr, { action: '/menu' });
  say(g, 'Thank you. Please choose menu carefully. Option 1, apply leave. Option 2, check your leave status.');
  res.set('Content-Type', 'text/xml; charset=utf-8');
  res.send(vr.toString());
});

// Menu
app.all('/menu', (req, res) => {
  const vr = new VoiceResponse();
  const digit = (req.body.Digits || '').trim();
  const speech = (req.body.SpeechResult || '').toLowerCase();
  const choice = digit || ( /one|1|apply/.test(speech) ? '1' : /two|2|status/.test(speech) ? '2' : '' );

  if (choice === '1') {
    say(vr, 'Hi, you chose option 1, apply leave. Can you please let me know which type of leave you want: Casual leave, Personal leave, or Paternity leave?');
    const g = gather(vr, { action: '/apply/type', hints: 'casual leave, personal leave, paternity leave, sick leave' });
    say(g, 'Say casual leave, personal leave, or paternity leave.');
  } else if (choice === '2') {
    vr.redirect('/status');
  } else {
    say(vr, 'Sorry, I did not get that. Thank you.');
  }
  res.set('Content-Type', 'text/xml; charset=utf-8');
  res.send(vr.toString());
});

// Apply: type
app.all('/apply/type', (req, res) => {
  const vr = new VoiceResponse();
  const sess = S(req.body.CallSid);
  const code = parseLeaveType(req.body.SpeechResult || req.body.Digits || '');
  if (!code) {
    const g = gather(vr, { action: '/apply/type' });
    say(g, 'Please say casual leave, personal leave, or paternity leave.');
    res.set('Content-Type', 'text/xml; charset=utf-8');
    return res.send(vr.toString());
  }
  sess.leaveCode = code;
  const g = gather(vr, { action: '/apply/dates' });
  say(g, 'Please say your from date to date. For example, from tenth September twenty twenty five to fifteenth September twenty twenty five.');
  res.set('Content-Type', 'text/xml; charset=utf-8');
  res.send(vr.toString());
});

// Apply: dates
app.all('/apply/dates', (req, res) => {
  const vr = new VoiceResponse();
  const sess = S(req.body.CallSid);
  const dates = parseDates(req.body.SpeechResult || '');
  if (!dates) {
    const g = gather(vr, { action: '/apply/dates' });
    say(g, 'Sorry, I could not understand the dates. Please say, for example, from tenth September to fifteenth September twenty twenty five.');
    res.set('Content-Type', 'text/xml; charset=utf-8');
    return res.send(vr.toString());
  }

  const startStr = dates.start.toISOString().slice(0, 10);
  const endStr   = dates.end.toISOString().slice(0, 10);
  const days = Math.max(1, Math.round((dates.end - dates.start) / (1000 * 60 * 60 * 24)) + 1);

  const db = readDB();
  const emp = getEmp(db, sess.email);

  // Duplicate check
  const dup = emp.requests.find(r => r.code === sess.leaveCode && r.start === startStr && r.end === endStr);
  if (dup) {
    say(vr, 'You already applied for the same date. Please choose some other date. Thank you.');
    res.set('Content-Type', 'text/xml; charset=utf-8');
    return res.send(vr.toString());
  }

  // Balance check + deduct
  const balBefore = Number(emp.balances[sess.leaveCode] || 0);
  if (balBefore < days) {
    say(vr, 'Sorry, you do not have sufficient balance for the requested dates.');
    res.set('Content-Type', 'text/xml; charset=utf-8');
    return res.send(vr.toString());
  }

  emp.balances[sess.leaveCode] = balBefore - days;
  const reqObj = { code: sess.leaveCode, start: startStr, end: endStr, days, status: 'APPROVED' };
  emp.requests.push(reqObj);
  writeDB(db);

  const msg = `Your ${sess.leaveCode} leave is applied from ${startStr} to ${endStr}. Status: APPROVED.`;
  const to = sess.email;
  emailConfirmation(to, msg).catch(() => {});

  say(vr, `Your ${friendlyName(sess.leaveCode)} has been applied from ${sayDate(startStr)} to ${sayDate(endStr)}. It is approved. Please check your email.`);
  say(vr, 'You can check your leave status later by choosing option 2. Thank you.');
  res.set('Content-Type', 'text/xml; charset=utf-8');
  res.send(vr.toString());
});

// Status
app.all('/status', (req, res) => {
  const vr = new VoiceResponse();
  const sess = S(req.body.CallSid);
  const db = readDB();
  const emp = getEmp(db, sess.email);

  if (!emp.requests || emp.requests.length === 0) {
    say(vr, 'Thank you. Your current leave status is: no leave is applied so far.');
  } else {
    const last = emp.requests[emp.requests.length - 1];
    say(vr, `Thank you. Your current leave status: your ${friendlyName(last.code)} from ${sayDate(last.start)} to ${sayDate(last.end)} is approved. Please check your email.`);
  }

  const b = emp.balances;
  say(vr, `Your balance leave: Personal leave ${asInt(b.PL)}. Casual leave ${asInt(b.CL)}. Sick leave ${asInt(b.SL)}. Paternity leave ${asInt(b.PAT)}.`);
  res.set('Content-Type', 'text/xml; charset=utf-8');
  res.send(vr.toString());
});

// Root
app.get('/', (_, res) => res.send('NTT DATA HR Assistant IVR — running.'));

// Utils
function friendlyName(code) {
  return code === 'CL' ? 'Casual leave'
    : code === 'PL' ? 'Personal leave'
    : code === 'SL' ? 'Sick leave'
    : code === 'PAT' ? 'Paternity leave'
    : 'leave';
}
function asInt(v) { return Number(v || 0) + ' days'; }
function sayDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  return `${d} ${months[m-1]} ${y}`;
}

// Start
app.listen(process.env.PORT || 3000, () => console.log('Server started'));
