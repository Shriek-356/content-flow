# Content Flow Control & Monitoring Dashboard — Bản Kế Hoạch Kỹ Thuật Chi Tiết

> **Phiên bản:** 2.0 (Toàn diện: Điều khiển n8n + Đăng nhanh + Giám sát + Buffer Approval)  
> **Mục tiêu:** Xây dựng một giao diện Web duy nhất (`http://localhost:3001/dashboard`) để **thao tác trực tiếp với n8n**, đăng bài cứu hộ không cần mở Sheets, duyệt bài trên Buffer và theo dõi log thời gian thực.  
> **Đối tượng sử dụng:** Chủ content, Leader duyệt bài, Operator kỹ thuật và AI Agent bảo trì hệ thống.

---

## 1. Bối cảnh & Kiến trúc Hệ thống Hiện tại

Hệ thống Content Automation của Ecolar hiện gồm 4 tầng hoạt động độc lập:

```
┌─────────────────────────────────────────────────────────────────────────┐
│ TẦNG 1: GOOGLE SHEETS                                                   │
│ Lưu trữ ý tưởng, prompt, 3 options content, link folder media, giờ hẹn  │
└────────────────────────────────────┬────────────────────────────────────┘
                                     │
┌────────────────────────────────────▼────────────────────────────────────┐
│ TẦNG 2: n8n WORKFLOW ENGINE (Docker: Port 5678)                        │
│ Điều phối logic, quét sheets, rẽ nhánh phân loại kênh, gọi AI           │
│ Triggers hiện có: [Manual: Tạo Content] | [Cron: Đăng Bài, Tạo Ảnh AI]   │
└────────────────────────────────────┬────────────────────────────────────┘
                                     │ (HTTP REST API nội bộ: host.docker.internal:3001)
┌────────────────────────────────────▼────────────────────────────────────┐
│ TẦNG 3: BACKEND NODE.JS HELPER (Express: Port 3001)                     │
│ Xử lý tải Drive, FFmpeg Watermark, Sharp chuẩn hóa ảnh, Puppeteer render│
└────────────────────────────────────┬────────────────────────────────────┘
                                     │ (Buffer GraphQL API)
┌────────────────────────────────────▼────────────────────────────────────┐
│ TẦNG 4: BUFFER PLATFORM (Quản lý đa kênh tập trung)                    │
│ 📱 TikTok (gaaicap2)  |  🏢 FB Page (Gà Ai Cập)  |  👥 FB Group (Test flow)│
└─────────────────────────────────────────────────────────────────────────┘
```

### ❗ Nỗi đau thực tế khi vận hành:
1. **Quá nhiều màn hình:** Muốn kiểm tra một bài phải mở Google Sheets ➔ mở n8n canvas ➔ mở Terminal xem log ➔ mở Buffer duyệt bài.
2. **Khó thao tác cho người không rành kỹ thuật:** Nhân viên content muốn kích hoạt n8n chạy lại phải vào canvas n8n, tìm đúng node rồi bấm `Execute workflow` / `Test step`, rất dễ bấm nhầm làm hỏng luồng.
3. **Thiếu cơ chế đăng nhanh (Bypass):** Khi có một video hoặc album ảnh cần đăng khẩn cấp mà không muốn tạo dòng mới trên Sheets, không có cách nào kích hoạt trực tiếp ngoài việc viết code gọi API bằng Postman.

---

## 2. Mục Tiêu Thiết Kế Của Dashboard Mới

Dashboard sẽ được phục vụ trực tiếp từ Express backend (`http://localhost:3001/dashboard`), gói gọn trong **1 file HTML duy nhất (Vanilla JS + CSS)**, chia thành **4 khối chức năng lớn**:

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ 🚀 CONTENT FLOW CONTROL & MONITORING DASHBOARD         [Status: Connected 🟢]│
├──────────────────────────────────────────────────────────────────────────────┤
│ KHỐI 1: QUICK STATS & HEALTH CHECK                                           │
│ [📊 Tổng: 18 bài] [📱 TikTok: 8] [🏢 FB Page: 5] [👥 FB Group: 5] [⚠️ Lỗi: 0] │
├──────────────────────────────────────────────────────────────────────────────┤
│ KHỐI 2: TRUNG TÂM ĐIỀU KHIỂN n8n (WORKFLOW ACTION CENTER)                     │
│  [▶️ Chạy Đăng Bài Ngay]    [🎨 Chạy Tạo Ảnh AI]    [📝 Chạy Tạo Content]    │
│  Trạng thái: n8n Docker Running (Port 5678) 🟢 | Execution gần nhất: 2 phút trước │
├──────────────────────────────────────────────────────────────────────────────┤
│ KHỐI 3: FORM ĐĂNG NHANH / CỨU HỘ (DIRECT QUICK PUBLISHER)                    │
│  • Link Drive (Video/Folder ảnh): [ https://drive.google.com/...            ]│
│  • Nội dung Caption: [ Nhập nội dung bài viết...                            ]│
│  • Chọn kênh: [x] TikTok   [x] FB Fanpage   [x] FB Group                    │
│  • Watermark: [x] Bật (Chéo 15%)   • Chế độ: (o) Lưu nháp   ( ) Đăng ngay    │
│  ===> [ 🚀 BẮT ĐẦU XỬ LÝ & ĐẨY LÊN BUFFER ] <===                             │
├──────────────────────────────────────────────────────────────────────────────┤
│ KHỐI 4: QUẢN LÝ BÀI ĐĂNG & DUYỆT BUFFER (POSTS & APPROVAL TABLE)              │
│  Bộ lọc: [Tất cả kênh ▼] [Tất cả trạng thái ▼] [Tìm kiếm theo tiêu đề...]     │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │ 🎬 TIẾT KIỆM LÚC MUA, ĐỪNG ĐỂ TỐN KÉM LÚC NUÔI                          │  │
│  │ 📱 TikTok • VIDEO • 🟡 DRAFT IN BUFFER • 10:30 Hôm nay                 │  │
│  │ [ Xem Media ↗ ]   [ Mở duyệt trên Buffer ↗ ]   [ Chi tiết log ℹ️ ]      │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
├──────────────────────────────────────────────────────────────────────────────┤
│ KHỐI 5: LIVE TERMINAL CONSOLE (REAL-TIME SSE LOGS)                  [Xóa Log]│
│ 10:30:15 🎬 [TIKTOK UPLOAD] Bắt đầu xử lý video từ Google Drive...          │
│ 10:30:25 🎨 [WATERMARK] Đang render diagonal watermark qua FFmpeg...         │
│ 10:30:42 ✅ [BUFFER] Đã tạo thành công bài nháp! Post ID: 6a98...           │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Thiết Kế Chi Tiết Từng Phân Hệ

### Phân hệ 1: Trung Tâm Điều Khiển n8n (Workflow Action Center)

#### Cơ chế kỹ thuật kết nối n8n:
Để Dashboard kích hoạt được n8n từ xa mà không cần đăng nhập vào n8n:
1. Trong n8n workflow, chúng ta thêm 1 node **Webhook Trigger** (Method: `POST`) chạy song song với các node `Schedule Trigger`:
   * `/webhook/trigger-publish` ➔ Luồng Đăng bài tự động
   * `/webhook/trigger-generate-images` ➔ Luồng Tạo ảnh AI
   * `/webhook/trigger-generate-content` ➔ Luồng Tạo content
2. Khi người dùng bấm nút trên Dashboard:
   * Frontend gửi request tới backend Express: `POST /api/n8n/trigger/:action`
   * Backend Express gọi vào Webhook của n8n (`http://host.docker.internal:5678/webhook/...` hoặc `http://172.29.192.1:5678/...`).
   * Phản hồi trạng thái ngay lập tức về UI: *"Đã kích hoạt n8n thành công, đang chạy ngầm..."*
   * Terminal Console bên dưới sẽ tự động hiển thị tiến trình khi các node backend được n8n gọi tới.

---

### Phân hệ 2: Form Đăng Nhanh / Cứu Hộ (Direct Quick Publisher)

Dành cho chủ content muốn đăng ngay 1 bài mà không cần sửa Google Sheets:

#### Dữ liệu đầu vào:
* **Media URL:** Hỗ trợ cả 3 dạng:
  * Link Google Drive Video (file lẻ).
  * Link Google Drive Folder (chứa nhiều slide ảnh).
  * Link download trực tiếp (`https://...`).
* **Caption / FullMessage:** Text bài đăng (hỗ trợ hashtag, xuống dòng).
* **Kênh phân phối (Checkboxes):**
  * `[x] TikTok`: Đẩy vào kênh TikTok qua Buffer (`BUFFER_TIKTOK_CHANNEL_ID`).
  * `[x] Facebook Page`: Đẩy vào Fanpage qua Buffer (`BUFFER_FB_PAGE_CHANNEL_ID`).
  * `[x] Facebook Group`: Đẩy vào Group qua Buffer Notification (`BUFFER_FB_GROUP_CHANNEL_ID`).
* **Tùy chọn cấu hình:**
  * `Watermark`: Bật/Tắt, vị trí (diagonal/top-right), độ mờ (0.15).
  * `Chế độ xuất bản`:
    * **Lưu nháp (Draft - Khuyên dùng):** Đẩy sang Buffer để chủ content vào xem trước rồi mới hẹn giờ/bấm đăng.
    * **Đăng ngay (Share Now):** Đăng thẳng lên Page/TikTok không qua bước duyệt nháp.

#### API Backend xử lý: `POST /api/direct-publish`
Backend sẽ tự động:
1. Nhận diện URL là Video hay Folder ảnh.
2. Nếu là Video ➔ Tải Drive ➔ Gắn Watermark qua FFmpeg ➔ Đẩy sang các kênh được chọn.
3. Nếu là Folder ảnh ➔ Quét danh sách ảnh ➔ Sắp xếp tự nhiên `slide_1 -> slide_2 -> slide_3` ➔ Chuẩn hóa JPEG Sharp ➔ Đẩy sang các kênh được chọn.
4. Ghi thông tin vào `data/posts.json` để hiển thị ngay trên bảng lịch sử bài đăng.

---

### Phân hệ 3: Quản Lý Lịch Sử Bài Đăng & Duyệt Buffer (Posts & Approval Table)

#### Nguồn dữ liệu chuẩn hóa: `data/posts.json`
Mỗi khi có bài đăng từ n8n hoặc từ Form Đăng Nhanh, backend ghi nhận vào file này:

```json
[
  {
    "id": "post_1788402542112",
    "post_id": "6a98db740e7870bed4e4bbb3",
    "platform": "tiktok",
    "type": "VIDEO",
    "title": "📌 ĐỪNG CHỈ NHÌN GIÁ CON GIỐNG, HÃY NHÌN CẢ KHẢ NĂNG CHO TRỨNG",
    "caption": "Nội dung đầy đủ của bài viết...",
    "status": "DRAFT_IN_BUFFER",
    "created_at": "2026-09-03T02:29:05.426Z",
    "media": {
      "type": "video",
      "preview_url": "https://bladder-unretired-froth.ngrok-free.dev/tmp/wm_video_1788402542112.mp4",
      "watermarked": true
    },
    "buffer": {
      "channel_id": "6a9127f8ccaf649a6730ed06",
      "channel_name": "gaaicap2 (TikTok)",
      "buffer_post_id": "6a98db740e7870bed4e4bbb3",
      "approval_url": "https://publish.buffer.com"
    }
  }
]
```

#### Tính năng trên bảng bài đăng:
* **Badge trạng thái thông minh:**
  * 🟡 `DRAFT_IN_BUFFER`: Đang ở bản nháp Buffer, chờ duyệt.
  * 🔵 `NOTIFICATION_PENDING`: Đang chờ mở app điện thoại xác nhận (đối với Group).
  * 🟢 `PUBLISHED`: Đã xuất bản chính thức lên mạng xã hội.
  * 🔴 `ERROR`: Lỗi xử lý hoặc lỗi API.
* **Hành động 1-Click:**
  * Nút **"Mở Buffer ↗"**: Click một cái là mở ngay tab Buffer trên trình duyệt để kiểm tra preview và bấm `Schedule Post` / `Share Now`.
  * Nút **"Xem Media"**: Mở pop-up xem nhanh video hoặc bộ ảnh đã đóng watermark trước khi duyệt.
* **Bộ lọc & Tìm kiếm:** Lọc theo kênh (TikTok, Page, Group), lọc theo trạng thái, tìm kiếm từ khóa trong tiêu đề.

---

### Phân hệ 4: Live Terminal Console (Real-time SSE Logs)

* Sử dụng cơ chế **Server-Sent Events (SSE)** thông qua `GET /api/logs`.
* Khi backend thực hiện bất kỳ thao tác nào (tải Google Drive, render FFmpeg, gọi Buffer GraphQL API), log sẽ được đẩy tức thì xuống Dashboard qua EventEmitter (`src/utils/logger.util.js`).
* Người vận hành chỉ cần nhìn vào màn hình web là biết video đã render được bao nhiêu %, Buffer đã trả về ID gì, không cần phải mở cửa sổ Terminal của Windows.

---

## 4. Danh Sách API Endpoints Mới Của Backend

Toàn bộ API mới được gom vào file `src/routes/dashboard.routes.js`:

| Method | Endpoint | Mô tả |
|:---|:---|:---|
| `GET` | `/dashboard` | Phục vụ file giao diện HTML tĩnh (`public/dashboard.html`) |
| `GET` | `/api/posts` | Danh sách bài đăng (hỗ trợ phân trang `?page=1&limit=20`, filter `?platform=&status=`) |
| `GET` | `/api/posts/stats` | Thống kê số lượng: tổng bài, bài theo từng kênh, bài nháp, bài đã đăng |
| `GET` | `/api/logs` | Stream log thời gian thực qua Server-Sent Events (SSE) |
| `POST` | `/api/n8n/trigger` | Kích hoạt các luồng n8n: `{ workflow: "publish" \| "images" \| "content" }` |
| `POST` | `/api/direct-publish` | Form đăng nhanh trực tiếp (nhận link Drive, caption, chọn kênh, watermark) |

---

## 5. Quy Trình 8 Bước Triển Khai (Dành Cho AI Agent Thực Thi)

Kế hoạch được chia thành các bước nhỏ, tuần tự, độc lập và **tuyệt đối không làm ảnh hưởng đến các router cũ đang hoạt động**:

```
Bước 1: [Tiện ích] Hoàn thiện `src/utils/logger.util.js` (Singleton EventEmitter phát log terminal + SSE).
Bước 2: [Dữ liệu] Khởi tạo `data/posts.json` và hàm tiện ích ghi log bài đăng tập trung.
Bước 3: [Backend Router] Tạo `src/routes/dashboard.routes.js` chứa toàn bộ 6 endpoints ở Mục 4.
Bước 4: [Giao diện UI] Xây dựng `public/dashboard.html` (Dark mode cao cấp, responsive, thuần HTML/CSS/JS).
Bước 5: [Tích hợp n8n] Thêm Webhook Trigger vào n8n workflow để Dashboard có thể bắn lệnh chạy.
Bước 6: [Đồng bộ Router cũ] Thêm 2 dòng ghi `posts.json` vào cuối các route TikTok & FB hiện có.
Bước 7: [Mount Server] Khai báo router và static folder trong `index.js`.
Bước 8: [Kiểm thử toàn diện] Test kích hoạt n8n từ web, test form đăng nhanh, test SSE log.
```

---

## 6. Tiêu Chí Nghiệm Thu (Acceptance Criteria)

1. **Về giao diện:**
   * Mở `http://localhost:3001/dashboard` hiển thị đầy đủ 4 khối chức năng mượt mà, không giật lag.
   * Giao diện responsive chạy tốt cả trên máy tính và trình duyệt điện thoại.
2. **Về điều khiển n8n:**
   * Bấm nút `[▶️ Chạy Đăng Bài Ngay]` trên Dashboard ➔ n8n workflow tự động chạy ➔ Live Log trên Dashboard hiển thị tiến trình.
3. **Về đăng nhanh:**
   * Dán link Drive + Caption trên Dashboard ➔ Bấm đăng ➔ Bài được xử lý watermark và xuất hiện ngay trên Buffer.
4. **Về an toàn hệ thống:**
   * Các luồng cũ chạy từ Google Sheets và n8n tự động hàng ngày vẫn hoạt động ổn định 100%, không bị ảnh hưởng hay thay đổi logic.
