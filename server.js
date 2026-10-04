'use strict';
/* Glow Base backend — Node >= 22.13, không cần gói ngoài nào.
   Dữ liệu: Turso (SQLite trên mạng, có gói miễn phí) khi đặt TURSO_DATABASE_URL + TURSO_AUTH_TOKEN; không đặt thì dùng SQLite file cục bộ để chạy thử. */
const http = require('node:http'), fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { promisify } = require('node:util');
const scrypt = promisify(crypto.scrypt);

// ---- cấu hình (.env hoặc biến môi trường) ----
try { for (const l of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/)) { const m = l.match(/^\s*([A-Z_0-9]+)\s*=\s*(.*?)\s*$/); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^(["'])(.*)\1$/, '$2'); } } catch {}
const E = process.env, PORT = +E.PORT || 3000, PROD = E.NODE_ENV === 'production';
const ADMIN = (E.ADMIN_EMAIL || '').trim().toLowerCase();
const DATA = E.DATA_DIR || path.join(__dirname, 'data'), PUB = path.join(__dirname, 'public');
const TURSO_URL = (E.TURSO_DATABASE_URL || '').trim(), TURSO_TOKEN = (E.TURSO_AUTH_TOKEN || '').trim();
if (!TURSO_URL) fs.mkdirSync(DATA, { recursive: true });
const SECRET = E.APP_SECRET || crypto.randomBytes(32).toString('hex');
const IDLE = Math.max(1, +E.SESSION_IDLE_SEC || 900) * 1000; // 15 phút không thao tác → phải đăng nhập lại (chỉnh bằng SESSION_IDLE_SEC)
const SESSION_MAX = 30 * 864e5;                              // trần tuyệt đối của một phiên: 30 ngày
const SEED_MAX = 999999;                                      // concept có sẵn trong giao diện: id 1…999999; concept do MUA đăng: id ≥ 1000001 (do server cấp)
if (PROD && !TURSO_URL && !E.DATA_DIR) console.warn('[CẢNH BÁO] Chưa đặt TURSO_DATABASE_URL (hoặc DATA_DIR) → dữ liệu nằm trên ổ đĩa tạm của hosting và sẽ MẤT khi khởi động lại / deploy lại. Hãy tạo database Turso miễn phí và đặt TURSO_DATABASE_URL + TURSO_AUTH_TOKEN.');

// ---- database (Turso nếu có TURSO_DATABASE_URL, ngược lại SQLite file cục bộ) ----
const { openLocal, openTurso, isDup } = require('./db');
let db = null; // được gán trong main() trước khi server bắt đầu nhận kết nối
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users(email TEXT PRIMARY KEY, name TEXT NOT NULL, pass TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'user', avatar TEXT, created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS sessions(tok TEXT PRIMARY KEY, email TEXT NOT NULL REFERENCES users(email) ON DELETE CASCADE, exp INTEGER NOT NULL, max_exp INTEGER)`,
  `CREATE TABLE IF NOT EXISTS subs(id TEXT PRIMARY KEY, owner TEXT NOT NULL REFERENCES users(email), status TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '', submitted_at INTEGER NOT NULL, reviewed_at INTEGER, data TEXT NOT NULL, mid TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS mua_ids(id INTEGER PRIMARY KEY AUTOINCREMENT)`,
  `INSERT OR IGNORE INTO mua_ids(id) VALUES(1000000)`,
  `CREATE TABLE IF NOT EXISTS favs(email TEXT NOT NULL REFERENCES users(email) ON DELETE CASCADE, mid INTEGER NOT NULL, at INTEGER NOT NULL, PRIMARY KEY(email, mid))`,
  `CREATE TABLE IF NOT EXISTS reviews(id INTEGER PRIMARY KEY, mid INTEGER NOT NULL, owner TEXT NOT NULL REFERENCES users(email) ON DELETE CASCADE, rating INTEGER NOT NULL, comment TEXT NOT NULL, photos TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS reviews_mid ON reviews(mid)`,
  `CREATE TABLE IF NOT EXISTS removed(mid INTEGER PRIMARY KEY, at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS images(name TEXT PRIMARY KEY, mime TEXT NOT NULL, data BLOB NOT NULL, created_at INTEGER NOT NULL)`, // ảnh nằm trong database nên không mất khi hosting khởi động lại
];
async function initDb() {
  db = TURSO_URL ? openTurso(TURSO_URL, TURSO_TOKEN) : openLocal(path.join(DATA, 'glowbase.db'));
  await db.multi(SCHEMA.map(s => [s]));
  try { await db.run('ALTER TABLE sessions ADD COLUMN max_exp INTEGER'); } catch {} // database cũ (trước khi có cột này) — database mới đã có sẵn nên lỗi này bỏ qua được
  if (ADMIN) await db.run("UPDATE users SET role='admin' WHERE email=?", [ADMIN]);
}

// ---- tiện ích ----
const now = () => Date.now();
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const hmac = s => crypto.createHmac('sha256', SECRET).update(s).digest('hex');
const same = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const hashPw = async p => { const s = crypto.randomBytes(16); return s.toString('hex') + ':' + (await scrypt(p, s, 64)).toString('hex'); };
const checkPw = async (p, st) => { const [s, h] = st.split(':'); return same((await scrypt(p, Buffer.from(s, 'hex'), 64)).toString('hex'), h); };
class HttpErr extends Error { constructor(s, m) { super(m); this.s = s; } }
const bad = (m, s = 400) => new HttpErr(s, m);
const hits = new Map();
const over = (k, max, win) => (hits.get(k) || []).filter(x => now() - x < win).length >= max;
const hit = k => { const a = (hits.get(k) || []).filter(x => now() - x < 3600e3); a.push(now()); hits.set(k, a); };
setInterval(() => { const t = now(); for (const [k, a] of hits) if (!a.some(x => t - x < 3600e3)) hits.delete(k); if (db) db.multi([['DELETE FROM sessions WHERE exp<? OR (max_exp IS NOT NULL AND max_exp<?)', [t, t]]]).catch(() => {}); }, 600e3).unref();

// ---- làm sạch dữ liệu (chống XSS: giao diện render HTML thô nên server phải escape) ----
const unesc = s => String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const txt = (s, min, max, label) => { const raw = unesc(typeof s === 'string' ? s : '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim(); if (raw.length < min || raw.length > max) throw bad(`${label} cần từ ${min} đến ${max} ký tự.`); return esc(raw); };
const pick = (v, list, label) => { if (!list.includes(v)) throw bad(`${label} không hợp lệ.`); return v; };
const num = x => { const n = Math.floor(Number(x) || 0); if (n < 0 || n > 1e9) throw bad('Giá không hợp lệ.'); return n; };
const GMAIL = /^[a-z0-9][a-z0-9.]{4,28}[a-z0-9]@gmail\.com$/i;
const HREF = /^(https?:\/\/[^\s"'<>]+|tel:\+?\d{8,15}|mailto:[^\s"'<>@]+@[^\s"'<>@]+)$/i;
const CONCEPTS = ['Cô dâu', 'Đi tiệc', 'Kỉ yếu', 'Cosplay'], CTYPES = ['phone', 'facebook', 'instagram', 'tiktok', 'email', 'website'];
const MAGIC = { jpg: b => b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF, png: b => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])), webp: b => b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP' };
const fmt = x => x.toLocaleString('vi-VN');
async function cleanSub(d, prev) {
  if (!d || typeof d !== 'object') throw bad('Thiếu dữ liệu hồ sơ.');
  const out = { name: txt(d.name, 2, 80, 'Tên / nghệ danh'), bio: txt(d.bio || '', 0, 1000, 'Giới thiệu'), type: pick(d.type, ['Studio', 'Tại gia'], 'Loại hình'),
    province: txt(d.province, 2, 40, 'Tỉnh / thành'), address: txt(d.address, 6, 200, 'Địa chỉ') };
  if (d.svc) { out.svc = pick(d.svc, ['home', 'studio', 'both'], 'Dịch vụ'); out.mobile = out.svc !== 'studio'; } else out.mobile = !!d.mobile;
  if (!Array.isArray(d.contacts) || d.contacts.length < 1 || d.contacts.length > 8) throw bad('Cần 1–8 kênh liên hệ.');
  out.contacts = d.contacts.map(c => { c = c || {}; if (typeof c.href !== 'string' || !HREF.test(c.href)) throw bad('Liên kết liên hệ không hợp lệ.'); return { type: pick(c.type, CTYPES, 'Kênh liên hệ'), label: txt(c.label, 1, 100, 'Thông tin liên hệ'), href: c.href }; });
  if (!Array.isArray(d.concepts) || d.concepts.length < 1 || d.concepts.length > CONCEPTS.length) throw bad('Cần chọn ít nhất 1 concept.');
  const seen = new Set();
  out.concepts = d.concepts.map(c => { c = c || {}; const concept = pick(c.concept, CONCEPTS, 'Concept'); if (seen.has(concept)) throw bad('Concept bị trùng.'); seen.add(concept);
    const lo = num(c.lo), hi = num(c.hi); if (hi && hi < lo) throw bad('Giá “đến” phải ≥ giá “từ”.');
    if (!Array.isArray(c.photos) || c.photos.length < 1 || c.photos.length > 8) throw bad(`Concept “${concept}” cần 1–8 ảnh.`);
    return { concept, lo, hi, price: lo && hi ? `${fmt(lo)} - ${fmt(hi)}đ` : lo ? `Từ ${fmt(lo)}đ` : 'Contact', photos: c.photos }; });
  // mọi kiểm tra chữ đã qua → mới ghi ảnh vào database
  const flat = []; if (d.avatar) flat.push(d.avatar); out.concepts.forEach(c => flat.push(...c.photos));
  const urls = await savePhotos(flat); let i = 0;
  out.avatar = d.avatar ? urls[i++] : '';
  out.concepts.forEach(c => { c.photos = c.photos.map(() => urls[i++]); });
  const old = {}; if (prev) prev.data.concepts.forEach((c, k) => { old[c.concept] = prev.mid[k]; });
  const mid = []; for (const c of out.concepts) mid.push(old[c.concept] || (await db.run('INSERT INTO mua_ids DEFAULT VALUES')).lastId);
  return { data: out, mid };
}

// ---- ảnh: lưu thẳng trong database (bảng images), phục vụ qua /uploads/<tên> ----
const IMGP = /^\/uploads\/([a-f0-9]{32}\.(jpg|png|webp))$/;
const MIMES = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
function prepImg(s) { // chỉ kiểm tra, chưa ghi gì
  if (typeof s !== 'string') throw bad('Ảnh không hợp lệ.');
  const ex = s.match(IMGP); if (ex) return { url: s, name: ex[1], exists: true };
  const m = s.match(/^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/); if (!m) throw bad('Ảnh phải là JPG, PNG hoặc WebP.');
  const b = Buffer.from(m[2], 'base64'), ext = m[1] === 'jpeg' ? 'jpg' : m[1];
  if (b.length > 1.5e6) throw bad('Mỗi ảnh tối đa 1,5MB.'); if (!MAGIC[ext](b)) throw bad('Nội dung ảnh không hợp lệ.');
  const name = crypto.randomBytes(16).toString('hex') + '.' + ext; return { url: '/uploads/' + name, name, mime: MIMES[ext], buf: b };
}
const imgCache = new Map(); let imgBytes = 0; // bộ nhớ đệm nhỏ (≤ 40MB) để đỡ phải đọc database cho mỗi lượt xem ảnh
const forgetImg = name => { const c = imgCache.get(name); if (c) { imgBytes -= c.data.length; imgCache.delete(name); } };
async function getImg(name) {
  let c = imgCache.get(name); if (c) { imgCache.delete(name); imgCache.set(name, c); return c; }
  const r = await db.get('SELECT mime, data FROM images WHERE name=?', [name]); if (!r) return null;
  c = { mime: r.mime, data: Buffer.from(r.data) }; imgCache.set(name, c); imgBytes += c.data.length;
  while (imgBytes > 40e6 && imgCache.size > 1) forgetImg(imgCache.keys().next().value);
  return c;
}
const rmImg = async name => { forgetImg(name); await db.run('DELETE FROM images WHERE name=?', [name]); };
async function savePhotos(list) { // lưu tất cả ảnh hoặc không ảnh nào (lỗi giữa chừng thì xoá các ảnh mới đã ghi)
  const preps = list.map(prepImg), fresh = preps.filter(p => !p.exists);
  const work = async p => { if (p.exists) { if (!(await db.get('SELECT 1 AS x FROM images WHERE name=?', [p.name]))) throw bad('Ảnh không tồn tại.'); } else await db.run('INSERT INTO images VALUES(?,?,?,?)', [p.name, p.mime, p.buf, now()]); };
  let err = null;
  for (let i = 0; i < preps.length && !err; i += 6) { const f = (await Promise.allSettled(preps.slice(i, i + 6).map(work))).find(r => r.status === 'rejected'); if (f) err = f.reason; }
  if (err) { await Promise.allSettled(fresh.map(p => rmImg(p.name))); throw err; }
  return preps.map(p => p.url);
}
const imgInUse = async p => { const [a, b, c] = await db.multi([['SELECT 1 AS x FROM subs WHERE data LIKE ? LIMIT 1', ['%' + p + '%']], ['SELECT 1 AS x FROM reviews WHERE photos LIKE ? LIMIT 1', ['%' + p + '%']], ['SELECT 1 AS x FROM users WHERE avatar=? LIMIT 1', [p]]]); return a.rows.length + b.rows.length + c.rows.length > 0; };
async function dropImgs(list) { // xoá ảnh không còn hồ sơ / đánh giá / avatar nào dùng
  const ps = [...new Set(list)].filter(p => typeof p === 'string' && IMGP.test(p)), used = await Promise.all(ps.map(imgInUse));
  await Promise.all(ps.filter((_, i) => !used[i]).map(p => rmImg(p.match(IMGP)[1])));
}
const cleanImgs = list => dropImgs(list).catch(e => console.error('Dọn ảnh lỗi:', e.message)); // dọn dẹp thất bại không được làm hỏng thao tác chính
const subImgs = d => [d.avatar, ...d.concepts.flatMap(c => c.photos)].filter(Boolean);
const toInt = (x, label = 'Mã') => { const n = Number(x); if (!Number.isInteger(n) || n < 1) throw bad(`${label} không hợp lệ.`); return n; };

// ---- concept còn hiển thị: concept có sẵn chưa bị admin xoá, hoặc concept của hồ sơ MUA đang ở trạng thái "đã duyệt" ----
async function liveCheck() {
  const [rm, ap] = await db.multi([['SELECT mid FROM removed'], ["SELECT mid FROM subs WHERE status='approved'"]]);
  const gone = new Set(rm.rows.map(r => r.mid)), ok = new Set(); for (const r of ap.rows) for (const m of JSON.parse(r.mid)) ok.add(m);
  return m => m >= 1 && !gone.has(m) && (m <= SEED_MAX || ok.has(m));
}

// ---- yêu thích & đánh giá ----
const favsOf = async email => (await db.all('SELECT mid FROM favs WHERE email=? ORDER BY at', [email])).map(r => r.mid);
const getRev = id => db.get('SELECT r.*, u.name AS owner_name FROM reviews r JOIN users u ON u.email=r.owner WHERE r.id=?', [id]);
const revOut = (r, v) => ({ id: r.id, muaId: r.mid, userId: v && v.email === r.owner ? r.owner : 'u_' + sha(r.owner).slice(0, 8), userName: r.owner_name, rating: r.rating, comment: r.comment,
  photos: JSON.parse(r.photos), date: new Date(r.updated_at + 7 * 3600e3).toISOString().slice(0, 10) });
function cleanReview(b) { // kiểm tra chữ trước, ghi ảnh sau
  const rating = Number(b.rating); if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw bad('Vui lòng chọn từ 1 đến 5 sao.');
  const comment = txt(b.comment, 1, 2000, 'Nhận xét'), photos = b.photos === undefined ? [] : b.photos;
  if (!Array.isArray(photos) || photos.length > 6) throw bad('Mỗi đánh giá tối đa 6 ảnh.');
  return { rating, comment, photos };
}

// ---- mô hình trả về ----
const pubUser = u => ({ email: u.email, name: u.name, role: u.role, avatar: u.avatar || '' });
const getSub = id => db.get('SELECT s.*, u.name AS owner_name FROM subs s JOIN users u ON u.email=s.owner WHERE s.id=?', [id]);
const subOut = (r, v) => { const own = v && (v.role === 'admin' || v.email === r.owner);
  return { id: r.id, owner: own ? r.owner : 'u_' + sha(r.owner).slice(0, 8), ownerName: own ? r.owner_name : '', status: r.status, reason: r.reason, submittedAt: r.submitted_at, reviewedAt: r.reviewed_at || undefined, mid: JSON.parse(r.mid), data: JSON.parse(r.data) }; };

// ---- session ----
const cookie = (req, n) => { const m = (req.headers.cookie || '').match(new RegExp('(?:^|;\\s*)' + n + '=([0-9a-f]+)')); return m ? m[1] : null; };
const setCookie = (res, v, age) => res.setHeader('Set-Cookie', `gb_sid=${v}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${age}${PROD ? '; Secure' : ''}`);
// phiên trượt: mỗi request hợp lệ kéo hạn thêm IDLE (chỉ ghi database khi đã trôi qua ≥ min(60s, IDLE/4) để tiết kiệm lượt ghi của gói miễn phí);
// quá IDLE không có request nào (client tự gửi "ping" khi người dùng còn thao tác) thì hết phiên. Cả hai câu lệnh đi chung MỘT lượt gọi mạng.
const userOf = async req => {
  const t = cookie(req, 'gb_sid'); if (!t) return null;
  const k = sha(t), t0 = now(), slack = Math.min(60e3, IDLE / 4);
  const [, s] = await db.multi([
    ['UPDATE sessions SET exp=? WHERE tok=? AND exp>? AND exp<? AND (max_exp IS NULL OR max_exp>?)', [t0 + IDLE, k, t0, t0 + IDLE - slack, t0]],
    ['SELECT u.* FROM sessions s JOIN users u ON u.email=s.email WHERE s.tok=? AND s.exp>? AND (s.max_exp IS NULL OR s.max_exp>?)', [k, t0, t0]]]);
  return s.rows[0] || null;
};
// cookie sống 30 ngày để tải lại trang / đóng mở trình duyệt vẫn còn đăng nhập; việc hết phiên do không thao tác do server quyết định
const startSession = async (res, email) => { const t = crypto.randomBytes(32).toString('hex'), t0 = now(); await db.run('INSERT INTO sessions(tok,email,exp,max_exp) VALUES(?,?,?,?)', [sha(t), email, t0 + IDLE, t0 + SESSION_MAX]); setCookie(res, t, SESSION_MAX / 1000); };

// ---- API ----
const R = [];
const route = (m, p, fn, o = {}) => R.push({ m, o, fn, re: new RegExp('^' + p.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$') });

route('GET', '/api/health', () => ({ ok: true, db: db.kind }));
route('GET', '/api/boot', async ({ u }) => { // người dùng hiện tại + hồ sơ MUA được phép thấy + đánh giá + yêu thích + concept đã bị xoá — tất cả trong MỘT lượt gọi database
  const reqs = [u && u.role === 'admin' ? ['SELECT s.*, x.name AS owner_name FROM subs s JOIN users x ON x.email=s.owner ORDER BY submitted_at DESC']
      : ["SELECT s.*, x.name AS owner_name FROM subs s JOIN users x ON x.email=s.owner WHERE s.status='approved' OR s.owner=? ORDER BY submitted_at DESC", [u ? u.email : '']],
    ['SELECT r.*, x.name AS owner_name FROM reviews r JOIN users x ON x.email=r.owner ORDER BY r.id'], ['SELECT mid FROM removed']];
  if (u) reqs.push(['SELECT mid FROM favs WHERE email=? ORDER BY at', [u.email]]);
  const [sr, rr, mr, fr] = await db.multi(reqs);
  const gone = new Set(mr.rows.map(r => r.mid)), ok = new Set(); for (const r of sr.rows) if (r.status === 'approved') for (const m of JSON.parse(r.mid)) ok.add(m);
  const live = m => m >= 1 && !gone.has(m) && (m <= SEED_MAX || ok.has(m));
  return { user: u ? pubUser(u) : null, subs: sr.rows.map(r => subOut(r, u)), idleMs: IDLE, favs: fr ? fr.rows.map(r => r.mid) : [], reviews: rr.rows.filter(r => live(r.mid)).map(r => revOut(r, u)), removed: [...gone] }; });

route('POST', '/api/auth/register', async ({ res, body, ip }) => {
  const name = txt(body.name, 2, 60, 'Tên hiển thị'), email = String(body.email || '').trim().toLowerCase(), pw = String(body.password || '');
  if (!GMAIL.test(email) || email.includes('..')) throw bad('Vui lòng nhập địa chỉ Gmail hợp lệ (dạng tenban@gmail.com).');
  if (pw.length < 8 || pw.length > 128 || !/[A-Za-z]/.test(pw) || !/\d/.test(pw)) throw bad('Mật khẩu cần ít nhất 8 ký tự, gồm cả chữ và số.');
  if (over('reg:' + ip, 10, 3600e3)) throw bad('Bạn thao tác quá nhiều lần, hãy thử lại sau.', 429);
  hit('reg:' + ip);
  // Gmail bỏ qua dấu chấm: a.b@gmail.com và ab@gmail.com là cùng một hộp thư → coi là cùng 1 email
  if (await db.get("SELECT 1 AS x FROM users WHERE REPLACE(email,'.','')=?", [email.replace(/\./g, '')])) throw bad('Gmail này đã được đăng ký.', 409);
  try { await db.run('INSERT INTO users VALUES(?,?,?,?,NULL,?)', [email, name, await hashPw(pw), email === ADMIN ? 'admin' : 'user', now()]); } catch (e) { if (isDup(e)) throw bad('Gmail này đã được đăng ký.', 409); throw e; }
  await startSession(res, email);
  return { user: pubUser(await db.get('SELECT * FROM users WHERE email=?', [email])) }; });

route('POST', '/api/auth/login', async ({ res, body, ip }) => {
  const id = String(body.identifier || '').trim().toLowerCase(), pw = String(body.password || '');
  if (over('log:' + ip, 20, 900e3) || over('logid:' + id, 8, 900e3)) throw bad('Bạn đăng nhập sai quá nhiều lần. Hãy đợi 15 phút.', 429);
  const u = await db.get('SELECT * FROM users WHERE email=?', [id]), ok = u ? await checkPw(pw, u.pass) : (await hashPw(pw), false);
  if (!ok) { hit('log:' + ip); hit('logid:' + id); throw bad('Sai tài khoản hoặc mật khẩu.', 401); }
  await startSession(res, u.email); return { user: pubUser(u) }; });

route('POST', '/api/auth/logout', async ({ req, res }) => { const t = cookie(req, 'gb_sid'); if (t) await db.run('DELETE FROM sessions WHERE tok=?', [sha(t)]); setCookie(res, '', 0); return { ok: true }; });

route('PUT', '/api/me', async ({ u, body }) => {
  for (const k of ['email', 'username', 'id']) if (body[k] !== undefined && String(body[k]).trim().toLowerCase() !== u.email) throw bad('Tên đăng nhập chính là Gmail bạn đã đăng ký nên không thể thay đổi.');
  const name = body.name !== undefined ? txt(body.name, 2, 60, 'Tên hiển thị') : u.name;
  const avatar = body.avatar === undefined ? u.avatar : body.avatar ? (await savePhotos([body.avatar]))[0] : null;
  await db.run('UPDATE users SET name=?, avatar=? WHERE email=?', [name, avatar, u.email]);
  if (u.avatar && u.avatar !== avatar) await cleanImgs([u.avatar]);
  return { user: pubUser(await db.get('SELECT * FROM users WHERE email=?', [u.email])) }; }, { auth: 1 });

route('POST', '/api/me/password', async ({ req, u, body }) => {
  if (over('pw:' + u.email, 5, 900e3)) throw bad('Bạn thử quá nhiều lần, hãy đợi 15 phút.', 429);
  const o = String(body.old || ''), n = String(body.new || '');
  if (!(await checkPw(o, u.pass))) { hit('pw:' + u.email); throw bad('Mật khẩu hiện tại chưa đúng.', 403); }
  if (n.length < 6 || n.length > 128) throw bad('Mật khẩu mới cần từ 6 đến 128 ký tự.'); if (n === o) throw bad('Mật khẩu mới phải khác mật khẩu hiện tại.');
  await db.tx([['UPDATE users SET pass=? WHERE email=?', [await hashPw(n), u.email]], ['DELETE FROM sessions WHERE email=? AND tok<>?', [u.email, sha(cookie(req, 'gb_sid'))]]]); return { ok: true }; }, { auth: 1 });

route('POST', '/api/submissions', async ({ u, body }) => {
  if (over('sub:' + u.email, 10, 3600e3)) throw bad('Bạn gửi hồ sơ quá nhiều lần, hãy thử lại sau.', 429);
  if ((await db.get('SELECT COUNT(*) AS n FROM subs WHERE owner=?', [u.email])).n >= 10) throw bad('Mỗi tài khoản tối đa 10 hồ sơ.', 403);
  hit('sub:' + u.email); const { data, mid } = await cleanSub(body.data, null), id = 'S' + crypto.randomBytes(6).toString('hex');
  await db.run("INSERT INTO subs(id,owner,status,submitted_at,data,mid) VALUES(?,?, 'pending', ?,?,?)", [id, u.email, now(), JSON.stringify(data), JSON.stringify(mid)]);
  return { sub: subOut(await getSub(id), u) }; }, { auth: 1 });

route('PUT', '/api/submissions/:id', async ({ u, params, body }) => {
  const r = await getSub(params.id); if (!r || r.owner !== u.email) throw bad('Không tìm thấy hồ sơ.', 404);
  if (over('sub:' + u.email, 10, 3600e3)) throw bad('Bạn gửi hồ sơ quá nhiều lần, hãy thử lại sau.', 429); hit('sub:' + u.email);
  const prev = JSON.parse(r.data), { data, mid } = await cleanSub(body.data, { data: prev, mid: JSON.parse(r.mid) });
  await db.run("UPDATE subs SET data=?, mid=?, status='pending', reason='', submitted_at=?, reviewed_at=NULL WHERE id=?", [JSON.stringify(data), JSON.stringify(mid), now(), r.id]);
  const keep = new Set(subImgs(data)); await cleanImgs(subImgs(prev).filter(p => !keep.has(p)));
  return { sub: subOut(await getSub(r.id), u) }; }, { auth: 1 });

const review = act => async ({ u, params, body }) => {
  const r = await getSub(params.id); if (!r) throw bad('Không tìm thấy hồ sơ.', 404);
  if (act === 'approve') await db.run("UPDATE subs SET status='approved', reason='', reviewed_at=? WHERE id=?", [now(), r.id]);
  else if (act === 'reject') await db.run("UPDATE subs SET status='rejected', reason=?, reviewed_at=? WHERE id=?", [txt(body.reason, 5, 300, 'Lý do từ chối'), now(), r.id]);
  else await db.run("UPDATE subs SET status='rejected', reason='Hồ sơ đã được gỡ xuống bởi quản trị viên.', reviewed_at=? WHERE id=?", [now(), r.id]);
  return { sub: subOut(await getSub(r.id), u) };
};
for (const a of ['approve', 'reject', 'unpublish']) route('POST', `/api/admin/submissions/:id/${a}`, review(a), { admin: 1 });

route('POST', '/api/session/ping', () => ({ ok: true, idleMs: IDLE }), { auth: 1 }); // userOf đã gia hạn phiên; client gọi khi người dùng còn thao tác

// ---- yêu thích ----
route('GET', '/api/favorites', async ({ u }) => ({ favs: await favsOf(u.email) }), { auth: 1 });
route('PUT', '/api/favorites/:mid', async ({ u, params }) => {
  const mid = toInt(params.mid, 'Mã concept'); if (!(await liveCheck())(mid)) throw bad('Concept này không còn tồn tại.', 404);
  if (over('fav:' + u.email, 120, 600e3)) throw bad('Bạn thao tác quá nhanh, hãy thử lại sau ít phút.', 429); hit('fav:' + u.email);
  if ((await db.get('SELECT COUNT(*) AS n FROM favs WHERE email=?', [u.email])).n >= 500) throw bad('Danh sách yêu thích tối đa 500 concept.', 403);
  await db.run('INSERT OR IGNORE INTO favs VALUES(?,?,?)', [u.email, mid, now()]); return { favs: await favsOf(u.email) }; }, { auth: 1 });
route('DELETE', '/api/favorites/:mid', async ({ u, params }) => {
  await db.run('DELETE FROM favs WHERE email=? AND mid=?', [u.email, toInt(params.mid, 'Mã concept')]); return { favs: await favsOf(u.email) }; }, { auth: 1 });

// ---- đánh giá ----
route('POST', '/api/reviews', async ({ u, body }) => {
  const mid = toInt(body.mid, 'Mã concept'); if (!(await liveCheck())(mid)) throw bad('Concept này không còn tồn tại.', 404);
  if (over('rev:' + u.email, 20, 3600e3)) throw bad('Bạn đánh giá quá nhiều lần, hãy thử lại sau.', 429);
  const c = cleanReview(body); hit('rev:' + u.email);
  const photos = await savePhotos(c.photos), t = now(); let id = null;
  for (let k = 0; k < 5 && id === null; k++) { // hai người cùng đánh giá một lúc có thể trùng mã → thử lại với mã mới
    const next = ((await db.get('SELECT MAX(id) AS m FROM reviews')).m || 10000) + 1;
    try { await db.run('INSERT INTO reviews VALUES(?,?,?,?,?,?,?,?)', [next, mid, u.email, c.rating, c.comment, JSON.stringify(photos), t, t]); id = next; } catch (e) { if (!isDup(e) || k === 4) { await cleanImgs(photos); throw e; } }
  }
  return { review: revOut(await getRev(id), u) }; }, { auth: 1 });
route('PUT', '/api/reviews/:id', async ({ u, params, body }) => {
  const r = await getRev(toInt(params.id, 'Mã đánh giá')); if (!r || r.owner !== u.email) throw bad('Không tìm thấy đánh giá.', 404);
  if (over('rev:' + u.email, 20, 3600e3)) throw bad('Bạn đánh giá quá nhiều lần, hãy thử lại sau.', 429);
  const c = cleanReview(body); hit('rev:' + u.email);
  const photos = await savePhotos(c.photos);
  await db.run('UPDATE reviews SET rating=?, comment=?, photos=?, updated_at=? WHERE id=?', [c.rating, c.comment, JSON.stringify(photos), now(), r.id]);
  await cleanImgs(JSON.parse(r.photos).filter(p => !photos.includes(p)));
  return { review: revOut(await getRev(r.id), u) }; }, { auth: 1 });
route('DELETE', '/api/reviews/:id', async ({ u, params }) => {
  const r = await getRev(toInt(params.id, 'Mã đánh giá')); if (!r || (r.owner !== u.email && u.role !== 'admin')) throw bad('Không tìm thấy đánh giá.', 404);
  await db.run('DELETE FROM reviews WHERE id=?', [r.id]); await cleanImgs(JSON.parse(r.photos)); return { ok: true }; }, { auth: 1 });

// ---- admin: xoá concept / artist (client gửi danh sách id concept; xoá artist = xoá mọi concept của artist đó) ----
route('POST', '/api/admin/concepts/delete', async ({ body }) => {
  const ids = [...new Set((Array.isArray(body.ids) ? body.ids : []).map(x => toInt(x, 'Mã concept')))];
  if (!ids.length || ids.length > 200) throw bad('Danh sách concept không hợp lệ.');
  const junk = [], t = now(), st = [], ph = ids.map(() => '?').join(',');
  for (const id of ids) if (id <= SEED_MAX) st.push(['INSERT OR IGNORE INTO removed VALUES(?,?)', [id, t]]);
  for (const r of await db.all('SELECT * FROM subs')) { // concept do MUA đăng: gỡ khỏi hồ sơ; hết concept thì hồ sơ chuyển sang "chưa được duyệt"
    const mid = JSON.parse(r.mid), data = JSON.parse(r.data); let ch = false;
    for (const id of ids) { const k = mid.indexOf(id); if (k >= 0) { junk.push(...data.concepts[k].photos); mid.splice(k, 1); data.concepts.splice(k, 1); ch = true; } }
    if (!ch) continue;
    if (mid.length) st.push(['UPDATE subs SET data=?, mid=? WHERE id=?', [JSON.stringify(data), JSON.stringify(mid), r.id]]);
    else st.push(["UPDATE subs SET data=?, mid='[]', status='rejected', reason='Hồ sơ đã bị quản trị viên xoá.', reviewed_at=? WHERE id=?", [JSON.stringify(data), t, r.id]]);
  }
  for (const r of await db.all(`SELECT photos FROM reviews WHERE mid IN (${ph})`, ids)) junk.push(...JSON.parse(r.photos));
  st.push([`DELETE FROM reviews WHERE mid IN (${ph})`, ids], [`DELETE FROM favs WHERE mid IN (${ph})`, ids]);
  await db.tx(st); // tất cả cùng thành công hoặc không có gì thay đổi
  await cleanImgs(junk); return { removed: ids }; }, { admin: 1 });

// ---- HTTP ----
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json' };
function sendFile(res, file, cache) {
  fs.stat(file, (e, st) => { if (e || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Không tìm thấy'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': cache || 'no-cache' }); fs.createReadStream(file).pipe(res); });
}
async function readJson(req, max = 25e6) {
  if (!/^application\/json/i.test(req.headers['content-type'] || '')) {
    if ((req.headers['content-length'] || '0') === '0' && !req.headers['transfer-encoding']) return {}; // yêu cầu không có nội dung (vd: PUT /api/favorites/7)
    throw bad('Content-Type phải là application/json.', 415);
  }
  let n = 0; const c = []; for await (const x of req) { n += x.length; if (n > max) throw bad('Dữ liệu gửi lên quá lớn.', 413); c.push(x); }
  try { const j = JSON.parse(Buffer.concat(c).toString('utf8') || '{}'); return j && typeof j === 'object' ? j : {}; } catch { throw bad('JSON không hợp lệ.'); }
}
const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'same-origin');
  const url = new URL(req.url, 'http://x'), p = url.pathname, ip = (E.TRUST_PROXY === '1' && (req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress || '';
  try {
    if (p.startsWith('/api/')) {
      let hit_ = null, params = {}; for (const r of R) { if (r.m !== req.method) continue; const m = p.match(r.re); if (m) { hit_ = r; params = m.groups || {}; break; } }
      if (!hit_) throw bad('Không tìm thấy.', 404);
      const u = await userOf(req); if ((hit_.o.auth || hit_.o.admin) && !u) throw bad(cookie(req, 'gb_sid') ? 'Phiên đăng nhập đã hết hạn do không thao tác, vui lòng đăng nhập lại.' : 'Bạn cần đăng nhập.', 401); if (hit_.o.admin && u.role !== 'admin') throw bad('Chỉ quản trị viên mới được thực hiện.', 403);
      const body = req.method === 'GET' || req.method === 'DELETE' ? {} : await readJson(req), out = await hit_.fn({ req, res, u, body, params, ip });
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end(JSON.stringify(out));
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') throw bad('Không hỗ trợ.', 405);
    if (p.startsWith('/uploads/')) { // ảnh nằm trong database
      const m = p.slice(9).match(/^([a-f0-9]{32}\.(jpg|png|webp))$/), im = m && await getImg(m[1]); if (!im) throw bad('Không tìm thấy.', 404);
      res.writeHead(200, { 'Content-Type': im.mime, 'Content-Length': im.data.length, 'Cache-Control': 'public, max-age=31536000, immutable' }); return res.end(req.method === 'HEAD' ? undefined : im.data);
    }
    let rel; try { rel = decodeURIComponent(p); } catch { throw bad('URL không hợp lệ.'); }
    const f = path.join(PUB, path.normalize(rel === '/' ? '/index.html' : rel));
    if (!f.startsWith(PUB + path.sep) || path.basename(f).startsWith('.')) throw bad('Không tìm thấy.', 404);
    sendFile(res, f);
  } catch (e) {
    const s = e instanceof HttpErr ? e.s : 500; if (s === 500) console.error(e);
    res.writeHead(s, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ error: s === 500 ? 'Lỗi máy chủ.' : e.message }));
  }
});
initDb().then(() => server.listen(PORT, () => console.log(`Glow Base chạy tại http://localhost:${PORT}  (database: ${db.kind === 'turso' ? 'Turso' : 'SQLite cục bộ ' + path.join(DATA, 'glowbase.db')})`)))
  .catch(e => { console.error('Không khởi động được database:', e.message); process.exit(1); });
