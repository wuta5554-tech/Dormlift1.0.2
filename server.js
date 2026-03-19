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
const DB_PATH = path.join(__dirname, 'dormlift_final.db');

// --- 1. Cloudinary 配置 (多图云存储) ---
cloudinary.config({ 
  cloud_name: 'ddlbhkmwb', 
  api_key: '659513524184184', 
  api_secret: 'iRTD1m-vPfaIu0DQ0uLUf4LUyLU' 
});

const storage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: {
    folder: 'dormlift_production',
    allowed_formats: ['jpg', 'png', 'jpeg', 'webp'],
    public_id: (req, file) => Date.now() + '-' + file.originalname.split('.')[0],
  },
});
const upload = multer({ storage: storage });

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// --- 2. 数据库初始化 (永久保留模式) ---
const db = new sqlite3.Database(DB_PATH, () => {
    console.log('✅ Database Connected & Permanent Storage Active');
    db.serialize(() => {
        // 验证码表
        db.run(`CREATE TABLE IF NOT EXISTS verify_codes (email TEXT PRIMARY KEY, code TEXT, expire_at INTEGER)`);
        // 用户表
        db.run(`CREATE TABLE IF NOT EXISTS users (
            student_id TEXT PRIMARY KEY, school_name TEXT, first_name TEXT, given_name TEXT, 
            gender TEXT, anonymous_name TEXT, phone TEXT, email TEXT, password TEXT,
            rating_avg REAL DEFAULT 5.0, task_count INTEGER DEFAULT 0
        )`);
        // 任务表
        db.run(`CREATE TABLE IF NOT EXISTS tasks (
            id INTEGER PRIMARY KEY AUTOINCREMENT, publisher_id TEXT, helper_id TEXT,
            move_date TEXT, move_time TEXT, from_addr TEXT, to_addr TEXT, 
            items_desc TEXT, reward TEXT, has_elevator INTEGER, load_weight TEXT, 
            img_url TEXT, status TEXT DEFAULT 'pending', created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);
        // 评价表
        db.run(`CREATE TABLE IF NOT EXISTS reviews (
            id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER, from_id TEXT, to_id TEXT, score INTEGER, comment TEXT
        )`);
    });
});

// --- 3. 邮件发送核心 ---
function sendMail(email, code) {
    const data = JSON.stringify({ to: email, subject: 'DormLift Verification', html: `Your verification code is: <b>${code}</b>. It expires in 5 minutes.` });
    const req = https.request('https://script.google.com/macros/s/AKfycbzAE3Vyi5B1sdNM--P89E7UDO1VF03lmehb0S6N0tHlvtpvdadDGfyM7jswaUB-RZhU/exec', 
    { method: 'POST', headers: {'Content-Type': 'text/plain'} });
    req.on('error', (e) => console.error("Mail Dispatch Error:", e.message));
    req.write(data); 
    req.end();
}

app.post('/api/auth/send-code', (req, res) => {
    const rawEmail = req.body.email;
    if (!rawEmail) return res.status(400).json({ success: false, message: 'Email required' });
    
    const email = rawEmail.trim().toLowerCase();
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    
    db.run(`INSERT OR REPLACE INTO verify_codes VALUES (?, ?, ?)`, [email, code, Date.now() + 300000], (err) => {
        if (err) return res.status(500).json({ success: false });
        sendMail(email, code);
        console.log(`🔑 Verification Sent -> ${email}: ${code}`);
        res.json({ success: true });
    });
});

// --- 4. 增强版：双模登录与注册逻辑 ---

app.post('/api/auth/register', async (req, res) => {
    let { student_id, email, code, password, school_name, first_name, given_name, gender, anonymous_name, phone } = req.body;
    
    // 安全防御：防空值 trim 报错
    const cleanID = (student_id || "").trim();
    const cleanEmail = (email || "").trim().toLowerCase();

    db.get(`SELECT * FROM verify_codes WHERE email = ?`, [cleanEmail], async (err, row) => {
        if (!row || row.code !== code || Date.now() > row.expire_at) {
            return res.status(400).json({ success: false, message: 'Invalid or expired code.' });
        }
        const hashed = await bcrypt.hash(password, 10);
        db.run(`INSERT INTO users (student_id, school_name, first_name, given_name, gender, anonymous_name, phone, email, password) VALUES (?,?,?,?,?,?,?,?,?)`,
            [cleanID, school_name, first_name, given_name, gender, anonymous_name, phone, cleanEmail, hashed], (err) => {
                if (err) return res.status(400).json({ success: false, message: 'Student ID or Email already exists.' });
                res.json({ success: true });
            });
    });
});

app.post('/api/auth/login', (req, res) => {
    const { mode, student_id, email, password, code } = req.body;

    if (mode === 'email') {
        // 模式 A：邮箱验证码登录
        const cleanEmail = (email || "").trim().toLowerCase();
        if (!cleanEmail) return res.status(400).json({ success: false, message: 'Email is required for this mode.' });

        db.get(`SELECT * FROM verify_codes WHERE email = ?`, [cleanEmail], (err, vRow) => {
            if (!vRow || vRow.code !== code || Date.now() > vRow.expire_at) {
                return res.status(400).json({ success: false, message: 'Invalid login code.' });
            }
            db.get(`SELECT * FROM users WHERE email = ?`, [cleanEmail], (err, user) => {
                if (!user) return res.status(400).json({ success: false, message: 'Email not registered.' });
                delete user.password;
                res.json({ success: true, user });
            });
        });
    } else {
        // 模式 B：学号密码登录
        const cleanID = (student_id || "").trim();
        if (!cleanID) return res.status(400).json({ success: false, message: 'Student ID is required.' });

        db.get(`SELECT * FROM users WHERE student_id = ?`, [cleanID], async (err, user) => {
            if (!user) return res.status(400).json({ success: false, message: 'Student ID not found.' });
            
            const isMatch = await bcrypt.compare(password, user.password);
            if (!isMatch) return res.status(400).json({ success: false, message: 'Wrong password.' });
            
            delete user.password;
            res.json({ success: true, user });
        });
    }
});

// --- 5. 任务管理 API (支持多图) ---

app.post('/api/task/create', upload.array('task_images', 5), (req, res) => {
    const { publisher_id, move_date, move_time, from_addr, to_addr, items_desc, reward, has_elevator, load_weight } = req.body;
    
    // 处理图片 URL 数组
    const imgUrls = JSON.stringify(req.files ? req.files.map(f => f.path) : []);
    
    const sql = `INSERT INTO tasks (publisher_id, move_date, move_time, from_addr, to_addr, items_desc, reward, has_elevator, load_weight, img_url) VALUES (?,?,?,?,?,?,?,?,?,?)`;
    db.run(sql, [publisher_id, move_date, move_time, from_addr, to_addr, items_desc, reward, has_elevator, load_weight, imgUrls], (err) => {
        if (err) return res.status(500).json({ success: false });
        res.json({ success: true });
    });
});

app.get('/api/task/all', (req, res) => {
    const sql = `SELECT t.*, u.anonymous_name as pub_name, u.rating_avg 
                 FROM tasks t JOIN users u ON t.publisher_id = u.student_id 
                 WHERE t.status = 'pending' ORDER BY t.id DESC`;
    db.all(sql, [], (err, rows) => res.json({ success: true, list: rows || [] }));
});

app.post('/api/task/workflow', (req, res) => {
    const { task_id, status, helper_id } = req.body;
    let sql = helper_id ? `UPDATE tasks SET status = ?, helper_id = ? WHERE id = ?` : `UPDATE tasks SET status = ? WHERE id = ?`;
    let params = helper_id ? [status, helper_id, task_id] : [status, task_id];
    db.run(sql, params, (err) => res.json({ success: !err }));
});

app.post('/api/task/review', (req, res) => {
    const { task_id, to_id, score, comment } = req.body;
    db.serialize(() => {
        db.run(`UPDATE tasks SET status = 'reviewed' WHERE id = ?`, [task_id]);
        db.run(`UPDATE users SET task_count = task_count + 1, rating_avg = (rating_avg * task_count + ?) / (task_count + 1) WHERE student_id = ?`, [score, to_id]);
        res.json({ success: true });
    });
});

// --- 6. 用户数据看板 API ---

app.post('/api/user/profile', (req, res) => {
    db.get(`SELECT * FROM users WHERE student_id = ?`, [req.body.student_id], (err, row) => {
        if (row) delete row.password;
        res.json({ success: true, user: row });
    });
});

app.post('/api/user/dashboard', (req, res) => {
    // 联查用户表，确保 dashboard 能拿到发布者昵称
    const sql = `SELECT t.*, u.anonymous_name as pub_name 
                 FROM tasks t JOIN users u ON t.publisher_id = u.student_id 
                 WHERE t.publisher_id = ? OR t.helper_id = ? ORDER BY t.id DESC`;
    db.all(sql, [req.body.student_id, req.body.student_id], (err, rows) => res.json({ success: true, list: rows || [] }));
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 DormLift V9.0 Final Engine running on port ${PORT}`);
});
