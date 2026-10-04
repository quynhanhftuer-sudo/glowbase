'use strict';
/* Turso GIẢ dùng cho `npm test`: mô phỏng giao thức SQL-over-HTTP (/v2/pipeline) của Turso/libSQL bằng SQLite trong bộ nhớ.
   Mục đích: kiểm tra driver HTTP trong db.js mà không cần mạng hay tài khoản Turso. Không dùng khi chạy thật. */
const http = require('node:http'), { DatabaseSync } = require('node:sqlite');

function start(port, token) {
  const d = new DatabaseSync(':memory:'); d.exec('PRAGMA foreign_keys=OFF;');
  const stats = { requests: 0, statements: 0, auth401: 0 };
  const val = v => v === null ? { type: 'null' } : typeof v === 'bigint' || (typeof v === 'number' && Number.isInteger(v)) ? { type: 'integer', value: String(v) } : typeof v === 'number' ? { type: 'float', value: v } : typeof v === 'string' ? { type: 'text', value: v } : { type: 'blob', base64: Buffer.from(v).toString('base64') };
  const arg = a => { switch (a.type) { case 'null': return null; case 'integer': return Number(a.value); case 'float': return Number(a.value); case 'text': return a.value; case 'blob': return Buffer.from(a.base64, 'base64'); default: throw new Error('bad arg type ' + a.type); } };
  function exec(st) {
    stats.statements++;
    const s = d.prepare(st.sql), args = (st.args || []).map(arg);
    if (/^\s*(select|with|pragma)\b/i.test(st.sql)) {
      const cols = s.columns().map(c => ({ name: c.name, decltype: c.type || null })), rows = s.all(...args).map(r => cols.map(c => val(r[c.name])));
      return { cols, rows, affected_row_count: 0, last_insert_rowid: null };
    }
    const r = s.run(...args); return { cols: [], rows: [], affected_row_count: Number(r.changes), last_insert_rowid: String(r.lastInsertRowid) };
  }
  const err = e => ({ message: String(e.message), code: /constraint/i.test(e.message) ? 'SQLITE_CONSTRAINT' : 'SQLITE_ERROR' });
  const cond = (c, R, E) => { if (!c) return true; switch (c.type) { case 'ok': return !!R[c.step] && !E[c.step]; case 'error': return !!E[c.step]; case 'not': return !cond(c.cond, R, E); case 'and': return c.conds.every(x => cond(x, R, E)); case 'or': return c.conds.some(x => cond(x, R, E)); default: throw new Error('bad condition'); } };
  const srv = http.createServer((req, res) => {
    const chunks = []; req.on('data', c => chunks.push(c)); req.on('end', () => {
      stats.requests++;
      if (req.method !== 'POST' || req.url !== '/v2/pipeline') { res.writeHead(404); return res.end('{}'); }
      if (token && req.headers.authorization !== 'Bearer ' + token) { stats.auth401++; res.writeHead(401, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'The auth token is invalid' })); }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')), results = [];
      for (const rq of body.requests) {
        if (rq.type === 'execute') { try { results.push({ type: 'ok', response: { type: 'execute', result: exec(rq.stmt) } }); } catch (e) { results.push({ type: 'error', error: err(e) }); } }
        else if (rq.type === 'batch') {
          const R = [], E = [];
          rq.batch.steps.forEach((step, i) => { R[i] = null; E[i] = null; if (!cond(step.condition, R, E)) return; try { R[i] = exec(step.stmt); } catch (e) { E[i] = err(e); } });
          results.push({ type: 'ok', response: { type: 'batch', result: { step_results: R, step_errors: E } } });
        } else if (rq.type === 'close') results.push({ type: 'ok', response: { type: 'close' } });
        else results.push({ type: 'error', error: { message: 'unsupported request ' + rq.type } });
      }
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ baton: null, base_url: null, results }));
    });
  });
  return new Promise(ok => srv.listen(port, () => ok({ srv, stats, close: () => srv.close() })));
}
module.exports = { start };
