const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const bodyParser = require('body-parser');
const nodemailer = require('nodemailer');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

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

// 请求频率限制
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
// 1. 当用户访问根目录时，返回 index.html 页面
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// 2. 健康检查接口，用于查看后端状态
app.get('/api/health', (req, res) => {
  res.status(200).json({
    status: 'running',
    service: 'DormLift Ultimate Backend',
    version: '2.0.0',
    port: PORT,
    db_connected: isDbReady,
    timestamp: new Date().toISOString(),
    author: 'DormLift Team',
    api_base: '/api'
  });
});

// ==============================================
// 工具函数
// ==============================================
function isValidEmail(email) {
  const re = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
  return re.test(email);
}

function isValidPhone(phone) {
  const re = /^(\+?\d{1,4})?\s?\d{6,14}$/;
  return re.test(phone);
}

function isValidStudentId(studentId) {
  return /^[a-zA-Z0-9]{4,20}$/.test(studentId);
}

function generateVerifyCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function isUserLocked(studentId) {
  if (!userLock[studentId]) return false;
  return Date.now() < userLock[studentId];
}

function cleanExpiredCodes() {
  const now = Date.now();
  for (let email in verifyCodeStore) {
    if (verifyCodeStore[email].expireAt < now) {
      delete verifyCodeStore[email];
    }
  }
}

function cleanExpiredRateLimits() {
  const now = Date.now();
  for (let ip in rateLimit) {
    if (now - rateLimit[ip].time > RATE_LIMIT_WINDOW * 2) {
      delete rateLimit[ip];
    }
  }
}

function maskEmail(email) {
  if (!email) return '';
  let [name, domain] = email.split('@');
  if (name.length <= 2) return name + '***@' + domain;
  return name[0] + '***' + name[name.length-1] + '@' + domain;
}

// ==============================================
// 邮件发送（最终防卡死、防拒收版本）
// ==============================================
async function sendVerifyEmail(email, code) {
  if (!process.env.SMTP_EMAIL || !process.env.SMTP_PASSWORD) {
    console.log(`[EMAIL SIMULATE] To ${email}: Code ${code}`);
    return true;
  }

  try {
    let transporter = nodemailer.createTransport({
      host: 'smtp.office365.com',
      port: 587,
      secure: false, // 587 端口必须为 false，使用 STARTTLS
      requireTLS: true,
      auth: {
        user: process.env.SMTP_EMAIL,
        pass: process.env.SMTP_PASSWORD
      },
      tls: {
        // 忽略可能导致云服务器握手失败的证书链校验
        rejectUnauthorized: false
      },
      // 10秒超时控制，绝生死等
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 10000
    });

    await transporter.sendMail({
      from: `"DormLift Official" <${process.env.SMTP_EMAIL}>`,
      to: email,
      subject: 'Your DormLift Verification Code',
      text: `Your verification code is: ${code}\nValid for 5 minutes.\nDo not share it with others.`,
      html: `
        <div style="padding:24px;background:#f7f7f7;font-family:Arial,sans-serif;">
          <div style="max-width:500px;margin:auto;background:white;padding:24px;border-radius:12px;">
            <h2 style="color:#222;margin-top:0;">DormLift Verification</h2>
            <p>Hello,</p>
            <p>Your verification code is:</p>
            <div style="font-size:24px;font-weight:bold;color:#0066cc;padding:12px;text-align:center;background:#f0f7ff;border-radius:8px;margin:16px 0;">
              ${code}
            </div>
            <p>This code is valid for 5 minutes.</p>
            <p>If you did not request this, please ignore this email.</p>
            <br>
            <p>Best regards,</p>
            <p>DormLift Team</p>
          </div>
        </div>
      `
    });
    return true;
  } catch (err) {
    console.error('Send email failed:', err.message);
    return false;
  }
}

// ==============================================
// 数据库初始化
// ==============================================
function initDatabase() {
  db = new sqlite3.Database(DB_PATH, (err) => {
    if (err) {
      console.error('Database connect failed:', err.message);
      return;
    }
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
        avatar TEXT DEFAULT '',
        status TEXT DEFAULT 'active',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        publisher_id TEXT NOT NULL,
        move_date TEXT NOT NULL,
        move_time TEXT NOT NULL,
        from_address TEXT NOT NULL,
        to_address TEXT NOT NULL,
        items_desc TEXT NOT NULL,
        items_photo TEXT DEFAULT '',
        people_needed INTEGER NOT NULL,
        reward TEXT NOT NULL,
        note TEXT DEFAULT '',
        status TEXT DEFAULT 'pending' CHECK(status IN ('pending','assigned','completed','cancelled')),
        helper_id TEXT DEFAULT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS task_applications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER NOT NULL,
        helper_id TEXT NOT NULL,
        status TEXT DEFAULT 'pending' CHECK(status IN ('pending','accepted','rejected')),
        apply_time DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS user_tokens (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        student_id TEXT NOT NULL,
        token TEXT NOT NULL,
        expire_at DATETIME NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS system_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        content TEXT NOT NULL,
        ip TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
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

function writeLog(type, content, req) {
  const ip = req ? (req.ip || req.connection.remoteAddress) : null;
  db.run(`INSERT INTO system_logs (type, content, ip) VALUES (?, ?, ?)`,
    [type, content.substring(0, 500), ip], (err) => {
      if (err) console.error('Log write failed:', err.message);
    });
}

// ==============================================
// 用户认证接口
// ==============================================

app.post('/api/auth/send-code', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email || !isValidEmail(email)) {
      return res.status(400).json({ success: false, message: 'Invalid email format' });
    }
    cleanExpiredCodes();
    const code = generateVerifyCode();
    const expireAt = Date.now() + VERIFY_CODE_EXPIRE_SECONDS * 1000;
    verifyCodeStore[email] = { code, expireAt };

    const emailSent = await sendVerifyEmail(email, code);
    if (!emailSent && process.env.SMTP_EMAIL) {
       return res.status(500).json({ success: false, message: 'Failed to send email. Check SMTP settings or Railway logs.' });
    }

    writeLog('VERIFY_CODE_SENT', `Email: ${maskEmail(email)}`, req);
    res.json({ success: true, message: 'Verification code sent' });
  } catch (err) {
    writeLog('ERROR', 'Send code failed: ' + err.message, req);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

app.post('/api/auth/register', async (req, res) => {
  try {
    const {
      student_id, first_name, given_name, gender,
      anonymous_name, phone, email, password, code
    } = req.body;

    if (!student_id || !first_name || !given_name || !gender ||
        !anonymous_name || !phone || !email || !password || !code) {
      return res.status(400).json({ success: false, message: 'All fields are required' });
    }

    cleanExpiredCodes();
    const record = verifyCodeStore[email];
    if (!record || record.code !== code) {
      return res.status(400).json({ success: false, message: 'Invalid or expired code' });
    }
    delete verifyCodeStore[email];

    const hashedPwd = await bcrypt.hash(password, SALT_ROUNDS);

    db.run(`INSERT INTO users
      (student_id, first_name, given_name, gender, anonymous_name, phone, email, password)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [student_id, first_name, given_name, gender, anonymous_name, phone, email, hashedPwd],
      function (err) {
        if (err) {
          if (err.message.includes('UNIQUE')) {
            return res.status(400).json({ success: false, message: 'Student ID / Phone / Email already exists' });
          }
          return res.status(500).json({ success: false, message: 'Database error' });
        }
        res.json({ success: true, message: 'Registration successful' });
      }
    );
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { student_id, password } = req.body;
    if (!student_id || !password) {
      return res.status(400).json({ success: false, message: 'Please input student ID and password' });
    }

    if (isUserLocked(student_id)) {
      return res.status(403).json({ success: false, message: 'Account locked, try later' });
    }

    db.get(`SELECT * FROM users WHERE student_id = ?`, [student_id], async (err, user) => {
      if (err || !user) {
        return res.status(400).json({ success: false, message: 'User not exists' });
      }

      const match = await bcrypt.compare(password, user.password);
      if (!match) {
        loginAttempts[student_id] = (loginAttempts[student_id] || 0) + 1;
        if (loginAttempts[student_id] >= MAX_LOGIN_ATTEMPTS) {
          userLock[student_id] = Date.now() + LOCK_TIME_MINUTES * 60 * 1000;
        }
        return res.status(400).json({ success: false, message: 'Wrong password' });
      }

      loginAttempts[student_id] = 0;
      const token = generateToken();
      const tokenExpire = Date.now() + 7 * 24 * 60 * 60 * 1000;

      db.run(`INSERT INTO user_tokens (student_id, token, expire_at) VALUES (?, ?, ?)`,
        [student_id, token, tokenExpire]);

      delete user.password;
      res.json({ success: true, user, token });
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ==============================================
// 用户信息接口
// ==============================================
app.post('/api/user/profile', (req, res) => {
  const { student_id } = req.body;
  db.get(`SELECT * FROM users WHERE student_id = ?`, [student_id], (err, user) => {
    if (err || !user) return res.status(400).json({ success: false });
    delete user.password;
    res.json({ success: true, user });
  });
});

// ==============================================
// 任务接口
// ==============================================
app.post('/api/task/create', (req, res) => {
  try {
    const {
      publisher_id, move_date, move_time, from_address, to_address,
      items_desc, people_needed, reward
    } = req.body;

    if (!publisher_id || !move_date || !from_address || !to_address) {
      return res.status(400).json({ success: false, message: 'Missing required fields' });
    }

    db.run(`INSERT INTO tasks
      (publisher_id, move_date, move_time, from_address, to_address,
       items_desc, people_needed, reward)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [publisher_id, move_date, move_time || '', from_address, to_address,
       items_desc || '', people_needed || 1, reward || ''],
      function (err) {
        if (err) return res.status(500).json({ success: false, message: err.message });
        res.json({ success: true, message: 'Request posted successfully', task_id: this.lastID });
      }
    );
  } catch (err) {
    res.status(500).json({ success: false });
  }
});

app.get('/api/task/list', (req, res) => {
  db.all(`
    SELECT t.*, u.anonymous_name AS publisher_name
    FROM tasks t
    LEFT JOIN users u ON t.publisher_id = u.student_id
    WHERE t.status = 'pending'
    ORDER BY t.created_at DESC
  `, (err, rows) => {
    if (err) return res.status(500).json({ success: false });
    res.json({ success: true, list: rows });
  });
});

app.post('/api/task/my-published', (req, res) => {
  const { student_id } = req.body;
  db.all(`SELECT * FROM tasks WHERE publisher_id = ? ORDER BY created_at DESC`,
    [student_id], (err, rows) => {
      if (err) return res.status(500).json({ success: false });
      res.json({ success: true, list: rows });
    }
  );
});

app.post('/api/task/my-assigned', (req, res) => {
  const { student_id } = req.body;
  db.all(`SELECT * FROM tasks WHERE helper_id = ? ORDER BY created_at DESC`,
    [student_id], (err, rows) => {
      if (err) return res.status(500).json({ success: false });
      res.json({ success: true, list: rows });
    }
  );
});

app.post('/api/task/apply', (req, res) => {
  const { task_id, helper_id } = req.body;
  db.get(`SELECT * FROM tasks WHERE id = ? AND status = 'pending'`, [task_id], (err, task) => {
    if (err || !task) return res.status(400).json({ success: false, message: 'Task unavailable' });
    if (task.publisher_id === helper_id) return res.status(400).json({ success: false, message: 'Can not apply your own task' });

    db.run(`UPDATE tasks SET status = 'assigned', helper_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [helper_id, task_id], (err) => {
        if (err) return res.status(500).json({ success: false });
        res.json({ success: true, message: 'Task accepted successfully' });
      }
    );
  });
});

app.post('/api/task/cancel', (req, res) => {
  const { task_id } = req.body;
  db.run(`UPDATE tasks SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    [task_id], (err) => {
      if (err) return res.status(500).json({ success: false });
      res.json({ success: true, message: 'Task deleted/cancelled' });
    }
  );
});

// ==============================================
// 服务启动
// ==============================================
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Server running on 0.0.0.0:${PORT}`);
  setTimeout(() => {
    initDatabase();
    setInterval(cleanExpiredCodes, 60000);
    setInterval(cleanExpiredRateLimits, 5 * 60000);
  }, 1000);
});
