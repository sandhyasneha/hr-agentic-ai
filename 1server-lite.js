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

// ---------- data setup (file-based persistence) ----------
const DB_FILE = path.join(__dirname, 'data', 'leaves.json');
fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });

function readDB() {
  if (!fs.existsSync(DB_FILE)) return { employees: {} };
  return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
}
function writeDB(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

const SEED = { CL: 12, SL: 12, PL: 45, PAT: 8 };
function getEmp(db, email) {
  const key = email.toLowerCase();
  if (!db.employees[key]) {
    db.employees[key] = { balances: { ...SEED }, lastRequest: null };
  }
  return db.employees[key];
}

// ---------- email (optional) ----------
let mailer = null;
if (process.env.SMTP_HOST) {
  mailer = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: false,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });
}
async function emailConfirmation(to, body) {
  if (!mailer) return;
  try {
    await mailer.sendMail({ from: process.env.SMTP_FROM, to, subject: 'Leave Confirmation', text: body });
  } catch (_) {}
}

// ---------- session + helpers ----------
const sessions = new Map();
const S = sid => (sessions.has(sid) ? sessions.get(sid) : (sessions.set(sid, {}), sessions.get(sid)));

const LEAVE_MAP = {
  'casual': 'CL', 'casual leave': 'CL', 'cl': 'CL',
  'sick': 'SL', 'sick leave': 'SL', 'sl': 'SL',
  'privilege': 'PL', 'privilege leave': 'PL', 'pl': 'PL', 'earned': 'PL',
  'paternity': 'PAT', 'paternity leave': 'PAT', 'pat': 'PAT'
};
function parseLeaveType(s) {
  if (!s) return null;
  s = s.toLowerCase();
  for (const k of Object.keys(LEAVE_MAP)) if (s.includes(k)) return LEAVE_MAP[k];
  return null;
}
function parseDates(s) {
  const r = chrono.parse(s, { timezone: 'Asia/Kolkata' });
  if (!r.length) return null;
  const ds = r.map(x => x.start.date());
  return { start: ds[0], end: ds[1] || ds[0] };
}
const say = (vr, t) => vr.say({ voice: 'alice', language: 'en-IN' }, t);
const gather = (vr, a = {}) => vr.gather({
  input: 'speech dtmf',
  numDigits: a.numDigits || 1,
  timeout: a.timeout || 5,
  action: a.action,
  method: 'POST',
  speechTimeout: 'auto',
  hints: a.hints
});
function normalizeEmail(s) {
  if (!s) return null;
  return s.toLowerCase().replace(/\s+/g, '').replace(/at/g, '@').replace(/dot/g, '.');
}

// ---------- request logger (fixed for Express 5) ----------
app.use((req, _res, next) => { console.log('[REQ]', req.method, req.path); next(); });

// ===================================================================
// TEMP ROUTE to pass Twilio 11200 checks (use this first to validate):
// ===================================================================
app.all('/voice', (req, res) => {
  const vr = new VoiceResponse();
  vr.say({ voice: 'alice', language: 'en-IN' }, 'Hello from H R Assistant. Your webhook is working.');
  res.set('Content-Type', 'text/xml; charset=utf-8');
  res.status(200).send(vr.toString());
});

// Optional: friendly root for browser tests
app.get('/', (_, res) => res.send('HR Voice IVR (Lite) running.'));

// ===================================================================
// FULL IVR FLOW — enable after the hello test works:
//   1) Comment OUT the temp /voice above
//   2) UNCOMMENT the block below
// ===================================================================
/*

// Entry: ask for portal ID
app.all('/voice', (req, res) => {
  const vr = new VoiceResponse();
  const g = gather(vr, { action: '/id', numDigits: 50 });
  say(g, 'Welcome to H R Assistant. Please say or enter your employee portal I D, for example 2 4 6 4 3 3 at n t t data dot com.');
  res.set('Content-Type', 'text/xml; charset=utf-8');
  res.status(200).send(vr.toString());
});

// Capture ID then menu
app.all('/id', (req, res) => {
  const vr = new VoiceResponse();
  const email = normalizeEmail(req.body.SpeechResult) || req.body.Digits;
  if (!email || !email.includes('@')) {
    say(vr, 'Invalid email. Let us try again.');
    vr.redirect('/voice');
    res.set('Content-Type', 'text/xml; charset=utf-8');
    return res.send(vr.toString());
  }
  const sess = S(req.body.CallSid); sess.email = email;
  const g = gather(vr, { action: '/menu' });
  say(g, 'Thank you. For Apply Leave, press or say 1. For Leave Status, press or say 2. For Balance, press or say 3.');
  res.set('Content-Type', 'text/xml; charset=utf-8');
  res.send(vr.toString());
});

// Menu
app.all('/menu', (req, res) => {
  const vr = new VoiceResponse();
  const digit = (req.body.Digits || '').trim();
  const speech = (req.body.SpeechResult || '').toLowerCase();
  const choice = digit || ( /one|apply/.test(speech) ? '1' : /two|status/.test(speech) ? '2' : /three|balance/.test(speech) ? '3' : '' );
  if (choice === '1') {
    const g = gather(vr, { action: '/apply/type', hints: 'casual leave, sick leave, privilege leave, paternity leave' });
    say(g, 'Choose your leave type. Casual leave, Sick leave, Privilege leave, or Paternity leave?');
  } else if (choice === '2') {
    vr.redirect('/status');
  } else if (choice === '3') {
    vr.redirect('/balance');
  } else {
    say(vr, 'Sorry, I did not get that.');
    vr.redirect('/id');
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
    say(g, 'Please say Casual, Sick, Privilege, or Paternity.');
    res.set('Content-Type', 'text/xml; charset=utf-8');
    return res.send(vr.toString());
  }
  sess.leaveCode = code;
  const g = gather(vr, { action: '/apply/dates' });
  say(g, 'Please say your from and to dates. For example, from twentieth September twenty twenty five to twenty second September twenty twenty five.');
  res.set('Content-Type', 'text/xml; charset=utf-8');
  res.send(vr.toString());
});

// Apply: dates -> approve -> deduct
app.all('/apply/dates', (req, res) => {
  const vr = new VoiceResponse();
  const sess = S(req.body.CallSid);
  const dates = parseDates(req.body.SpeechResult || '');
  if (!dates) {
    const g = gather(vr, { action: '/apply/dates' });
    say(g, 'Sorry, I could not understand the dates. Please repeat from and to dates.');
    res.set('Content-Type', 'text/xml; charset=utf-8');
    return res.send(vr.toString());
  }
  const db = readDB();
  const emp = getEmp(db, sess.email);
  const days = Math.max(1, Math.round((dates.end - dates.start) / (1000 * 60 * 60 * 24)) + 1);
  const bal = emp.balances[sess.leaveCode] || 0;
  if (bal < days) {
    say(vr, 'Sorry, insufficient balance for the requested dates.');
    res.set('Content-Type', 'text/xml; charset=utf-8');
    return res.send(vr.toString());
  }
  emp.balances[sess.leaveCode] = bal - days;
  emp.lastRequest = {
    code: sess.leaveCode,
    start: dates.start.toISOString().slice(0, 10),
    end: dates.end.toISOString().slice(0, 10),
    days, status: 'APPROVED'
  };
  writeDB(db);

  const msg = `Your ${sess.leaveCode} leave is applied from ${emp.lastRequest.start} to ${emp.lastRequest.end}. Status: APPROVED.`;
  emailConfirmation(sess.email, msg).catch(() => {});
  say(vr, msg);
  say(vr, 'You can check the leave status later by choosing option 2, or balance by option 3. Thank you.');

  res.set('Content-Type', 'text/xml; charset=utf-8');
  res.send(vr.toString());
});

// Status
app.all('/status', (req, res) => {
  const vr = new VoiceResponse();
  const sess = S(req.body.CallSid);
  const db = readDB();
  const emp = getEmp(db, sess.email);
  if (!emp.lastRequest) say(vr, 'No leave requests found for your account.');
  else say(vr, `Your ${emp.lastRequest.code} leave from ${emp.lastRequest.start} to ${emp.lastRequest.end} is ${emp.lastRequest.status}.`);
  res.set('Content-Type', 'text/xml; charset=utf-8');
  res.send(vr.toString());
});

// Balance
app.all('/balance', (req, res) => {
  const vr = new VoiceResponse();
  const sess = S(req.body.CallSid);
  const db = readDB();
  const emp = getEmp(db, sess.email);
  const parts = Object.entries(emp.balances).map(([k, v]) => {
    const name = k === 'CL' ? 'Casual leave' : k === 'SL' ? 'Sick leave' : k === 'PL' ? 'Privilege leave' : 'Paternity leave';
    return `${name} ${v} days`;
  });
  say(vr, `Your available leave balances are: ${parts.join(', ')}.`);
  res.set('Content-Type', 'text/xml; charset=utf-8');
  res.send(vr.toString());
});

*/

// ---------- start ----------
app.listen(process.env.PORT || 3000, () => console.log('Lite server started'));
