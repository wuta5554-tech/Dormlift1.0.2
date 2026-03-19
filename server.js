const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const bodyParser = require('body-parser');
const bcrypt = require('bcryptjs');
const path = require('path');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 8080;
const DB_PATH = path.join(__dirname, 'dormlift.db');

// 中间件配置
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(__dirname));

// ==========================================
// 1. 数据库初始化 (核心：字段完整，外键开启)
// ==========================================
const db = new sqlite3.Database(DB_PATH, (err) => {
    if (err) console.error("Database error:", err.message);
    console.log('✅ SQLite Connected');
    db.exec(`
        PRAGMA foreign_keys = ON;
        
        -- 验证码表
        CREATE TABLE IF NOT EXISTS verify_codes (
            email TEXT PRIMARY KEY, 
            code TEXT, 
            expire_at INTEGER
        );

        -- 用户表 (包含所有详细信息)
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT, 
            student_id TEXT UNIQUE NOT NULL, 
            school_name TEXT NOT NULL,
            first_name TEXT NOT NULL, 
            given_name TEXT NOT NULL, 
            gender TEXT NOT NULL, 
            anonymous_name TEXT NOT NULL,
            phone TEXT UNIQUE NOT NULL, 
            email TEXT UNIQUE NOT NULL, 
            password TEXT NOT NULL, 
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        -- 任务表
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
            status TEXT DEFAULT 'pending', 
            helper_id TEXT
        );
    `);
});

// ==========================================
// 2. 邮件发送工具 (Google Apps Script)
// ==========================================
function sendMail(email, code) {
    const data = JSON.stringify({ 
        to: email, 
        subject: 'DormLift Verification Code', 
        html: `<div style="padding:20px; border:1px solid #eee; border-radius:10px;">
                <h2 style="color:#3498db;">DormLift Verification</h2>
                <p>Your verification code is: <b style="font-size:24px; color:#2c3e50;">${code}</b></p>
                <p>Valid for 5 minutes. Do not share this with anyone.</p>
               </div>` 
    });
    const options = {
        hostname: 'script.google.com',
        path: '/macros/s/AKfycbzAE3Vyi5B1sdNM--P89E7UDO1VF03lmehb0S6N0tHlvtpvdadDGfyM7jswaUB-RZhU/exec',
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' }
    };
    const req = https.request(options);
    req.on('error', (e) => console.error("Mail error:", e.message));
    req.write(data);
    req.end();
}

// ==========================================
// 3. API 路由接口 (共 10 个，全面核对)
// ==========================================

// [1] 发送验证码
app.post('/api/auth/send-code', (req, res) => {
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expire = Date.now() + 300000;
    db.run(`INSERT OR REPLACE INTO verify_codes VALUES (?, ?, ?)`, [req.body.email, code, expire], (err) => {
        if (err) return res.status(500).json({ success: false });
        sendMail(req.body.email, code);
        console.log(`🔑 Code for ${req.body.email}: ${code}`);
        res.json({ success: true, message: 'Code sent!' });
    });
});

// [2] 用户注册
app.post('/api/auth/register', async (req, res) => {
    const { student_id, email, code, password, school_name, first_name, given_name, gender, anonymous_name, phone } = req.body;
    db.get(`SELECT * FROM verify_codes WHERE email = ?`, [email], async (err, row) => {
        if (!row || row.code !== code || Date.now() > row.expire_at) {
            return res.status(400).json({ success: false, message: 'Invalid or expired code' });
        }
        try {
            const hashed = await bcrypt.hash(password, 12);
            db.run(`INSERT INTO users (student_id, school_name, first_name, given_name, gender, anonymous_name, phone, email, password) VALUES (?,?,?,?,?,?,?,?,?)`,
                [student_id, school_name, first_name, given_name, gender, anonymous_name, phone, email, hashed], (err) => {
                    if (err) return res.status(400).json({ success: false, message: 'ID, Email or Phone already registered' });
                    res.json({ success: true, message: 'Registration successful!' });
                });
        } catch (e) { res.status(500).json({ success: false }); }
    });
});

// [3] 用户登录
app.post('/api/auth/login', (req, res) => {
    db.get(`SELECT * FROM users WHERE student_id = ?`, [req.body.student_id], async (err, user) => {
        if (!user || !(await bcrypt.compare(req.body.password, user.password))) {
            return res.status(400).json({ success: false, message: 'Invalid Student ID or Password' });
        }
        delete user.password; 
        res.json({ success: true, user });
    });
});

// [4] 获取完整个人资料 (用于 Profile 页刷新)
app.post('/api/user/profile', (req, res) => {
    db.get(`SELECT * FROM users WHERE student_id = ?`, [req.body.student_id], (err, user) => {
        if (user) { delete user.password; res.json({ success: true, user }); }
        else res.status(404).json({ success: false });
    });
});

// [5] 获取公开任务列表
app.get('/api/task/list', (req, res) => {
    db.all(`SELECT * FROM tasks WHERE status = 'pending' ORDER BY id DESC`, (err, rows) => {
        res.json({ success: true, list: rows || [] });
    });
});

// [6] 发布新任务
app.post('/api/task/create', (req, res) => {
    const { publisher_id, move_date, move_time, from_address, to_address, items_desc, people_needed, reward } = req.body;
    db.run(`INSERT INTO tasks (publisher_id, move_date, move_time, from_address, to_address, items_desc, people_needed, reward) VALUES (?,?,?,?,?,?,?,?)`,
        [publisher_id, move_date, move_time, from_address, to_address, items_desc, people_needed, reward], () => {
            res.json({ success: true, message: 'Task published!' });
        });
});

// [7] 接受任务 (接单)
app.post('/api/task/apply', (req, res) => {
    db.run(`UPDATE tasks SET status = 'assigned', helper_id = ? WHERE id = ? AND status = 'pending'`, 
    [req.body.helper_id, req.body.task_id], function(err) {
        if (this.changes === 0) return res.status(400).json({ success: false, message: 'Task already taken' });
        res.json({ success: true, message: 'Task accepted!' });
    });
});

// [8] 取消任务
app.post('/api/task/cancel', (req, res) => {
    db.run(`UPDATE tasks SET status = 'cancelled' WHERE id = ?`, [req.body.task_id], () => {
        res.json({ success: true, message: 'Task cancelled' });
    });
});

// [9] 获取我发布的任务
app.post('/api/task/my-published', (req, res) => {
    db.all(`SELECT * FROM tasks WHERE publisher_id = ? ORDER BY id DESC`, [req.body.student_id], (err, rows) => {
        res.json({ success: true, list: rows || [] });
    });
});

// [10] 获取我接受的任务
app.post('/api/task/my-assigned', (req, res) => {
    db.all(`SELECT * FROM tasks WHERE helper_id = ? ORDER BY id DESC`, [req.body.student_id], (err, rows) => {
        res.json({ success: true, list: rows || [] });
    });
});

// 启动服务器
app.listen(PORT, '0.0.0.0', () => {
    console.log(`
    ====================================
    🚀 DormLift Backend is Live!
    📍 Port: ${PORT}
    ====================================
    `);
});
