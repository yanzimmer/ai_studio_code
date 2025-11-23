const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const nodemailer = require('nodemailer');
const schedule = require('node-schedule');
const path = require('path');
const fs = require('fs');
const PENDING_FILE = path.join(__dirname, 'pending_emails.json');
const EMAIL_TEMPLATE_FILE = path.join(__dirname, 'email_template.html');
const { exec } = require('child_process');
const clients = new Set();

const app = express();
let config = {};
try {
    const raw = fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8');
    config = JSON.parse(raw);
} catch (e) {
    config = {};
}
const PORT = (config.server && config.server.port) || 3000;

// 中间件配置
app.use(cors()); // 允许前端跨域访问
app.use(bodyParser.json());

// --- 1. 邮箱发送配置 (关键) ---
// 这里以 Gmail 为例，如果你用 QQ/163 邮箱，请去邮箱设置开启 SMTP 服务并获取“授权码”
const smtp = config.smtp || {};
const resolvedHost = smtp.host && !/^\s*$/.test(String(smtp.host)) ? smtp.host : 'smtp.qq.com';
const resolvedPort = smtp.port != null ? Number(smtp.port) : (smtp.secure === false ? 587 : 465);
const resolvedSecure = resolvedPort === 465 ? true : false;
const transporter = nodemailer.createTransport({
    host: resolvedHost,
    port: resolvedPort,
    secure: resolvedSecure,
    auth: {
        user: smtp.auth && smtp.auth.user,
        pass: (smtp.auth && smtp.auth.pass) || process.env.SMTP_PASS
    }
});
console.log(`SMTP目标: ${resolvedHost}:${resolvedPort} secure=${resolvedSecure}`);

transporter.verify((error, success) => {
    if (error) {
        console.log('SMTP验证失败:', error);
    } else {
        console.log('SMTP连接正常');
    }
});

function loadPending() {
    try {
        const t = fs.readFileSync(PENDING_FILE, 'utf8');
        return JSON.parse(t || '[]');
    } catch (e) {
        return [];
    }
}

function savePending(list) {
    fs.writeFileSync(PENDING_FILE, JSON.stringify(list, null, 2));
}

function addPending(entry) {
    const list = loadPending();
    list.push(entry);
    savePending(list);
}

function removePending(id) {
    const list = loadPending().filter(x => x.id !== id);
    savePending(list);
    broadcastPendingUpdate();
}

function scheduleEntry(entry) {
    const str = entry.scheduledAt;
    const dt = str ? new Date(String(str).replace(' ', 'T')) : null;
    if (!dt || isNaN(dt)) { removePending(entry.id); return; }
    schedule.scheduleJob(dt, async function(){
        const ok = await sendEmail(entry.email, entry.msg, '定时送达');
        if (ok) removePending(entry.id);
    });
}

function broadcastPendingUpdate() {
    const payload = `data: update\n\n`;
    for (const res of clients) {
        try { res.write(payload); } catch (e) {}
    }
}

app.use(express.static(__dirname));
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'ai_studio_code.html'));
});

app.get('/api/smtp-info', (req, res) => {
    res.json({ host: resolvedHost, port: resolvedPort, secure: resolvedSecure, user: (smtp.auth && smtp.auth.user) ? 'configured' : 'missing' });
});

app.get('/api/smtp-verify', async (req, res) => {
    try {
        await transporter.verify();
        res.json({ success: true });
    } catch (e) {
        res.json({ success: false, code: e.code, message: String(e.message) });
    }
});

app.get('/api/pending-list', (req, res) => {
    res.json(loadPending());
});

app.get('/api/pending-events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders && res.flushHeaders();
    res.write(':\n\n');
    clients.add(res);
    req.on('close', () => { clients.delete(res); });
});

app.post('/api/pending-remove', (req, res) => {
    const { id } = req.body || {};
    if (!id) return res.json({ success: false });
    removePending(String(id));
    res.json({ success: true });
});

app.post('/api/pending-save', (req, res) => {
    const { msg, time, email } = req.body || {};
    const id = String(Date.now()) + '-' + Math.random().toString(36).slice(2, 8);
    const rawLocal = String(time || '').replace('T',' ').slice(0,16);
    const now = new Date();
    const y = now.getFullYear();
    const mo = String(now.getMonth() + 1).padStart(2,'0');
    const da = String(now.getDate()).padStart(2,'0');
    const h = String(now.getHours()).padStart(2,'0');
    const mi = String(now.getMinutes()).padStart(2,'0');
    const createdLocal = `${y}-${mo}-${da} ${h}:${mi}`;
    const entry = { id, email: email || '', msg: msg || '', scheduledAt: rawLocal, createdAt: createdLocal };
    addPending(entry);
    res.json({ success: true, id });
});

// --- 2. 接收提醒请求的接口 ---
app.post('/api/schedule-reminder', async (req, res) => {
    const { msg, time, email } = req.body;

    console.log(`收到请求: [${time}] 发送给 ${email} 内容: ${msg}`);

    if (!email || !email.includes('@')) {
        return res.status(400).json({ success: false, error: '邮箱格式无效' });
    }

    const parsed = time ? new Date(time.replace(' ', 'T')) : null;
    const targetDate = parsed && !isNaN(parsed) ? parsed : null;
    const now = new Date();

    if (!targetDate) {
        return res.status(400).json({ success: false, status: 'invalid_time' });
    }
    if (targetDate <= now) {
        return res.json({ success: false, status: 'expired' });
    } else {
        const scheduledAt = String(time || '').replace('T',' ').slice(0,16);
        const now = new Date();
        const y = now.getFullYear();
        const mo = String(now.getMonth() + 1).padStart(2,'0');
        const da = String(now.getDate()).padStart(2,'0');
        const h = String(now.getHours()).padStart(2,'0');
        const mi = String(now.getMinutes()).padStart(2,'0');
        const createdLocal = `${y}-${mo}-${da} ${h}:${mi}`;
        const entry = { id: String(Date.now()) + '-' + Math.random().toString(36).slice(2,8), email, msg, scheduledAt, createdAt: createdLocal };
        addPending(entry);
        scheduleEntry(entry);
        return res.json({ success: true, status: 'scheduled', pendingId: entry.id });
    }
});

// --- 3. 发送邮件的核心函数 ---
async function sendEmail(to, content, type) {
    const fromName = (config.mail && config.mail.fromName) || 'Motorola Beeper';
    const fromAddr = (config.mail && config.mail.fromAddress) || (smtp.auth && smtp.auth.user) || '';
    function esc(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
    const body = esc(content).replace(/\r?\n/g,'<br>');
    const toText = esc(to);
    const now = new Date();
    const y = now.getFullYear();
    const mo = String(now.getMonth() + 1).padStart(2,'0');
    const da = String(now.getDate()).padStart(2,'0');
    const h = String(now.getHours()).padStart(2,'0');
    const mi = String(now.getMinutes()).padStart(2,'0');
    const sentAt = `${y}-${mo}-${da} ${h}:${mi}`;
    let html = '';
    try {
        const tpl = fs.readFileSync(EMAIL_TEMPLATE_FILE, 'utf8');
        html = tpl.replace(/\{\{MSG_HTML\}\}/g, body).replace(/\{\{EMAIL\}\}/g, toText).replace(/\{\{TIM\}\}/g, esc(sentAt)).replace(/\{\{TYPE\}\}/g, esc(type||'Beeper'));
    } catch(e) {
        html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Motorola Beeper</title></head><body style="margin:0;background:#f4f5f7;padding:24px;">
    <div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e5e7eb;border-radius:16px;box-shadow:0 10px 30px rgba(0,0,0,0.08);overflow:hidden;">
      <div style="padding:14px 18px;border-bottom:1px solid #f1f5f9;display:flex;align-items:center;gap:8px;background:#fff;">
        <div style="font-weight:900;font-size:14px;letter-spacing:1px;color:#111;">MOTOROLA FLEX</div>
        <div style="margin-left:auto;font-size:12px;color:#9ca3af;">${esc(type||'Beeper')}</div>
      </div>
      <div style="padding:20px;display:flex;flex-direction:column;gap:14px;">
        <div style="display:flex;flex-direction:column;gap:6px;padding-bottom:10px;border-bottom:1px solid #f1f5f9;">
          <div style="font-size:12px;font-weight:700;color:#9ca3af;letter-spacing:1.5px;text-transform:uppercase;display:inline-flex;align-items:center;gap:6px;"><span style="width:8px;height:8px;border-radius:50%;background:#f59e0b;box-shadow:0 0 0 2px rgba(245,158,11,0.15);"></span>MSG</div>
          <div style="font-family:'Courier New',monospace;font-size:18px;color:#111;line-height:1.6;white-space:normal;word-break:break-word;background:rgba(0,0,0,0.03);padding:8px 12px;border-radius:8px;">${body}</div>
        </div>
        <div style="display:flex;flex-direction:column;gap:6px;padding-bottom:10px;border-bottom:1px solid #f1f5f9;">
          <div style="font-size:12px;font-weight:700;color:#9ca3af;letter-spacing:1.5px;text-transform:uppercase;display:inline-flex;align-items:center;gap:6px;"><span style="width:8px;height:8px;border-radius:50%;background:#8b5cf6;box-shadow:0 0 0 2px rgba(139,92,246,0.15);"></span>EMAIL</div>
          <div style="font-family:Verdana,Segoe UI,Arial,sans-serif;font-size:14px;color:#1f2937;">${toText}</div>
        </div>
        <div style="display:flex;flex-direction:column;gap:6px;">
          <div style="font-size:12px;font-weight:700;color:#9ca3af;letter-spacing:1.5px;text-transform:uppercase;display:inline-flex;align-items:center;gap:6px;"><span style="width:8px;height:8px;border-radius:50%;background:#10b981;box-shadow:0 0 0 2px rgba(16,185,129,0.15);"></span>TIM</div>
          <div style="font-family:Verdana,Segoe UI,Arial,sans-serif;font-size:14px;color:#1f2937;">${sentAt}</div>
        </div>
      </div>
    </div>
    </body></html>`;
    }
    const mailOptions = {
        from: `"${fromName}" <${fromAddr}>`,
        to: to,
        subject: '📟 Motorola Beeper',
        text: `[MSG]\n${String(content||'')}\n\n[EMAIL] ${String(to||'')}\n[TIM] ${sentAt}`,
        html
    };

    try {
        const info = await transporter.sendMail(mailOptions);
        console.log('邮件发送成功:', info.response);
        return true;
    } catch (error) {
        console.log('邮件发送失败:', error);
        return false;
    }
}

app.listen(PORT, () => {
    console.log(`Beeper Backend running on http://localhost:${PORT}`);
    const url = `http://localhost:${PORT}/`;
    if (process.platform === 'win32') {
        exec(`start "" "${url}"`);
    }
    const list = loadPending();
    let migrated = false;
    for (let i = 0; i < list.length; i++) {
        const e = list[i];
        // migrate legacy fields to scheduledAt
        if (!e.scheduledAt && e.localTime) { e.scheduledAt = e.localTime; delete e.localTime; migrated = true; }
        if (!e.scheduledAt && e.time) {
            const iso = new Date(e.time);
            if (!isNaN(iso)) {
                const y = iso.getFullYear();
                const mo = String(iso.getMonth() + 1).padStart(2, '0');
                const da = String(iso.getDate()).padStart(2, '0');
                const h = String(iso.getHours()).padStart(2, '0');
                const mi = String(iso.getMinutes()).padStart(2, '0');
                e.scheduledAt = `${y}-${mo}-${da} ${h}:${mi}`;
            }
            delete e.time; migrated = true;
        } else if (e.time) { delete e.time; migrated = true; }
        // normalize createdAt to local string
        if (e.createdAt && /Z$/.test(String(e.createdAt))) {
            const d = new Date(e.createdAt);
            if (!isNaN(d)) {
                const y = d.getFullYear();
                const mo = String(d.getMonth() + 1).padStart(2, '0');
                const da = String(d.getDate()).padStart(2, '0');
                const h = String(d.getHours()).padStart(2, '0');
                const mi = String(d.getMinutes()).padStart(2, '0');
                e.createdAt = `${y}-${mo}-${da} ${h}:${mi}`;
                migrated = true;
            }
        }
        const str = e.scheduledAt;
        const dt = str ? new Date(String(str).replace(' ', 'T')) : null;
        if (!dt || isNaN(dt)) { removePending(e.id); continue; }
        if (dt > new Date()) scheduleEntry(e); else { removePending(e.id); }
    }
    if (migrated) savePending(list);
});
