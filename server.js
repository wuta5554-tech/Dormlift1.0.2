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

// --- 中间件 ---
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(__dirname));

// --- 数据库初始化与自动清理 ---
const db = new sqlite3.Database(DB_PATH, (err) => {
    console.log('✅ Production Database Connected');
    db.serialize(() => {
        /**
         * 🗑️ 历史数据重置 (仅在首次部署时保留)
         * 部署成功并完成第一次测试注册后，建议注释掉下面三行 DROP 语句
         */
        db.run("DROP TABLE IF EXISTS verify_codes");
        db.run("DROP TABLE IF EXISTS users");
        db.run("DROP TABLE IF EXISTS tasks");

        // 重新创建完整表结构
        db.run(`CREATE TABLE IF NOT EXISTS verify_codes (
            email TEXT PRIMARY KEY, 
            code TEXT, 
            expire_at INTEGER
        )`);
        
        db.run(`CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT, 
            student_id TEXT UNIQUE, 
            school_name TEXT,
            first_name TEXT, 
            given_name TEXT, 
            gender TEXT, 
            anonymous_name TEXT,
            phone TEXT UNIQUE, 
            email TEXT UNIQUE, 
            password TEXT, 
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);
        
        db.run(`CREATE TABLE IF NOT EXISTS tasks (
            id INTEGER PRIMARY KEY AUTOINCREMENT, 
            publisher_id TEXT, 
            move_date TEXT, 
            move_time TEXT,
            from_address TEXT, 
            to_address TEXT, 
            items_desc TEXT, 
            people_needed INTEGER, 
            reward TEXT, 
            status TEXT DEFAULT 'pending', 
            helper_id TEXT
        )`);
    });
});

// --- 邮件服务 ---
function sendMail(email, code) {
    const data = JSON.stringify({ to: email, subject: 'DormLift Code', html: `Code: <b>${code}</b>` });
    const req = https.request('https://script.google.com/macros/s/AKfycbzAE3Vyi5B1sdNM--P89E7UDO1VF03lmehb0S6N0tHlvtpvdadDGfyM7jswaUB-RZhU/exec', 
    { method: 'POST', headers: {'Content-Type': 'text/plain'} });
    req.write(data); req.end();
}

// --- 接口路由 ---

app.post('/api/auth/send-code', (req, res) => {
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    db.run(`INSERT OR REPLACE INTO verify_codes VALUES (?, ?, ?)`, [req.body.email, code, Date.now() + 300000], () => {
        sendMail(req.body.email, code);
        console.log(`🔑 Code for ${req.body.email}: ${code}`);
        res.json({ success: true });
    });
});

app.post('/api/auth/register', async (req, res) => {
    const { student_id, email, code, password, school_name, first_name, given_name, gender, anonymous_name, phone } = req.body;
    db.get(`SELECT * FROM verify_codes WHERE email = ?`, [email], async (err, row) => {
        if (!row || row.code !== code) return res.status(400).json({ success: false, message: 'Invalid code' });
        const hashed = await bcrypt.hash(password, 12);
        db.run(`INSERT INTO users (student_id, school_name, first_name, given_name, gender, anonymous_name, phone, email, password) VALUES (?,?,?,?,?,?,?,?,?)`,
            [student_id, school_name, first_name, given_name, gender, anonymous_name, phone, email, hashed], (err) => {
                if (err) return res.status(400).json({ success: false, message: 'ID or Phone exists' });
                res.json({ success: true });
            });
    });
});

app.post('/api/auth/login', (req, res) => {
    db.get(`SELECT * FROM users WHERE student_id = ?`, [req.body.student_id], async (err, user) => {
        if (!user || !(await bcrypt.compare(req.body.password, user.password))) return res.status(400).json({ success: false });
        delete user.password; res.json({ success: true, user });
    });
});

app.post('/api/user/profile', (req, res) => {
    db.get(`SELECT * FROM users WHERE student_id = ?`, [req.body.student_id], (err, user) => {
        if (user) { delete user.password; res.json({ success: true, user }); }
        else res.status(404).json({ success: false });
    });
});

app.get('/api/task/list', (req, res) => {
    db.all(`SELECT * FROM tasks WHERE status = 'pending' ORDER BY id DESC`, (err, rows) => res.json({ success: true, list: rows || [] }));
});

app.post('/api/task/create', (req, res) => {
    const { publisher_id, move_date, move_time, from_address, to_address, items_desc, people_needed, reward } = req.body;
    db.run(`INSERT INTO tasks (publisher_id, move_date, move_time, from_address, to_address, items_desc, people_needed, reward) VALUES (?,?,?,?,?,?,?,?)`,
        [publisher_id, move_date, move_time, from_address, to_address, items_desc, people_needed, reward], () => res.json({ success: true }));
});

app.post('/api/task/apply', (req, res) => {
    db.run(`UPDATE tasks SET status = 'assigned', helper_id = ? WHERE id = ?`, [req.body.helper_id, req.body.task_id], () => res.json({ success: true }));
});

app.post('/api/task/cancel', (req, res) => {
    db.run(`UPDATE tasks SET status = 'cancelled' WHERE id = ?`, [req.body.task_id], () => res.json({ success: true }));
});

app.post('/api/task/my-published', (req, res) => {
    db.all(`SELECT * FROM tasks WHERE publisher_id = ? ORDER BY id DESC`, [req.body.student_id], (err, rows) => res.json({ success: true, list: rows || [] }));
});

app.post('/api/task/my-assigned', (req, res) => {
    db.all(`SELECT * FROM tasks WHERE helper_id = ? ORDER BY id DESC`, [req.body.student_id], (err, rows) => res.json({ success: true, list: rows || [] }));
});

app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Production server logic active on port ${PORT}`));
