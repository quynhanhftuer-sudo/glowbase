'use strict';
/* Lớp database dùng chung cho server.js — không cần thêm gói npm nào.
   • Có TURSO_DATABASE_URL  → dữ liệu nằm trên Turso (SQLite trên mạng, gói miễn phí), gọi qua HTTP (giao thức /v2/pipeline).
   • Không có               → SQLite file cục bộ (node:sqlite) để chạy thử trên máy.
   Giao diện giống nhau: all / get / run / multi / tx. */

const sleep = ms => new Promise(r => setTimeout(r, ms));
const dbErr = (msg, code) => Object.assign(new Error(msg), { code });
const isDup = e => /UNIQUE|constraint/i.test(String(e && e.message));
const isRead = sql => /^\s*(select|with|pragma)\b/i.test(sql);

const face = (kind, multi, tx) => ({
  kind, multi, tx,
  all: async (sql, a) => (await multi([[sql, a]]))[0].rows,
  get: async (sql, a) => (await multi([[sql, a]]))[0].rows[0] || null,
  run: async (sql, a) => { const r = (await multi([[sql, a]]))[0]; return { changes: r.changes, lastId: r.lastId }; },
});

/* ---------------- SQLite cục bộ ---------------- */
function openLocal(file) {
  const { DatabaseSync } = require('node:sqlite');
  const d = new DatabaseSync(file);
  d.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
  const norm = v => (v instanceof Uint8Array && !Buffer.isBuffer(v) ? Buffer.from(v) : typeof v === 'bigint' ? Number(v) : v);
  const arg = v => (v === undefined ? null : typeof v === 'boolean' ? +v : v);
  const one = (sql, args = []) => {
    const st = d.prepare(sql);
    if (isRead(sql)) return { rows: st.all(...args.map(arg)).map(r => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, norm(v)]))), changes: 0, lastId: null };
    const r = st.run(...args.map(arg)); return { rows: [], changes: Number(r.changes), lastId: Number(r.lastInsertRowid) };
  };
  const multi = async items => items.map(([sql, a]) => one(sql, a));
  const tx = async items => {
    d.exec('BEGIN IMMEDIATE');
    try { const out = items.map(([sql, a]) => one(sql, a)); d.exec('COMMIT'); return out; }
    catch (e) { try { d.exec('ROLLBACK'); } catch {} throw e; }
  };
  return face('local', multi, tx);
}

/* ---------------- Turso qua HTTP ---------------- */
const enc = v => {
  if (v === null || v === undefined) return { type: 'null' };
  if (typeof v === 'boolean') return { type: 'integer', value: v ? '1' : '0' };
  if (typeof v === 'bigint') return { type: 'integer', value: v.toString() };
  if (typeof v === 'number') return Number.isInteger(v) ? { type: 'integer', value: String(v) } : { type: 'float', value: v };
  if (typeof v === 'string') return { type: 'text', value: v };
  if (v instanceof Uint8Array) return { type: 'blob', base64: Buffer.from(v).toString('base64') };
  throw new Error('Kiểu dữ liệu không hỗ trợ: ' + typeof v);
};
const dec = c => {
  if (!c || c.type === 'null') return null;
  if (c.type === 'integer') return Number(c.value);
  if (c.type === 'float') return Number(c.value);
  if (c.type === 'blob') return Buffer.from(c.base64 || '', 'base64');
  return c.value;
};
const stmt = (sql, args = []) => ({ sql, args: args.map(enc), want_rows: true });
const shape = r => ({
  rows: (r.rows || []).map(row => Object.fromEntries(row.map((c, i) => [r.cols[i].name, dec(c)]))),
  changes: r.affected_row_count || 0,
  lastId: r.last_insert_rowid == null ? null : Number(r.last_insert_rowid),
});

function openTurso(url, token) {
  if (!/^(libsql|https?|wss?):\/\//i.test(url)) throw new Error('TURSO_DATABASE_URL phải bắt đầu bằng libsql:// hoặc https://');
  const endpoint = url.replace(/^libsql:\/\//i, 'https://').replace(/^wss?:\/\//i, m => (m.toLowerCase() === 'wss://' ? 'https://' : 'http://')).replace(/\/+$/, '') + '/v2/pipeline';
  if (!token && !/^http:\/\//i.test(endpoint)) throw new Error('Thiếu TURSO_AUTH_TOKEN.');

  async function pipeline(requests, readOnly) {
    const body = JSON.stringify({ requests: [...requests, { type: 'close' }] });
    for (let attempt = 0; ; attempt++) {
      let r;
      try {
        r = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body, signal: AbortSignal.timeout(25000) });
      } catch (e) {
        const c = (e.cause && e.cause.code) || '';
        const safe = readOnly || /^(ECONNREFUSED|ENOTFOUND|EAI_AGAIN)$/.test(c); // ghi dữ liệu chỉ thử lại khi chắc chắn yêu cầu chưa tới được server
        if (attempt < 2 && safe) { await sleep(200 * (attempt + 1)); continue; }
        throw dbErr('Không kết nối được database: ' + ((e.cause && e.cause.message) || e.message));
      }
      if (r.status >= 500 && readOnly && attempt < 2) { await sleep(200 * (attempt + 1)); continue; }
      const j = await r.json().catch(() => null);
      if (!r.ok) throw dbErr(`Database trả lỗi ${r.status}${r.status === 401 || r.status === 403 ? ' (sai TURSO_AUTH_TOKEN?)' : ''}: ${(j && (j.error || j.message)) || ''}`);
      return j;
    }
  }
  const fail = e => dbErr((e && e.message) || 'Lỗi database', e && e.code);

  // nhiều câu lệnh trong MỘT lượt gọi mạng (chạy tuần tự, không bọc giao dịch)
  const multi = async items => {
    const j = await pipeline(items.map(([sql, a]) => ({ type: 'execute', stmt: stmt(sql, a) })), items.every(i => isRead(i[0])));
    return items.map((_, i) => { const x = j.results[i]; if (!x || x.type === 'error') throw fail(x && x.error); return shape(x.response.result); });
  };
  // nguyên tử: tất cả thành công hoặc không câu nào được ghi (BEGIN … COMMIT, lỗi thì ROLLBACK)
  const tx = async items => {
    const n = items.length, steps = [{ stmt: stmt('BEGIN') }];
    items.forEach(([sql, a], i) => steps.push({ stmt: stmt(sql, a), condition: { type: 'ok', step: i } }));
    steps.push({ stmt: stmt('COMMIT'), condition: { type: 'ok', step: n } });
    steps.push({ stmt: stmt('ROLLBACK'), condition: { type: 'not', cond: { type: 'ok', step: n + 1 } } });
    const j = await pipeline([{ type: 'batch', batch: { steps } }], false), x = j.results[0];
    if (!x || x.type === 'error') throw fail(x && x.error);
    const { step_results: sr, step_errors: se } = x.response.result;
    for (let i = 0; i <= n + 1; i++) if (se && se[i]) throw fail(se[i]);
    return items.map((_, i) => shape(sr[i + 1]));
  };
  return face('turso', multi, tx);
}

module.exports = { openLocal, openTurso, isDup };
