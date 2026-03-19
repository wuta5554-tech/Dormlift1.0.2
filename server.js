const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const bodyParser = require('body-parser');
const bcrypt = require('bcryptjs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 8080;
const DB_PATH = path.join(__dirname, 'dormlift_v5.db');

app.use(cors());
app.use(bodyParser.json());
app.use(express.static(__dirname));

const db = new sqlite3.Database(DB_PATH, (err) => {
    console.log('✅ DormLift V5 Ultra Engine Active');
    db.serialize(() => {
        // 🗑️ 首次运行清理（确保新字段生效）
        db.run("DROP TABLE IF EXISTS users");
        db.run("DROP TABLE IF EXISTS tasks");
        db.run("DROP TABLE IF EXISTS reviews");

        // 1. 用户表 (全量10字段)
        db.run(`CREATE TABLE users (
            student_id TEXT PRIMARY KEY, school_name TEXT, first_name TEXT, given_name TEXT, 
            gender TEXT, anonymous_name TEXT, phone TEXT, email TEXT, password TEXT,
            rating_avg REAL DEFAULT 5.0, task_count INTEGER DEFAULT 0
        )`);

        // 2. 任务表 (含标准化+地图+照片占位)
        db.run(`CREATE TABLE tasks (
            id INTEGER PRIMARY KEY AUTOINCREMENT, publisher_id TEXT, helper_id TEXT,
            move_date TEXT, move_time TEXT, from_addr TEXT, to_addr TEXT, 
            items_desc TEXT, reward TEXT, people_needed INTEGER,
            has_elevator INTEGER DEFAULT 0, load_weight TEXT, img_name TEXT,
            status TEXT DEFAULT 'pending', created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);

        // 3. 评价表
        db.run(`CREATE TABLE reviews (
            id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER, 
            from_id TEXT, to_id TEXT, score INTEGER, comment TEXT
        )`);
    });
});

// --- API 逻辑 ---

// 注册时确保所有字段写入
app.post('/api/auth/register', async (req, res) => {
    const { student_id, email, password, school_name, first_name, given_name, gender, anonymous_name, phone } = req.body;
    const hashed = await bcrypt.hash(password, 10);
    db.run(`INSERT INTO users (student_id, school_name, first_name, given_name, gender, anonymous_name, phone, email, password) VALUES (?,?,?,?,?,?,?,?,?)`,
        [student_id, school_name, first_name, given_name, gender, anonymous_name, phone, email, hashed], (err) => {
            if (err) return res.status(400).json({ success: false });
            res.json({ success: true });
        });
});

app.post('/api/auth/login', (req, res) => {
    db.get(`SELECT * FROM users WHERE student_id = ?`, [req.body.student_id], async (err, user) => {
        if (!user || !(await bcrypt.compare(req.body.password, user.password))) return res.status(400).json({ success: false });
        delete user.password; res.json({ success: true, user });
    });
});

app.get('/api/task/all', (req, res) => {
    db.all(`SELECT t.*, u.anonymous_name as pub_name, u.rating_avg FROM tasks t JOIN users u ON t.publisher_id = u.student_id WHERE t.status = 'pending' ORDER BY t.id DESC`, (err, rows) => res.json({ success: true, list: rows || [] }));
});

app.post('/api/task/create', (req, res) => {
    const { publisher_id, move_date, move_time, from_addr, to_addr, items_desc, reward, people_needed, has_elevator, load_weight, img_name } = req.body;
    db.run(`INSERT INTO tasks (publisher_id, move_date, move_time, from_addr, to_addr, items_desc, reward, people_needed, has_elevator, load_weight, img_name) VALUES (?,?,?,?,?,?,?,?,?,?,?)`, 
    [publisher_id, move_date, move_time, from_addr, to_addr, items_desc, reward, people_needed, has_elevator, load_weight, img_name], () => res.json({ success: true }));
});

app.post('/api/task/workflow', (req, res) => {
    const { task_id, status, helper_id } = req.body;
    let sql = `UPDATE tasks SET status = ? WHERE id = ?`;
    let params = [status, task_id];
    if(helper_id) { sql = `UPDATE tasks SET status = ?, helper_id = ? WHERE id = ?`; params = [status, helper_id, task_id]; }
    db.run(sql, params, () => res.json({ success: true }));
});

app.post('/api/task/review', (req, res) => {
    const { task_id, from_id, to_id, score, comment } = req.body;
    db.serialize(() => {
        db.run(`INSERT INTO reviews (task_id, from_id, to_id, score, comment) VALUES (?,?,?,?,?)`, [task_id, from_id, to_id, score, comment]);
        db.run(`UPDATE tasks SET status = 'reviewed' WHERE id = ?`, [task_id]);
        db.run(`UPDATE users SET task_count = task_count + 1, rating_avg = (rating_avg * task_count + ?) / (task_count + 1) WHERE student_id = ?`, [score, to_id]);
        res.json({ success: true });
    });
});

app.post('/api/user/dashboard', (req, res) => {
    db.all(`SELECT * FROM tasks WHERE publisher_id = ? OR helper_id = ? ORDER BY id DESC`, [req.body.student_id, req.body.student_id], (err, rows) => res.json({ success: true, list: rows || [] }));
});

app.post('/api/user/profile', (req, res) => {
    db.get(`SELECT * FROM users WHERE student_id = ?`, [req.body.student_id], (err, row) => res.json({ success: true, user: row }));
});

app.listen(PORT, '0.0.0.0', () => console.log(`🚀 V5 Server logic running on ${PORT}`));
