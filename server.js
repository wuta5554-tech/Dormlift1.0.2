const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const path = require('path');
const bcrypt = require('bcryptjs');

const app = express();
const PORT = process.env.PORT || 8080;
const DB_PATH = path.join(__dirname, 'dormlift_v8.db');

// --- 1. Cloudinary 配置 (你的凭据) ---
cloudinary.config({ 
  cloud_name: 'ddlbhkmwb', 
  api_key: '659513524184184', 
  api_secret: 'iRTD1m-vPfaIu0DQ0uLUf4LUyLU' 
});

const storage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: {
    folder: 'dormlift_v8',
    allowed_formats: ['jpg', 'png', 'jpeg'],
    public_id: (req, file) => Date.now() + '-' + file.originalname.split('.')[0],
  },
});
const upload = multer({ storage: storage });

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// --- 2. 数据库初始化 (确保 100% 字段对齐) ---
const db = new sqlite3.Database(DB_PATH, () => {
    db.serialize(() => {
        db.run("DROP TABLE IF EXISTS users");
        db.run("DROP TABLE IF EXISTS tasks");
        db.run("DROP TABLE IF EXISTS reviews");

        db.run(`CREATE TABLE users (
            student_id TEXT PRIMARY KEY, school_name TEXT, first_name TEXT, given_name TEXT, 
            gender TEXT, anonymous_name TEXT, phone TEXT, email TEXT, password TEXT,
            rating_avg REAL DEFAULT 5.0, task_count INTEGER DEFAULT 0
        )`);

        db.run(`CREATE TABLE tasks (
            id INTEGER PRIMARY KEY AUTOINCREMENT, publisher_id TEXT, helper_id TEXT,
            move_date TEXT, move_time TEXT, from_addr TEXT, to_addr TEXT, 
            items_desc TEXT, reward TEXT, has_elevator INTEGER, load_weight TEXT, 
            img_url TEXT, status TEXT DEFAULT 'pending', created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);

        db.run(`CREATE TABLE reviews (
            id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER, from_id TEXT, to_id TEXT, score INTEGER, comment TEXT
        )`);
    });
});

// --- 3. 核心 API ---

app.post('/api/auth/register', async (req, res) => {
    const { student_id, email, password, school_name, first_name, given_name, gender, anonymous_name, phone } = req.body;
    const hashed = await bcrypt.hash(password, 10);
    db.run(`INSERT INTO users (student_id, school_name, first_name, given_name, gender, anonymous_name, phone, email, password) VALUES (?,?,?,?,?,?,?,?,?)`,
        [student_id, school_name, first_name, given_name, gender, anonymous_name, phone, email, hashed], (err) => res.json({ success: !err }));
});

app.post('/api/auth/login', (req, res) => {
    db.get(`SELECT * FROM users WHERE student_id = ?`, [req.body.student_id], async (err, user) => {
        if (!user || !(await bcrypt.compare(req.body.password, user.password))) return res.status(400).json({ success: false });
        delete user.password; res.json({ success: true, user });
    });
});

app.post('/api/task/create', upload.single('task_image'), (req, res) => {
    const { publisher_id, move_date, move_time, from_addr, to_addr, items_desc, reward, has_elevator, load_weight } = req.body;
    const imgUrl = req.file ? req.file.path : '';
    const sql = `INSERT INTO tasks (publisher_id, move_date, move_time, from_addr, to_addr, items_desc, reward, has_elevator, load_weight, img_url) VALUES (?,?,?,?,?,?,?,?,?,?)`;
    db.run(sql, [publisher_id, move_date, move_time, from_addr, to_addr, items_desc, reward, has_elevator, load_weight, imgUrl], () => res.json({ success: true }));
});

app.get('/api/task/all', (req, res) => {
    db.all(`SELECT t.*, u.anonymous_name as pub_name, u.rating_avg FROM tasks t JOIN users u ON t.publisher_id = u.student_id WHERE t.status = 'pending' ORDER BY t.id DESC`, (err, rows) => res.json({ success: true, list: rows || [] }));
});

app.post('/api/task/workflow', (req, res) => {
    const { task_id, status, helper_id } = req.body;
    let sql = helper_id ? `UPDATE tasks SET status = ?, helper_id = ? WHERE id = ?` : `UPDATE tasks SET status = ? WHERE id = ?`;
    let params = helper_id ? [status, helper_id, task_id] : [status, task_id];
    db.run(sql, params, () => res.json({ success: true }));
});

app.post('/api/user/profile', (req, res) => {
    db.get(`SELECT * FROM users WHERE student_id = ?`, [req.body.student_id], (err, row) => res.json({ success: true, user: row }));
});

app.post('/api/user/dashboard', (req, res) => {
    db.all(`SELECT * FROM tasks WHERE publisher_id = ? OR helper_id = ? ORDER BY id DESC`, [req.body.student_id, req.body.student_id], (err, rows) => res.json({ success: true, list: rows || [] }));
});

app.listen(PORT, '0.0.0.0', () => console.log(`🚀 V8.0 Final Engine Active on ${PORT}`));
