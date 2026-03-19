const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const path = require('path');
const bcrypt = require('bcryptjs');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 8080;
const DB_PATH = path.join(__dirname, 'dormlift.db');

// --- 1. Cloudinary 云存储配置 (使用你的专属 API) ---
cloudinary.config({ 
  cloud_name: 'ddlbhkmwb', 
  api_key: '659513524184184', 
  api_secret: 'iRTD1m-vPfaIu0DQ0uLUf4LUyLU' 
});

const storage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: {
    folder: 'dormlift_production',
    allowed_formats: ['jpg', 'png', 'jpeg'],
    public_id: (req, file) => Date.now() + '-' + file.originalname.split('.')[0],
  },
});
const upload = multer({ storage: storage });

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// --- 2. 数据库初始化 (全量 V9.0 字段) ---
const db = new sqlite3.Database(DB_PATH, () => {
    console.log('✅ Database Connected');
    db.serialize(() => {
        // 为了确保新旧字段不冲突，首次运行会重置表结构 (上线稳定后可移除 DROP)
        db.run("DROP TABLE IF EXISTS verify_codes");
        db.run("DROP TABLE IF EXISTS users");
        db.run("DROP TABLE IF EXISTS tasks");
        db.run("DROP TABLE IF EXISTS reviews");

        // 验证码表
        db.run(`CREATE TABLE verify_codes (email TEXT PRIMARY KEY, code TEXT, expire_at INTEGER)`);

        // 用户表 (10大核心字段 + 信誉分)
        db.run(`CREATE TABLE users (
            student_id TEXT PRIMARY KEY, school_name TEXT, first_name TEXT, given_name TEXT, 
            gender TEXT, anonymous_name TEXT, phone TEXT, email TEXT, password TEXT,
            rating_avg REAL DEFAULT 5.0, task_count INTEGER DEFAULT 0
        )`);

        // 任务表 (含电梯、重量、照片云链接)
        db.run(`CREATE TABLE tasks (
            id INTEGER PRIMARY KEY AUTOINCREMENT, publisher_id TEXT, helper_id TEXT,
            move_date TEXT, move_time TEXT, from_addr TEXT, to_addr TEXT, 
            items_desc TEXT, reward TEXT, has_elevator INTEGER, load_weight TEXT, 
            img_url TEXT, status TEXT DEFAULT 'pending', created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);

        // 评价表
        db.run(`CREATE TABLE reviews (
            id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER, from_id TEXT, to_id TEXT, score INTEGER, comment TEXT
        )`);
    });
});

// --- 3. 邮箱验证码服务 (对接 Google Apps Script) ---
function sendMail(email, code) {
    const data = JSON.stringify({ to: email, subject: 'DormLift Verification', html: `Your verification code is: <b>${code}</b>` });
    const req = https.request('https://script.google.com/macros/s/AKfycbzAE3Vyi5B1sdNM--P89E7UDO1VF03lmehb0S6N0tHlvtpvdadDGfyM7jswaUB-RZhU/exec', 
    { method: 'POST', headers: {'Content-Type': 'text/plain'} });
    req.on('error', (e) => console.error("Mail Error:", e.message));
    req.write(data); 
    req.end();
}

app.post('/api/auth/send-code', (req, res) => {
    const code = Math.floor(100000 + Math.random() * 900000).toString(); // 生成 6 位纯数字验证码
    // 验证码有效期设为 5 分钟 (300000 毫秒)
    db.run(`INSERT OR REPLACE INTO verify_codes VALUES (?, ?, ?)`, [req.body.email, code, Date.now() + 300000], (err) => {
        if (err) return res.status(500).json({ success: false });
        sendMail(req.body.email, code);
        console.log(`🔑 Verification Code for ${req.body.email}: ${code}`);
        res.json({ success: true });
    });
});

// --- 4. 身份验证 API (注册校验验证码) ---
app.post('/api/auth/register', async (req, res) => {
    const { student_id, email, code, password, school_name, first_name, given_name, gender, anonymous_name, phone } = req.body;
    
    // 校验邮箱验证码
    db.get(`SELECT * FROM verify_codes WHERE email = ?`, [email], async (err, row) => {
        if (!row || row.code !== code || Date.now() > row.expire_at) {
            return res.status(400).json({ success: false, message: 'Invalid or expired verification code' });
        }
        // 密码加密
        const hashed = await bcrypt.hash(password, 10);
        db.run(`INSERT INTO users (student_id, school_name, first_name, given_name, gender, anonymous_name, phone, email, password) VALUES (?,?,?,?,?,?,?,?,?)`,
            [student_id, school_name, first_name, given_name, gender, anonymous_name, phone, email, hashed], (err) => {
                if (err) return res.status(400).json({ success: false, message: 'User ID or Email already exists' });
                res.json({ success: true });
            });
    });
});

app.post('/api/auth/login', (req, res) => {
    db.get(`SELECT * FROM users WHERE student_id = ?`, [req.body.student_id], async (err, user) => {
        if (!user || !(await bcrypt.compare(req.body.password, user.password))) return res.status(400).json({ success: false });
        delete user.password; // 返回前端前剔除密码哈希值，确保安全
        res.json({ success: true, user });
    });
});

// --- 5. 任务与流转 API ---
app.post('/api/task/create', upload.single('task_image'), (req, res) => {
    const { publisher_id, move_date, move_time, from_addr, to_addr, items_desc, reward, has_elevator, load_weight } = req.body;
    const imgUrl = req.file ? req.file.path : ''; // Cloudinary 返回的永久 HTTPS 链接
    
    const sql = `INSERT INTO tasks (publisher_id, move_date, move_time, from_addr, to_addr, items_desc, reward, has_elevator, load_weight, img_url) VALUES (?,?,?,?,?,?,?,?,?,?)`;
    db.run(sql, [publisher_id, move_date, move_time, from_addr, to_addr, items_desc, reward, has_elevator, load_weight, imgUrl], (err) => {
        if (err) return res.status(500).json({ success: false });
        res.json({ success: true });
    });
});

// 获取大厅任务（联表查询发布者信誉分）
app.get('/api/task/all', (req, res) => {
    const sql = `SELECT t.*, u.anonymous_name as pub_name, u.rating_avg 
                 FROM tasks t JOIN users u ON t.publisher_id = u.student_id 
                 WHERE t.status = 'pending' ORDER BY t.id DESC`;
    db.all(sql, [], (err, rows) => res.json({ success: true, list: rows || [] }));
});

// 状态机更新（接单、确认送达）
app.post('/api/task/workflow', (req, res) => {
    const { task_id, status, helper_id } = req.body;
    let sql = helper_id ? `UPDATE tasks SET status = ?, helper_id = ? WHERE id = ?` : `UPDATE tasks SET status = ? WHERE id = ?`;
    let params = helper_id ? [status, helper_id, task_id] : [status, task_id];
    
    db.run(sql, params, (err) => {
        if (err) return res.status(500).json({ success: false });
        res.json({ success: true });
    });
});

// 评价计算与写入
app.post('/api/task/review', (req, res) => {
    const { task_id, to_id, score, comment } = req.body;
    db.serialize(() => {
        db.run(`UPDATE tasks SET status = 'reviewed' WHERE id = ?`, [task_id]);
        // 动态计算该用户的平均星级
        db.run(`UPDATE users SET task_count = task_count + 1, rating_avg = (rating_avg * task_count + ?) / (task_count + 1) WHERE student_id = ?`, [score, to_id]);
        res.json({ success: true });
    });
});

// --- 6. 用户资料与仪表盘 API ---
app.post('/api/user/profile', (req, res) => {
    db.get(`SELECT * FROM users WHERE student_id = ?`, [req.body.student_id], (err, row) => {
        if (row) delete row.password;
        res.json({ success: true, user: row });
    });
});

// 看板：查询我发布或我接受的所有任务
app.post('/api/user/dashboard', (req, res) => {
    const sql = `SELECT * FROM tasks WHERE publisher_id = ? OR helper_id = ? ORDER BY id DESC`;
    db.all(sql, [req.body.student_id, req.body.student_id], (err, rows) => {
        res.json({ success: true, list: rows || [] });
    });
});

app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Production Server running on ${PORT}`));
