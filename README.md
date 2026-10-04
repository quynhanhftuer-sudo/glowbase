# Glow Base

Glow Base là website thư viện concept makeup. Bọn mình làm nó vì tìm người trang điểm ngoài đời khá mệt: ảnh nằm rải rác trên Facebook, Instagram, TikTok, giá thì phải nhắn hỏi từng người, còn bản thân mình cũng chưa chắc biết mình hợp phong cách nào. Ở đây mọi thứ nằm chung một chỗ.

Khẩu hiệu của web là "Find your perfect Concept", nghĩa là tìm theo concept chứ không tìm theo tên người. Giao diện hoàn toàn bằng tiếng Việt, làm theo phong cách vintage.

## Web làm được gì

**Với khách:** vào trang, chọn concept (Hàn Quốc, Douyin, Y2K, cô dâu, kỉ yếu...), lọc theo khu vực, mức giá, loại hình, số sao rồi xem ảnh sample, giá và địa chỉ. Ưng ai thì liên hệ thẳng qua điện thoại, Zalo, Facebook, Instagram hoặc TikTok. Khách còn lưu được concept mình thích và để lại đánh giá từ 1 đến 5 sao, kèm tối đa 6 ảnh.

**Với Makeup Artist (MUA):** gửi hồ sơ qua biểu mẫu ba bước gồm thông tin cá nhân, địa điểm, concept và bảng giá. Hồ sơ phải được admin duyệt mới hiện công khai (dự kiến 24 đến 48 giờ). Nếu bị từ chối thì có ghi lý do để sửa lại. Hồ sơ đã duyệt mà sửa thì sẽ quay về trạng thái chờ duyệt.

**Với admin:** có trang Quản trị để duyệt hoặc từ chối hồ sơ, xóa concept hay artist (đánh giá và yêu thích liên quan bị xóa theo).

Đăng ký chỉ cần Gmail, không cần mã xác minh, và mỗi Gmail chỉ tạo được một tài khoản.

## Phạm vi hiện tại

Web đang hỗ trợ bảy khu vực: Hà Nội, Bắc Ninh, Hải Dương, Hải Phòng, Hồ Chí Minh, Huế và Đà Nẵng. Hiện chưa có đặt lịch, thanh toán hay app di động. Khách và MUA tự trao đổi với nhau, web không thu hoa hồng.

## Làm bằng gì

Giao diện viết bằng HTML, CSS, JavaScript thuần. Backend là Node.js 22.13 trở lên và không cần cài thêm gói npm nào. Dữ liệu lưu bằng SQLite khi chạy thử trên máy, và dùng Turso (SQLite trên mạng, có gói miễn phí) khi chạy thật. Ảnh cũng nằm trong database luôn.

# Cài đặt và deploy

## Chạy thử trên máy (5 phút)
1. Cài Node.js 22.13 trở lên (nodejs.org).
2. `npm install`
3. Sao chép `.env.example` thành `.env`, điền `ADMIN_EMAIL`.
4. `npm start` → mở http://localhost:3000
5. Đăng ký bằng đúng Gmail ghi ở `ADMIN_EMAIL` → tài khoản đó tự có quyền Admin (menu avatar → Quản trị).

Đăng ký không cần mã xác minh email; mỗi Gmail (kể cả biến thể thêm/bớt dấu chấm) chỉ tạo được 1 tài khoản.

## Tạo database Turso (miễn phí) — làm 1 lần
Hosting miễn phí (Render…) xoá sạch ổ đĩa mỗi lần khởi động lại, nên dữ liệu phải nằm ở database ngoài. Turso là SQLite trên mạng, gói Free (kiểm tra lại trên turso.tech/pricing): 5 GB, 500 triệu lượt đọc và 10 triệu lượt ghi mỗi tháng, database không bị "ngủ".
1. Vào **turso.tech**, đăng ký (có thể dùng GitHub/Google).
2. **Create Database** → đặt tên (vd `glowbase`) → chọn vùng gần máy chủ Render của bạn → Create.
3. Mở database vừa tạo, lấy **URL** (dạng `libsql://glowbase-tenban.turso.io`).
4. Bấm **Generate Token** (hoặc *Create Token*) → chọn quyền đọc/ghi, không đặt hạn → copy token. Token chỉ hiện một lần, hãy lưu lại.
   (Dùng CLI cũng được: `turso db show glowbase --url` và `turso db tokens create glowbase`.)
5. Không cần tạo bảng: server tự tạo khi khởi động.

## Đưa lên mạng (Render)
Frontend và backend chạy chung một server (`public/index.html`), nên không cần CORS.
- Start command: `npm start`. Không cần ổ đĩa, không cần `DATA_DIR`.
- Trong **Environment** đặt: `NODE_ENV=production`, `TRUST_PROXY=1`, `ADMIN_EMAIL`, **`TURSO_DATABASE_URL`**, **`TURSO_AUTH_TOKEN`**.
- Phải dùng HTTPS (Render có sẵn).
- Mở `https://<tên-miền-của-bạn>/api/health` — thấy `{"ok":true,"db":"turso"}` là đã nối đúng Turso. Nếu thấy `"db":"local"` nghĩa là chưa đặt `TURSO_DATABASE_URL`: dữ liệu sẽ mất khi khởi động lại.
- Gói Free của Render "ngủ" sau ~15 phút không có người truy cập; lần mở đầu tiên sau đó chậm vài chục giây, nhưng dữ liệu không mất.
- Server sẽ **không khởi động** (và ghi rõ lý do trong Logs) nếu URL/token Turso sai, thay vì chạy sai âm thầm.

## Đăng nhập & phiên
- Tải lại trang (F5) **không** bị đăng xuất. Trình duyệt giữ cookie 30 ngày, nhưng **server** quyết định hết phiên: **15 phút không thao tác** (chuột, bàn phím, cuộn, chạm) thì phải đăng nhập lại; còn thao tác thì phiên tự kéo dài. Đổi thời gian bằng `SESSION_IDLE_SEC` (mặc định 900 giây).
- Nếu vẫn bị đăng xuất mỗi lần tải lại, nguyên nhân gần như chắc chắn nằm ở hosting, không phải ở code: (1) chưa đặt `TURSO_DATABASE_URL` nên database (gồm cả tài khoản và phiên đăng nhập) nằm trên ổ đĩa tạm và bị xoá mỗi lần máy chủ khởi động lại — server in cảnh báo `[CẢNH BÁO]` khi chạy production mà thiếu; (2) chạy `NODE_ENV=production` nhưng truy cập bằng `http://` (cookie `Secure` bị trình duyệt bỏ) — giao diện sẽ báo "trình duyệt không giữ được phiên".

## Dữ liệu lưu ở đâu
Toàn bộ nằm trong **một database** (Turso khi chạy thật; file `DATA_DIR/glowbase.db` khi chạy thử trên máy): tài khoản (mật khẩu băm scrypt), phiên đăng nhập, hồ sơ MUA + trạng thái duyệt, đánh giá, yêu thích, danh sách concept đã bị admin xoá, và **cả ảnh** (bảng `images`; ảnh không còn ai dùng sẽ tự bị xoá). Server không ghi gì ra ổ đĩa ở chế độ Turso.
- **Sao lưu:** trên Turso, `turso db shell glowbase .dump > backup.sql` (hoặc dùng tính năng backup/branch của Turso). Chạy thử trên máy: copy file `data/glowbase.db`.
- **Dung lượng & lượt đọc/ghi:** ảnh được thu nhỏ ở trình duyệt (~100 KB/ảnh) nên 5 GB chứa được hàng chục nghìn ảnh. Mỗi lần mở trang đọc toàn bộ hồ sơ + đánh giá (vài nghìn dòng khi dữ liệu lớn), phiên đăng nhập chỉ ghi lại tối đa mỗi 60 giây/người để tiết kiệm lượt ghi.
- Chuyển dữ liệu từ file cục bộ lên Turso: không có công cụ tự động (dữ liệu trên Render trước đây đã mất nên không cần). Nếu cần, dùng `sqlite3 data/glowbase.db .dump | turso db shell glowbase`.
- Trình duyệt không lưu hồ sơ, đánh giá hay yêu thích; chỉ giữ hai mốc thời gian/cờ nhỏ (`gb_last_act`, `gb_was_in`) để biết khi nào hết phiên.

## Quy tắc nghiệp vụ đã chốt
- Tên đăng nhập = Gmail đã đăng ký: **không đổi được** (giao diện khoá ô, server từ chối `PUT /api/me` nếu gửi email/username khác). Chỉ đổi được tên hiển thị, ảnh đại diện, mật khẩu.
- Hồ sơ đã duyệt mà MUA sửa lại → chuyển ngay về "chờ duyệt" và **biến mất khỏi trang công khai** cho tới khi admin duyệt lại (id concept giữ nguyên nên yêu thích/đánh giá cũ không mất). Giao diện cảnh báo trước khi MUA bấm sửa.
- Admin xoá concept/artist: ghi lên server, xoá luôn đánh giá + yêu thích của concept đó; hồ sơ MUA hết concept chuyển sang "chưa được duyệt".

## API (đều dưới `/api`)
`GET /boot` · `POST /session/ping` · `GET /favorites` · `PUT|DELETE /favorites/:mid` · `POST /reviews` · `PUT|DELETE /reviews/:id` · `POST /admin/concepts/delete {ids:[…]}` — cùng các API đăng ký/đăng nhập/hồ sơ/duyệt đã có.

## Kiểm tra
`npm test` chạy các phép thử tự động **hai lần**: với SQLite cục bộ và với "Turso giả" (`test/mock-turso.js`, mô phỏng giao thức HTTP của Turso nên không cần mạng/tài khoản). Nội dung: (đăng ký, mã sai, phân quyền, XSS, ảnh giả, duyệt hồ sơ, sửa hồ sơ đã duyệt, yêu thích, đánh giá, xoá concept, hết phiên do không thao tác, giao dịch COMMIT/ROLLBACK, ảnh trong database, token Turso sai…). Lưu ý: bản giả do chúng tôi viết theo tài liệu giao thức, nên sau khi nối Turso thật hãy tự thử một vòng (đăng ký, đăng ảnh, khởi động lại server rồi đăng nhập lại).
