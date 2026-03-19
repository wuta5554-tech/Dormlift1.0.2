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

// --- 数据库初始化 (专业版字段对齐) ---
const db = new sqlite3.Database(DB_PATH, (err) => {
    console.log('✅ DormLift Production Database Connected');
    db.serialize(() => {
        /**
         * 🗑️ 历史数据重置：
         * 为了确保新增加的 'anonymous_name' 等字段生效，首次部署会清空旧表。
         * 成功注册第一个新账号后，建议注释掉下面三行。
         */
        db.run("DROP TABLE IF EXISTS verify_codes");
        db.run("DROP TABLE IF EXISTS users");
        db.run("DROP TABLE IF EXISTS tasks");

        // 1. 验证码表
        db.run(`CREATE TABLE IF NOT EXISTS verify_codes (email TEXT PRIMARY KEY, code TEXT, expire_at INTEGER)`);

        // 2. 用户表 (包含所有 10 个核心字段)
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

        // 3. 任务表 (增加创建时间用于排序)
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

// --- 邮件发送代理 (GAS) ---
function sendMail(email, code) {
    const data = JSON.stringify({ to: email, subject: 'DormLift Verification', html: `Your code: <b>${code}</b>` });
    const req = https.request('https://script.google.com/macros/s/AKfycbzAE3Vyi5B1sdNM--P89E7UDO1VF03lmehb0S6N0tHlvtpvdadDGfyM7jswaUB-RZhU/exec', 
    { method: 'POST', headers: {'Content-Type': 'text/plain'} });
    req.on('error', (e) => console.error("Mail Error:", e.message));
    req.write(data); req.end();
}

// --- API 接口路由 ---

// [注册第一步] 发送验证码
app.post('/api/auth/send-code', (req, res) => {
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expire = Date.now() + 300000; // 5分钟有效
    db.run(`INSERT OR REPLACE INTO verify_codes VALUES (?, ?, ?)`, [req.body.email, code, expire], (err) => {
        if (err) return res.status(500).json({ success: false });
        sendMail(req.body.email, code);
        console.log(`🔑 Verification Code for ${req.body.email}: ${code}`); // 调试用
        res.json({ success: true });
    });
});

// [注册第二步] 提交完整资料
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
                    if (err) return res.status(400).json({ success: false, message: 'ID or Phone already exists' });
                    res.json({ success: true });
                });
        } catch (e) { res.status(500).json({ success: false }); }
    });
});

// [登录]
app.post('/api/auth/login', (req, res) => {
    db.get(`SELECT * FROM users WHERE student_id = ?`, [req.body.student_id], async (err, user) => {
        if (!user || !(await bcrypt.compare(req.body.password, user.password))) {
            return res.status(400).json({ success: false, message: 'Wrong ID or Password' });
        }
        delete user.password; res.json({ success: true, user });
    });
});

// [获取 Profile] 实时刷新
app.post('/api/user/profile', (req, res) => {
    db.get(`SELECT * FROM users WHERE student_id = ?`, [req.body.student_id], (err, user) => {
        if (user) { delete user.password; res.json({ success: true, user }); }
        else res.status(404).json({ success: false });
    });
});

// [获取任务大厅列表]
app.get('/api/task/list', (req, res) => {
    db.all(`SELECT * FROM tasks WHERE status = 'pending' ORDER BY created_at DESC`, (err, rows) => {
        res.json({ success: true, list: rows || [] });
    });
});

// [发布任务]
app.post('/api/task/create', (req, res) => {
    const { publisher_id, move_date, move_time, from_address, to_address, items_desc, people_needed, reward } = req.body;
    db.run(`INSERT INTO tasks (publisher_id, move_date, move_time, from_address, to_address, items_desc, people_needed, reward) VALUES (?,?,?,?,?,?,?,?)`,
        [publisher_id, move_date, move_time, from_address, to_address, items_desc, people_needed, reward], () => {
            res.json({ success: true });
        });
});

// [接受任务]
app.post('/api/task/apply', (req, res) => {
    db.run(`UPDATE tasks SET status = 'assigned', helper_id = ? WHERE id = ?`, 
        [req.body.helper_id, req.body.task_id], () => res.json({ success: true }));
});

// [我的发布]
app.post('/api/task/my-published', (req, res) => {
    db.all(`SELECT * FROM tasks WHERE publisher_id = ? ORDER BY id DESC`, [req.body.student_id], (err, rows) => {
        res.json({ success: true, list: rows || [] });
    });
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 DormLift Professional Server running on port ${PORT}`);
});
