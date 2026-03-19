const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const bodyParser = require('body-parser');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const path = require('path');
const https = require('https');

const app = express();

// ==============================================
// 全局配置
// ==============================================
const PORT = process.env.PORT || 8080;
const SALT_ROUNDS = 12;
const VERIFY_CODE_EXPIRE_SECONDS = 5 * 60;
const DB_PATH = path.join(__dirname, 'dormlift.db'); 
const RATE_LIMIT_WINDOW = 60 * 1000;
const RATE_LIMIT_MAX = 20;

let db = null;
let isDbReady = false;
let rateLimit = {};

// ==============================================
// 中间件
// ==============================================
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'], allowedHeaders: ['Content-Type', 'Authorization'] }));
app.use(bodyParser.json({ limit: '5mb' }));
app.use(bodyParser.urlencoded({ extended: true }));

app.use((req, res, next) => {
  const ip = req.ip || req.connection.remoteAddress;
  const now = Date.now();
  if (!rateLimit[ip]) rateLimit[ip] = { count: 0, time: now };
  if (now - rateLimit[ip].time > RATE_LIMIT_WINDOW) { rateLimit[ip] = { count: 1, time: now }; } 
  else {
    rateLimit[ip].count++;
    if (rateLimit[ip].count > RATE_LIMIT_MAX) return res.status(429).json({ success: false, message: 'Too many requests' });
  }
  next();
});

// ==============================================
// 静态文件路由
// ==============================================
app.use(express.static(__dirname));
app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'index.html')); });
app.get('/api/health', (req, res) => { res.status(200).json({ status: 'running', service: 'DormLift', version: '3.0.0 (Ultimate)', port: PORT }); });

// ==============================================
// 工具函数
// ==============================================
function isValidEmail(email) { return /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(email); }
function generateVerifyCode() { return Math.floor(100000 + Math.random() * 900000).toString(); }
function maskEmail(email) {
  if (!email) return '';
  let [name, domain] = email.split('@');
  if (name.length <= 2) return name + '***@' + domain;
  return name[0] + '***' + name[name.length-1] + '@' + domain;
}
function cleanExpiredCodes() {
  if (db && isDbReady) db.run(`DELETE FROM verify_codes WHERE expire_at < ?`, [Date.now()]);
}

// ==============================================
// 邮件发送 (Google Apps Script)
// ==============================================
function sendVerifyEmail(email, code) {
  return new Promise((resolve) => {
    const GAS_URL = 'https://script.google.com/macros/s/AKfycbzAE3Vyi5B1sdNM--P89E7UDO1VF03lmehb0S6N0tHlvtpvdadDGfyM7jswaUB-RZhU/exec';
    console.log(`\n================================`);
    console.log(`📩 [REAL VERIFY CODE] To: ${email}`);
    console.log(`🔑 CODE: ${code}`);
    console.log(`================================\n`);

    const postData = JSON.stringify({
      to: email,
      subject: 'Your DormLift Verification Code',
      html: `<div style="padding:24px;font-family:Arial,sans-serif;"><h2 style="color:#222;">DormLift Verification</h2><div style="font-size:24px;font-weight:bold;color:#0066cc;padding:12px;background:#f0f7ff;border-radius:8px;margin:16px 0;width:fit-content;">${code}</div><p>This code is valid for 5 minutes.</p></div>`
    });

    const parsedUrl = new URL(GAS_URL);
    const options = { hostname: parsedUrl.hostname, path: parsedUrl.pathname + parsedUrl.search, method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8', 'Content-Length': Buffer.byteLength(postData) } };
    const req = https.request(options, (res) => { console.log(`✅ Mail request sent for ${maskEmail(email)}`); resolve(true); });
    req.on('error', (e) => { console.error('HTTPS Error:', e.message); resolve(true); });
    req.write(postData); req.end();
  });
}

// ==============================================
// 数据库初始化
// ==============================================
function initDatabase() {
  db = new sqlite3.Database(DB_PATH, (err) => {
    if (err) return console.error('Database connect failed:', err.message);
    
    db.exec(`
      PRAGMA foreign_keys = OFF;
      DROP TABLE IF EXISTS verify_codes;
      DROP TABLE IF EXISTS users;
      DROP TABLE IF EXISTS tasks;
      PRAGMA foreign_keys = ON;

      CREATE TABLE verify_codes (email TEXT PRIMARY KEY, code TEXT NOT NULL, expire_at INTEGER NOT NULL);

      CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        student_id TEXT UNIQUE NOT NULL,
        school_name TEXT NOT NULL,
        first_name TEXT NOT NULL,
        given_name TEXT NOT NULL,
        gender TEXT NOT NULL CHECK(gender IN ('male','female','other')),
        anonymous_name TEXT NOT NULL,
        phone TEXT UNIQUE NOT NULL,
        email TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        status TEXT DEFAULT 'active',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        publisher_id TEXT NOT NULL,
        move_date TEXT NOT NULL,
        move_time TEXT NOT NULL,
        from_address TEXT NOT NULL,
        to_address TEXT NOT NULL,
        items_desc TEXT NOT NULL,
        people_needed INTEGER NOT NULL,
        reward TEXT NOT NULL,
        status TEXT DEFAULT 'pending' CHECK(status IN ('pending','assigned','completed','cancelled')),
        helper_id TEXT DEFAULT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `, (err) => {
      if (err) console.error('Create tables error:', err.message);
      else { console.log('✅ All tables initialized successfully'); isDbReady = true; }
    });
  });
}

// ==============================================
// 路由接口 (全 10 个接口，一个不少)
// ==============================================

app.post('/api/auth/send-code', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email || !isValidEmail(email)) return res.status(400).json({ success: false, message: 'Invalid email' });
    cleanExpiredCodes();
    const code = generateVerifyCode();
    const expireAt = Date.now() + VERIFY_CODE_EXPIRE_SECONDS * 1000;
    db.serialize(() => {
      db.run(`DELETE FROM verify_codes WHERE email = ?`, [email]);
      db.run(`INSERT INTO verify_codes (email, code, expire_at) VALUES (?, ?, ?)`, [email, code, expireAt], async (err) => {
        if (err) return res.status(500).json({ success: false, message: 'DB error' });
        await sendVerifyEmail(email, code);
        res.json({ success: true, message: 'Verification code sent' });
      });
    });
  } catch (err) { res.status(500).json({ success: false, message: 'Server error' }); }
});

app.post('/api/auth/register', async (req, res) => {
  try {
    const { student_id, school_name, first_name, given_name, gender, anonymous_name, phone, email, password, code } = req.body;
    cleanExpiredCodes();
    db.get(`SELECT * FROM verify_codes WHERE email = ?`, [email], async (err, record) => {
      if (err || !record || record.code !== code || Date.now() > record.expire_at) {
        return res.status(400).json({ success: false, message: 'Invalid or expired code' });
      }
      db.run(`DELETE FROM verify_codes WHERE email = ?`, [email]);
      const hashedPwd = await bcrypt.hash(password, SALT_ROUNDS);
      db.run(`INSERT INTO users (student_id, school_name, first_name, given_name, gender, anonymous_name, phone, email, password) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [student_id, school_name, first_name, given_name, gender, anonymous_name, phone, email, hashedPwd],
        function (err) {
          if (err) {
            let errorMsg = err.message;
            if (errorMsg.includes('users.student_id')) errorMsg = "该学号已被注册";
            else if (errorMsg.includes('users.phone')) errorMsg = "该手机号已被注册";
            else if (errorMsg.includes('users.email')) errorMsg = "该邮箱已被注册";
            return res.status(400).json({ success: false, message: errorMsg });
          }
          res.json({ success: true, message: 'Registration successful' });
        }
      );
    });
  } catch (err) { res.status(500).json({ success: false, message: 'Server error' }); }
});

app.post('/api/auth/login', (req, res) => {
  const { student_id, password } = req.body;
  db.get(`SELECT * FROM users WHERE student_id = ?`, [student_id], async (err, user) => {
    if (err || !user) return res.status(400).json({ success: false, message: 'User not exists' });
    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(400).json({ success: false, message: 'Wrong password' });
    delete user.password;
    res.json({ success: true, user });
  });
});

app.post('/api/user/profile', (req, res) => {
  const { student_id } = req.body;
  db.get(`SELECT * FROM users WHERE student_id = ?`, [student_id], (err, user) => {
    if (err || !user) return res.status(400).json({ success: false });
    delete user.password;
    res.json({ success: true, user });
  });
});

app.get('/api/task/list', (req, res) => {
  db.all(`SELECT tasks.*, users.anonymous_name as publisher_name FROM tasks LEFT JOIN users ON tasks.publisher_id = users.student_id WHERE tasks.status = 'pending' ORDER BY tasks.created_at DESC`, [], (err, rows) => {
    if (err) return res.status(500).json({ success: false });
    res.json({ success: true, list: rows });
  });
});

app.post('/api/task/create', (req, res) => {
  const { publisher_id, move_date, move_time, from_address, to_address, items_desc, people_needed, reward } = req.body;
  db.run(`INSERT INTO tasks (publisher_id, move_date, move_time, from_address, to_address, items_desc, people_needed, reward) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [publisher_id, move_date, move_time, from_address, to_address, items_desc, people_needed, reward],
    function (err) {
      if (err) return res.status(500).json({ success: false });
      res.json({ success: true, message: 'Request posted' });
    }
  );
});

app.post('/api/task/apply', (req, res) => {
  const { task_id, helper_id } = req.body;
  db.run(`UPDATE tasks SET status = 'assigned', helper_id = ? WHERE id = ? AND status = 'pending'`, [helper_id, task_id], function(err) {
      if (err || this.changes === 0) return res.status(400).json({ success: false, message: 'Apply failed' });
      res.json({ success: true, message: 'Task accepted' });
    });
});

app.post('/api/task/cancel', (req, res) => {
  db.run(`UPDATE tasks SET status = 'cancelled' WHERE id = ?`, [req.body.task_id], function(err) {
      if (err) return res.status(500).json({ success: false });
      res.json({ success: true, message: 'Task cancelled' });
    }
  );
});

app.post('/api/task/my-published', (req, res) => {
  db.all(`SELECT * FROM tasks WHERE publisher_id = ? ORDER BY created_at DESC`, [req.body.student_id], (err, rows) => {
    res.json({ success: true, list: rows || [] });
  });
});

app.post('/api/task/my-assigned', (req, res) => {
  db.all(`SELECT * FROM tasks WHERE helper_id = ? ORDER BY created_at DESC`, [req.body.student_id], (err, rows) => {
    res.json({ success: true, list: rows || [] });
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Server running on 0.0.0.0:${PORT}`);
  setTimeout(() => initDatabase(), 1000);
});
