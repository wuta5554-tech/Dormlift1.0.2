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

// --- 中间件配置 ---
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(__dirname));

// --- 数据库初始化与发布重置逻辑 ---
const db = new sqlite3.Database(DB_PATH, (err) => {
    if (err) console.error("Database connection error:", err.message);
    console.log('✅ DormLift Production Database Connected');
    
    db.serialize(() => {
        /**
         * 🗑️ 首次发布清理逻辑：
         * 部署成功并完成第一次“干净”的注册后，请务必注释掉或删除下面三行 DROP 语句。
         * 否则每次服务器重启（或重新部署）都会清空你的用户数据。
         */
        db.run("DROP TABLE IF EXISTS verify_codes");
        db.run("DROP TABLE IF EXISTS users");
        db.run("DROP TABLE IF EXISTS tasks");

        // [1] 验证码表
        db.run(`CREATE TABLE IF NOT EXISTS verify_codes (
            email TEXT PRIMARY KEY, 
            code TEXT, 
            expire_at INTEGER
        )`);

        // [2] 用户表 (包含所有 10 个核心字段)
        db.run(`CREATE TABLE IF NOT EXISTS users (
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
        )`);

        // [3] 任务表
        db.run(`CREATE TABLE IF NOT EXISTS tasks (
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
            helper_id TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);
    });
});

// --- 邮件发送服务 (GAS 代理) ---
function sendMail(email, code) {
    const data = JSON.stringify({ 
        to: email, 
        subject: 'DormLift Verification Code', 
        html: `<div style="padding:20px;border:1px solid #eee;border-radius:10px;font-family:sans-serif;">
                <h2 style="color:#3498db;">DormLift Verification</h2>
                <p>Welcome to the community! Your verification code is:</p>
                <p style="font-size:32px; font-weight:bold; color:#2c3e50; letter-spacing:5px;">${code}</p>
                <p style="color:#999;">Valid for 5 minutes.</p></div>` 
    });
    const options = {
        hostname: 'script.google.com',
        path: '/macros/s/AKfycbzAE3Vyi5B1sdNM--P89E7UDO1VF03lmehb0S6N0tHlvtpvdadDGfyM7jswaUB-RZhU/exec',
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' }
    };
    const req = https.request(options);
    req.on('error', (e) => console.error("Mail Proxy Error:", e.message));
    req.write(data);
    req.end();
}

// --- API 路由接口 ---

// 1. 发送验证码
app.post('/api/auth/send-code', (req, res) => {
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expire = Date.now() + 300000; // 5 mins
    db.run(`INSERT OR REPLACE INTO verify_codes VALUES (?, ?, ?)`, [req.body.email, code, expire], (err) => {
        if (err) return res.status(500).json({ success: false });
        sendMail(req.body.email, code);
        console.log(`🔑 Verification code for ${req.body.email}: ${code}`);
        res.json({ success: true, message: 'Code sent!' });
    });
});

// 2. 注册 (严格存入所有字段)
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
                    if (err) {
                        console.error("Reg DB Error:", err.message);
                        return res.status(400).json({ success: false, message: 'ID, Email or Phone already exists' });
                    }
                    res.json({ success: true, message: 'Registration successful!' });
                });
        } catch (e) { res.status(500).json({ success: false }); }
    });
});

// 3. 登录
app.post('/api/auth/login', (req, res) => {
    db.get(`SELECT * FROM users WHERE student_id = ?`, [req.body.student_id], async (err, user) => {
        if (!user || !(await bcrypt.compare(req.body.password, user.password))) {
            return res.status(400).json({ success: false, message: 'Invalid ID or Password' });
        }
        delete user.password; 
        res.json({ success: true, user });
    });
});

// 4. 获取完整个人资料 (用于 Profile 页面实时刷新数据)
app.post('/api/user/profile', (req, res) => {
    db.get(`SELECT * FROM users WHERE student_id = ?`, [req.body.student_id], (err, user) => {
        if (user) {
            delete user.password;
            res.json({ success: true, user });
        } else {
            res.status(404).json({ success: false, message: 'User not found' });
        }
    });
});

// 5. 任务大厅列表
app.get('/api/task/list', (req, res) => {
    db.all(`SELECT * FROM tasks WHERE status = 'pending' ORDER BY id DESC`, (err, rows) => {
        res.json({ success: true, list: rows || [] });
    });
});

// 6. 发布任务
app.post('/api/task/create', (req, res) => {
    const { publisher_id, move_date, move_time, from_address, to_address, items_desc, people_needed, reward } = req.body;
    db.run(`INSERT INTO tasks (publisher_id, move_date, move_time, from_address, to_address, items_desc, people_needed, reward) VALUES (?,?,?,?,?,?,?,?)`,
        [publisher_id, move_date, move_time, from_address, to_address, items_desc, people_needed, reward], () => {
            res.json({ success: true });
        });
});

// 7. 接受任务
app.post('/api/task/apply', (req, res) => {
    db.run(`UPDATE tasks SET status = 'assigned', helper_id = ? WHERE id = ? AND status = 'pending'`, 
        [req.body.helper_id, req.body.task_id], function(err) {
            if (this.changes === 0) return res.status(400).json({ success: false, message: 'Task already taken' });
            res.json({ success: true, message: 'Task accepted!' });
        });
});

// 8. 取消任务
app.post('/api/task/cancel', (req, res) => {
    db.run(`UPDATE tasks SET status = 'cancelled' WHERE id = ?`, [req.body.task_id], () => {
        res.json({ success: true });
    });
});

// 9. 我发布的任务
app.post('/api/task/my-published', (req, res) => {
    db.all(`SELECT * FROM tasks WHERE publisher_id = ? ORDER BY id DESC`, [req.body.student_id], (err, rows) => {
        res.json({ success: true, list: rows || [] });
    });
});

// 10. 我接下的任务
app.post('/api/task/my-assigned', (req, res) => {
    db.all(`SELECT * FROM tasks WHERE helper_id = ? ORDER BY id DESC`, [req.body.student_id], (err, rows) => {
        res.json({ success: true, list: rows || [] });
    });
});

// --- 服务器启动 ---
app.listen(PORT, '0.0.0.0', () => {
    console.log(`
    🚀 DormLift Backend Running!
    📍 Port: ${PORT}
    🏠 Database: ${DB_PATH}
    `);
});
