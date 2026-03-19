const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const bodyParser = require('body-parser');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const path = require('path');
const https = require('https'); // 关键：使用原生 https 模块请求 Mailjet

const app = express();

// ==============================================
// 全局配置
// ==============================================
const PORT = process.env.PORT || 8080;
const SALT_ROUNDS = 12;
const VERIFY_CODE_EXPIRE_SECONDS = 5 * 60;
// 数据库保存在根目录，配合 Railway Volume 防止重启丢失
const DB_PATH = path.join(__dirname, 'dormlift.db'); 
const MAX_LOGIN_ATTEMPTS = 5;
const LOCK_TIME_MINUTES = 15;
const RATE_LIMIT_WINDOW = 60 * 1000;
const RATE_LIMIT_MAX = 20;

let db = null;
let isDbReady = false;
let verifyCodeStore = {};
let loginAttempts = {};
let userLock = {};
let rateLimit = {};

// ==============================================
// 中间件
// ==============================================
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(bodyParser.json({ limit: '5mb' }));
app.use(bodyParser.urlencoded({ extended: true }));

app.use((req, res, next) => {
  const ip = req.ip || req.connection.remoteAddress;
  const now = Date.now();
  if (!rateLimit[ip]) rateLimit[ip] = { count: 0, time: now };
  if (now - rateLimit[ip].time > RATE_LIMIT_WINDOW) {
    rateLimit[ip] = { count: 1, time: now };
  } else {
    rateLimit[ip].count++;
    if (rateLimit[ip].count > RATE_LIMIT_MAX) {
      return res.status(429).json({ success: false, message: 'Too many requests' });
    }
  }
  next();
});

// ==============================================
// 静态文件与页面路由
// ==============================================
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/api/health', (req, res) => {
  res.status(200).json({
    status: 'running',
    service: 'DormLift Ultimate Backend',
    version: '2.0.0',
    port: PORT,
    db_connected: isDbReady,
    timestamp: new Date().toISOString()
  });
});

// ==============================================
// 工具函数
// ==============================================
function isValidEmail(email) { return /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(email); }
function isValidPhone(phone) { return /^(\+?\d{1,4})?\s?\d{6,14}$/.test(phone); }
function isValidStudentId(studentId) { return /^[a-zA-Z0-9]{4,20}$/.test(studentId); }
function generateVerifyCode() { return Math.floor(100000 + Math.random() * 900000).toString(); }
function generateToken() { return crypto.randomBytes(32).toString('hex'); }

function isUserLocked(studentId) {
  if (!userLock[studentId]) return false;
  return Date.now() < userLock[studentId];
}

function cleanExpiredCodes() {
  const now = Date.now();
  for (let email in verifyCodeStore) {
    if (verifyCodeStore[email].expireAt < now) delete verifyCodeStore[email];
  }
}

function cleanExpiredRateLimits() {
  const now = Date.now();
  for (let ip in rateLimit) {
    if (now - rateLimit[ip].time > RATE_LIMIT_WINDOW * 2) delete rateLimit[ip];
  }
}

function maskEmail(email) {
  if (!email) return '';
  let [name, domain] = email.split('@');
  if (name.length <= 2) return name + '***@' + domain;
  return name[0] + '***' + name[name.length-1] + '@' + domain;
}

// ==============================================
// 邮件发送 (Mailjet HTTP API 版：彻底绕过端口封锁)
// ==============================================
function sendVerifyEmail(email, code) {
  return new Promise((resolve) => {
    
    // 【修改这里】写你在 Mailjet 注册并验证过的邮箱，比如 'myname@gmail.com'
    const senderEmail = 'work_wht@outlook.com'; 
    
    // 你提供的 API Keys (已硬编码，无需设置 Railway 环境变量)
    const apiKey = '661ba28328403ebcbc26b68ef70b8d80';
    const secretKey = '079a8c4b7e40efb7a550a343d0214e3b';

    const postData = JSON.stringify({
      Messages: [
        {
          From: {
            Email: senderEmail,
            Name: "DormLift Official"
          },
          To: [{ Email: email }],
          Subject: "Your DormLift Verification Code",
          HTMLPart: `
            <div style="padding:24px;background:#f7f7f7;font-family:Arial,sans-serif;">
              <div style="max-width:500px;margin:auto;background:white;padding:24px;border-radius:12px;">
                <h2 style="color:#222;margin-top:0;">DormLift Verification</h2>
                <p>Hello,</p>
                <p>Your verification code is:</p>
                <div style="font-size:24px;font-weight:bold;color:#0066cc;padding:12px;text-align:center;background:#f0f7ff;border-radius:8px;margin:16px 0;">
                  ${code}
                </div>
                <p>This code is valid for 5 minutes. Do not share it with others.</p>
                <br><p>Best regards,<br>DormLift Team</p>
              </div>
            </div>
          `
        }
      ]
    });

    const auth = Buffer.from(`${apiKey}:${secretKey}`).toString('base64');

    const options = {
      hostname: 'api.mailjet.com',
      path: '/v3.1/send',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Basic ${auth}`,
        'Content-Length': Buffer.byteLength(postData)
      }
    };

    const req = https.request(options, (res) => {
      let responseBody = '';
      res.on('data', (chunk) => { responseBody += chunk; });
      res.on('end', () => {
        if (res.statusCode === 200 || res.statusCode === 201) {
          console.log(`✅ Code sent to ${maskEmail(email)} via Mailjet`);
          resolve(true);
        } else {
          console.error(`Mailjet Error ${res.statusCode}: ${responseBody}`);
          resolve(false);
        }
      });
    });

    req.on('error', (e) => {
      console.error('Mailjet Request Failed:', e.message);
      resolve(false);
    });

    req.write(postData);
    req.end();
  });
}

// ==============================================
// 数据库初始化
// ==============================================
function initDatabase() {
  db = new sqlite3.Database(DB_PATH, (err) => {
    if (err) return console.error('Database connect failed:', err.message);
    console.log('Database connected at:', DB_PATH);

    db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        student_id TEXT UNIQUE NOT NULL,
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
      CREATE TABLE IF NOT EXISTS tasks (
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
      else {
        console.log('All tables initialized successfully');
        isDbReady = true;
      }
    });
  });
}

// ==============================================
// 路由接口
// ==============================================

app.post('/api/auth/send-code', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email || !isValidEmail(email)) return res.status(400).json({ success: false, message: 'Invalid email' });
    
    cleanExpiredCodes();
    const code = generateVerifyCode();
    const expireAt = Date.now() + VERIFY_CODE_EXPIRE_SECONDS * 1000;
    verifyCodeStore[email] = { code, expireAt };

    const emailSent = await sendVerifyEmail(email, code);
    if (!emailSent) return res.status(500).json({ success: false, message: 'Failed to send email via Mailjet. Check logs.' });

    res.json({ success: true, message: 'Verification code sent' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

app.post('/api/auth/register', async (req, res) => {
  try {
    const { student_id, first_name, given_name, gender, anonymous_name, phone, email, password, code } = req.body;
    cleanExpiredCodes();
    const record = verifyCodeStore[email];
    
    if (!record || record.code !== code) return res.status(400).json({ success: false, message: 'Invalid code' });
    delete verifyCodeStore[email];

    const hashedPwd = await bcrypt.hash(password, SALT_ROUNDS);
    db.run(`INSERT INTO users (student_id, first_name, given_name, gender, anonymous_name, phone, email, password)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [student_id, first_name, given_name, gender, anonymous_name, phone, email, hashedPwd],
      function (err) {
        if (err) return res.status(400).json({ success: false, message: 'User already exists or bad data' });
        res.json({ success: true, message: 'Registration successful' });
      }
    );
  } catch (err) { res.status(500).json({ success: false, message: 'Server error' }); }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { student_id, password } = req.body;
    db.get(`SELECT * FROM users WHERE student_id = ?`, [student_id], async (err, user) => {
      if (err || !user) return res.status(400).json({ success: false, message: 'User not exists' });
      const match = await bcrypt.compare(password, user.password);
      if (!match) return res.status(400).json({ success: false, message: 'Wrong password' });
      
      delete user.password;
      res.json({ success: true, user });
    });
  } catch (err) { res.status(500).json({ success: false, message: 'Server error' }); }
});

app.post('/api/user/profile', (req, res) => {
  const { student_id } = req.body;
  db.get(`SELECT * FROM users WHERE student_id = ?`, [student_id], (err, user) => {
    if (err || !user) return res.status(400).json({ success: false });
    delete user.password;
    res.json({ success: true, user });
  });
});

app.post('/api/task/create', (req, res) => {
  const { publisher_id, move_date, move_time, from_address, to_address, items_desc, people_needed, reward } = req.body;
  db.run(`INSERT INTO tasks (publisher_id, move_date, move_time, from_address, to_address, items_desc, people_needed, reward)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [publisher_id, move_date, move_time, from_address, to_address, items_desc, people_needed, reward],
    function (err) {
      if (err) return res.status(500).json({ success: false });
      res.json({ success: true, message: 'Request posted' });
    }
  );
});

app.get('/api/task/list', (req, res) => {
  db.all(`SELECT * FROM tasks WHERE status = 'pending' ORDER BY created_at DESC`, [], (err, rows) => {
    if (err) return res.status(500).json({ success: false });
    res.json({ success: true, list: rows });
  });
});

app.post('/api/task/my-published', (req, res) => {
  db.all(`SELECT * FROM tasks WHERE publisher_id = ? ORDER BY created_at DESC`, [req.body.student_id], (err, rows) => {
    if (err) return res.status(500).json({ success: false });
    res.json({ success: true, list: rows });
  });
});

app.post('/api/task/my-assigned', (req, res) => {
  db.all(`SELECT * FROM tasks WHERE helper_id = ? ORDER BY created_at DESC`, [req.body.student_id], (err, rows) => {
    if (err) return res.status(500).json({ success: false });
    res.json({ success: true, list: rows });
  });
});

app.post('/api/task/apply', (req, res) => {
  const { task_id, helper_id } = req.body;
  db.run(`UPDATE tasks SET status = 'assigned', helper_id = ? WHERE id = ? AND status = 'pending'`,
    [helper_id, task_id], function(err) {
      if (err || this.changes === 0) return res.status(400).json({ success: false, message: 'Apply failed' });
      res.json({ success: true, message: 'Task accepted' });
    }
  );
});

app.post('/api/task/cancel', (req, res) => {
  db.run(`UPDATE tasks SET status = 'cancelled' WHERE id = ?`, [req.body.task_id], function(err) {
      if (err) return res.status(500).json({ success: false });
      res.json({ success: true, message: 'Task cancelled' });
    }
  );
});

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Server running on 0.0.0.0:${PORT}`);
  setTimeout(() => {
    initDatabase();
  }, 1000);
});
