const { spawn } = require('node:child_process'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), assert = require('node:assert');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-')), B = 'http://localhost:3999';
const MODE = process.argv[2] === 'turso' ? 'turso' : 'local', TOKEN = 'test-token-xyz';
let srv, mock, log = '';
const baseEnv = { ...process.env, PORT: 3999, DATA_DIR: dir, NODE_ENV: 'development', SMTP_USER: '', SMTP_PASS: '', ADMIN_EMAIL: 'admin.glow@gmail.com', SESSION_IDLE_SEC: 4, TURSO_DATABASE_URL: '', TURSO_AUTH_TOKEN: '' };
async function startAll() {
  const env = { ...baseEnv };
  if (MODE === 'turso') { mock = await require('./test/mock-turso').start(3998, TOKEN); env.TURSO_DATABASE_URL = 'http://localhost:3998'; env.TURSO_AUTH_TOKEN = TOKEN; }
  srv = spawn(process.execPath, ['server.js'], { cwd: __dirname, env }); srv.stdout.on('data', d => log += d); srv.stderr.on('data', () => {});
}
class Jar { c = ''; async call(m, u, b) { const r = await fetch(B + u, { method: m, headers: { ...(b ? { 'Content-Type': 'application/json' } : {}), cookie: this.c }, body: b && JSON.stringify(b) }); const s = r.headers.getSetCookie?.()[0]; if (s) this.c = s.split(';')[0]; return { s: r.status, j: await r.json().catch(() => ({})) }; } }
const JPG = 'data:image/jpeg;base64,' + Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]), Buffer.alloc(200, 1)]).toString('base64');
const sub = (o = {}) => ({ data: { name: 'Ngọc Anh <b>MUA</b>', bio: '<img src=x onerror=alert(1)>', type: 'Tại gia', svc: 'home', province: 'Hà Nội', address: '12 Trần Duy Hưng, Cầu Giấy', avatar: '', contacts: [{ type: 'phone', label: '0912 345 678', href: 'tel:0912345678' }], concepts: [{ concept: 'Cô dâu', lo: 1500000, hi: 3000000, photos: [JPG] }], ...o } });
async function reg(j, em, pw = 'Matkhau123') { const r = await j.call('POST', '/api/auth/register', { name: 'Test', email: em, password: pw }); assert.equal(r.s, 200); return r.j.user; }
(async () => {
  console.log(`\n=== Chế độ: ${MODE === 'turso' ? 'Turso (giả lập qua HTTP)' : 'SQLite cục bộ'} ===`);
  await startAll();
  for (let i = 0; i < 50; i++) { try { await fetch(B + '/api/health'); break; } catch { await new Promise(r => setTimeout(r, 100)); } }
  const A = new Jar(), U = new Jar(), P = new Jar();
  assert.equal((await A.call('POST', '/api/auth/register', { name: 'x', email: 'bad@yahoo.com', password: 'Matkhau123' })).s, 400, 'chỉ nhận Gmail');
  assert.equal((await A.call('POST', '/api/auth/register', { name: 'x', email: 'abcde1@gmail.com', password: 'short' })).s, 400, 'mật khẩu yếu');
  const ra = await A.call('POST', '/api/auth/register', { name: 'Admin', email: 'admin.glow@gmail.com', password: 'Matkhau123' }); assert.equal(ra.s, 200); assert.equal(ra.j.user.role, 'admin');
  assert.equal((await U.call('POST', '/api/auth/register', { name: 'Linh', email: 'linh.mua@gmail.com', password: 'Matkhau123' })).j.user.role, 'user');
  assert.equal((await new Jar().call('POST', '/api/auth/register', { name: 'Dup', email: 'linh.mua@gmail.com', password: 'Matkhau123' })).s, 409, 'trùng Gmail');
  assert.equal((await new Jar().call('POST', '/api/auth/register', { name: 'Dup', email: 'linhmua@gmail.com', password: 'Matkhau123' })).s, 409, 'trùng Gmail khác dấu chấm');
  assert.equal((await new Jar().call('POST', '/api/auth/login', { identifier: 'linh.mua@gmail.com', password: 'sai' })).s, 401);
  assert.equal((await new Jar().call('POST', '/api/submissions', sub())).s, 401, 'phải đăng nhập');
  let r = await U.call('POST', '/api/submissions', sub()); assert.equal(r.s, 200); const id = r.j.sub.id;
  assert.ok(!r.j.sub.data.name.includes('<b>') && !r.j.sub.data.bio.includes('<img'), 'XSS đã bị escape');
  assert.match(r.j.sub.data.concepts[0].photos[0], /^\/uploads\/[a-f0-9]{32}\.jpg$/); assert.equal(r.j.sub.status, 'pending');
  assert.equal((await U.call('POST', '/api/submissions', sub({ contacts: [{ type: 'website', label: 'x', href: 'javascript:alert(1)' }] }))).s, 400, 'chặn javascript:');
  assert.equal((await U.call('POST', '/api/submissions', sub({ concepts: [{ concept: 'Cô dâu', lo: 0, hi: 0, photos: ['data:image/jpeg;base64,AAAA'] }] }))).s, 400, 'ảnh giả');
  assert.equal((await P.call('GET', '/api/boot')).j.subs.length, 0, 'khách chưa thấy hồ sơ chờ duyệt');
  assert.equal((await U.call('POST', `/api/admin/submissions/${id}/approve`, {})).s, 403, 'user thường không duyệt được');
  assert.equal((await A.call('GET', '/api/boot')).j.subs.length, 1, 'admin thấy hồ sơ');
  assert.equal((await A.call('POST', `/api/admin/submissions/${id}/reject`, { reason: 'ok' })).s, 400, 'lý do phải ≥5 ký tự');
  r = await A.call('POST', `/api/admin/submissions/${id}/approve`, {}); assert.equal(r.j.sub.status, 'approved');
  const pub = (await P.call('GET', '/api/boot')).j.subs[0]; assert.equal(pub.status, 'approved'); assert.ok(pub.owner.startsWith('u_'), 'không lộ email chủ hồ sơ'); assert.ok(pub.mid[0] >= 1000001);
  const img = await fetch(B + pub.data.concepts[0].photos[0]); assert.equal(img.status, 200); assert.equal(img.headers.get('content-type'), 'image/jpeg');
  r = await U.call('PUT', `/api/submissions/${id}`, sub()); assert.equal(r.j.sub.status, 'pending'); assert.equal(r.j.sub.mid[0], pub.mid[0], 'id concept giữ nguyên khi sửa');
  assert.equal((await fetch(B + '/.env')).status, 404); assert.equal((await fetch(B + '/../server.js')).status, 404);
  assert.equal((await U.call('POST', '/api/me/password', { old: 'Matkhau123', new: 'Matkhau456' })).s, 200);
  assert.equal((await new Jar().call('POST', '/api/auth/login', { identifier: 'linh.mua@gmail.com', password: 'Matkhau456' })).s, 200);
  await U.call('POST', '/api/auth/logout', {}); assert.equal((await U.call('GET', '/api/boot')).j.user, null);

  assert.equal((await P.call('GET', '/api/boot')).j.subs.length, 0, 'sau khi MUA sửa, hồ sơ không còn ở trang công khai');
  assert.equal((await U.call('GET', '/api/boot')).j.subs.length, 0, 'U đã đăng xuất ở trên nên cũng không thấy');
  const U2 = new Jar(); await U2.call('POST', '/api/auth/login', { identifier: 'linh.mua@gmail.com', password: 'Matkhau456' });
  assert.equal((await U2.call('GET', '/api/boot')).j.subs[0].status, 'pending', 'chủ hồ sơ vẫn thấy hồ sơ của mình (chờ duyệt)');
  await A.call('POST', `/api/admin/submissions/${id}/approve`, {});
  const pub2 = (await P.call('GET', '/api/boot')).j.subs; assert.equal(pub2.length, 1, 'admin duyệt lại → hiện lại'); assert.equal(pub2[0].mid[0], pub.mid[0], 'id concept không đổi');
  const mid1 = pub2[0].mid[0];

  
  const F = new Jar(), V = new Jar(); await reg(F, 'fan.glow@gmail.com'); await reg(V, 'other.glow@gmail.com');
  assert.equal((await F.call('PUT', '/api/me', { name: 'Fan', email: 'khac@gmail.com' })).s, 400, 'không đổi được Gmail');
  assert.equal((await F.call('PUT', '/api/me', { name: 'Fan', username: 'khac' })).s, 400, 'không đổi được tên đăng nhập');
  assert.equal((await F.call('PUT', '/api/me', { name: 'Fan Moi', email: 'FAN.glow@gmail.com' })).j.user.email, 'fan.glow@gmail.com', 'gửi lại đúng Gmail thì chỉ đổi tên hiển thị');

  
  assert.equal((await new Jar().call('PUT', '/api/favorites/1', {})).s, 401, 'phải đăng nhập');
  assert.equal((await F.call('PUT', '/api/favorites/1')).s, 200, 'PUT không cần nội dung');
  assert.equal((await F.call('PUT', '/api/favorites/1', {})).j.favs.length, 1, 'thêm hai lần không bị nhân đôi');
  assert.equal((await F.call('PUT', '/api/favorites/abc')).s, 400); assert.equal((await F.call('PUT', '/api/favorites/1999999')).s, 404, 'concept không tồn tại');
  assert.equal((await F.call('PUT', `/api/favorites/${mid1}`)).s, 200, 'yêu thích được concept của MUA đã duyệt');
  assert.deepEqual((await F.call('GET', '/api/boot')).j.favs, [1, mid1], 'đăng nhập ở nơi khác vẫn thấy');
  assert.deepEqual((await V.call('GET', '/api/boot')).j.favs, [], 'yêu thích của người này không lẫn sang người khác');
  assert.deepEqual((await P.call('GET', '/api/boot')).j.favs, []);

  
  r = await F.call('POST', '/api/reviews', { mid: 1, rating: 5, comment: 'Rất <b>đẹp</b>', photos: [JPG] }); assert.equal(r.s, 200); const rv = r.j.review;
  assert.ok(rv.id > 10000 && !rv.comment.includes('<b>'), 'XSS đã bị escape'); assert.match(rv.photos[0], /^\/uploads\/[a-f0-9]{32}\.jpg$/); assert.equal(rv.userId, 'fan.glow@gmail.com'); assert.equal(rv.userName, 'Fan Moi');
  assert.equal((await new Jar().call('POST', '/api/reviews', { mid: 1, rating: 3, comment: 'x' })).s, 401);
  assert.equal((await F.call('POST', '/api/reviews', { mid: 1, rating: 6, comment: 'x' })).s, 400, 'sao phải 1–5');
  assert.equal((await F.call('POST', '/api/reviews', { mid: 1, rating: 3, comment: '   ' })).s, 400, 'nhận xét không được trống');
  assert.equal((await F.call('POST', '/api/reviews', { mid: 1, rating: 3, comment: 'x', photos: ['data:image/jpeg;base64,AAAA'] })).s, 400, 'ảnh giả');
  assert.equal((await F.call('POST', '/api/reviews', { mid: 1, rating: 3, comment: 'x', photos: Array(7).fill(JPG) })).s, 400, 'tối đa 6 ảnh');
  assert.equal((await F.call('POST', '/api/reviews', { mid: 1500000, rating: 3, comment: 'x' })).s, 404, 'concept không tồn tại');
  const seen = (await P.call('GET', '/api/boot')).j.reviews; assert.equal(seen.length, 1, 'khách thấy đánh giá'); assert.ok(seen[0].userId.startsWith('u_') && !JSON.stringify(seen).includes('fan.glow'), 'không lộ email người đánh giá');
  assert.equal((await V.call('PUT', `/api/reviews/${rv.id}`, { rating: 1, comment: 'phá' })).s, 404, 'người khác không sửa được');
  assert.equal((await V.call('DELETE', `/api/reviews/${rv.id}`)).s, 404, 'người khác không xoá được');
  r = await F.call('PUT', `/api/reviews/${rv.id}`, { rating: 4, comment: 'Sửa lại', photos: [] }); assert.equal(r.j.review.rating, 4); assert.equal(r.j.review.photos.length, 0);
  await new Promise(x => setTimeout(x, 150)); assert.equal((await fetch(B + rv.photos[0])).status, 404, 'ảnh không còn ai dùng thì bị xoá khỏi ổ đĩa');
  assert.equal((await F.call('POST', '/api/reviews', { mid: mid1, rating: 5, comment: 'Hồ sơ này ổn' })).s, 200);

 
  assert.equal((await V.call('POST', '/api/admin/concepts/delete', { ids: [5] })).s, 403, 'user thường không xoá được');
  assert.equal((await A.call('POST', '/api/admin/concepts/delete', { ids: [] })).s, 400); assert.equal((await A.call('POST', '/api/admin/concepts/delete', { ids: ['x'] })).s, 400);
  assert.equal((await F.call('POST', '/api/reviews', { mid: 5, rating: 5, comment: 'sắp bị xoá' })).s, 200);
  assert.deepEqual((await A.call('POST', '/api/admin/concepts/delete', { ids: [5, mid1] })).j.removed, [5, mid1]);
  let bt = (await P.call('GET', '/api/boot')).j;
  assert.ok(bt.removed.includes(5), 'concept có sẵn đã xoá được ghi lại trên server'); assert.equal(bt.subs.length, 0, 'concept cuối của hồ sơ bị xoá → hồ sơ không còn công khai');
  assert.deepEqual(bt.reviews.map(x => x.muaId), [1], 'đánh giá của concept đã xoá (5 và của MUA) mất; đánh giá của concept 1 vẫn còn');
  assert.deepEqual((await F.call('GET', '/api/boot')).j.favs, [1], 'yêu thích concept đã xoá cũng mất');
  assert.equal((await F.call('PUT', '/api/favorites/5')).s, 404, 'không yêu thích được concept đã xoá');
  const adm = (await A.call('GET', '/api/boot')).j.subs[0]; assert.equal(adm.status, 'rejected'); assert.equal(adm.data.concepts.length, 0); assert.match(adm.reason, /xoá/);
  assert.equal((await U2.call('PUT', `/api/submissions/${id}`, sub())).s, 200, 'MUA gửi lại hồ sơ sau khi bị xoá concept');

  
  const X = new Jar(), wait = ms => new Promise(x => setTimeout(x, ms)); await reg(X, 'idle.test@gmail.com');
  await wait(2500); assert.equal((await X.call('GET', '/api/boot')).j.user.email, 'idle.test@gmail.com', '2,5s < 4s: còn phiên');
  await wait(2500); assert.ok((await X.call('GET', '/api/boot')).j.user, 'tổng 5s > 4s nhưng giữa chừng có thao tác nên phiên trượt, vẫn còn');
  assert.equal((await X.call('POST', '/api/session/ping', {})).s, 200);
  await wait(4500); r = await X.call('POST', '/api/session/ping', {}); assert.equal(r.s, 401); assert.match(r.j.error, /hết hạn/, 'báo rõ là hết hạn do không thao tác');
  assert.equal((await X.call('GET', '/api/boot')).j.user, null);
  assert.equal((await new Jar().call('POST', '/api/auth/login', { identifier: 'idle.test@gmail.com', password: 'Matkhau123' })).s, 200, 'đăng nhập lại bình thường');

 
  {
    const { openLocal, openTurso, isDup } = require('./db'), d = MODE === 'turso' ? openTurso('http://localhost:3998', TOKEN) : openLocal(path.join(dir, 'driver-test.db'));
    await d.multi([['CREATE TABLE t(a INTEGER PRIMARY KEY, u TEXT UNIQUE, b BLOB, f REAL, n INTEGER)']]);
    const blob = Buffer.from([0, 1, 2, 255, 254, 253]);
    assert.equal((await d.run('INSERT INTO t(u,b,f,n) VALUES(?,?,?,?)', ['Xin chào “Glow” ✿ 😀', blob, 1.5, null])).lastId, 1, 'lastId');
    const row = await d.get('SELECT * FROM t WHERE a=?', [1]); assert.equal(row.u, 'Xin chào “Glow” ✿ 😀', 'unicode'); assert.ok(Buffer.isBuffer(row.b) && row.b.equals(blob), 'blob'); assert.equal(row.f, 1.5); assert.equal(row.n, null);
    await d.run('INSERT INTO t(u,n) VALUES(?,?)', ['big', 1790000000000]); assert.equal((await d.get('SELECT n FROM t WHERE u=?', ['big'])).n, 1790000000000, 'số nguyên lớn (mốc thời gian)');
    await assert.rejects(d.run('INSERT INTO t(u) VALUES(?)', ['big']), e => isDup(e), 'vi phạm UNIQUE phải nhận ra được');
    await assert.rejects(d.tx([['INSERT INTO t(u) VALUES(?)', ['tx1']], ['INSERT INTO t(u) VALUES(?)', ['big']]]), 'giao dịch lỗi phải ném lỗi');
    assert.equal((await d.get('SELECT COUNT(*) AS n FROM t WHERE u=?', ['tx1'])).n, 0, 'giao dịch lỗi → ROLLBACK, không câu nào được ghi');
    await d.tx([['INSERT INTO t(u) VALUES(?)', ['tx2']], ['INSERT INTO t(u) VALUES(?)', ['tx3']]]); assert.equal((await d.get('SELECT COUNT(*) AS n FROM t WHERE u IN (?,?)', ['tx2', 'tx3'])).n, 2, 'giao dịch tốt → COMMIT');
    await assert.rejects(d.get('SELECT * FROM khong_ton_tai'), 'lỗi SQL phải ném ra');
    const [a, b] = await d.multi([['SELECT 1 AS x'], ['SELECT 2 AS y']]); assert.equal(a.rows[0].x + b.rows[0].y, 3, 'multi');
    console.log('✓ driver database ' + d.kind + ': unicode, blob, số lớn, UNIQUE, giao dịch COMMIT/ROLLBACK');
  }
  if (MODE === 'turso') {
    assert.equal(fs.existsSync(path.join(dir, 'glowbase.db')), false, 'chế độ Turso không được tạo database trên ổ đĩa');
    assert.equal(mock.stats.auth401, 0, 'mọi lượt gọi đều gửi đúng token');
    const before = mock.stats.requests; await U2.call('GET', '/api/boot'); const used = mock.stats.requests - before;
    assert.ok(used <= 2, `tải trang đầu chỉ tốn ≤ 2 lượt gọi Turso (thực tế ${used})`);
    assert.equal((await fetch(B + '/api/health').then(r => r.json())).db, 'turso');
    // token sai → server từ chối khởi động và nói rõ lý do
    const bad = spawn(process.execPath, ['server.js'], { cwd: __dirname, env: { ...baseEnv, PORT: 3997, TURSO_DATABASE_URL: 'http://localhost:3998', TURSO_AUTH_TOKEN: 'sai-token' } });
    let out = ''; bad.stdout.on('data', x => out += x); bad.stderr.on('data', x => out += x);
    const code2 = await new Promise(ok => { bad.on('exit', ok); setTimeout(() => { bad.kill(); ok('timeout'); }, 8000); });
    assert.equal(code2, 1, 'token sai → thoát với mã 1'); assert.match(out, /TURSO_AUTH_TOKEN/, 'thông báo nêu rõ sai token');
    console.log('✓ Turso: không ghi ổ đĩa, đúng token, tải trang ≤ 2 lượt gọi (' + used + '), token sai bị báo rõ');
  }
  console.log('✓ Tất cả kiểm tra đều đạt');
})().catch(e => { console.error('✗', e.message, '\n', e.stack.split('\n')[1]); process.exitCode = 1; }).finally(() => { srv && srv.kill(); mock && mock.close(); fs.rmSync(dir, { recursive: true, force: true }); });
