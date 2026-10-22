# 🚀 Ecolar Content Automation Platform (Content Flow)

> **Hệ thống tự động hóa sáng tạo, kiểm duyệt và phân phối nội dung đa kênh (TikTok, Facebook Page, Facebook Group) kết hợp Google Sheets, n8n Workflow Engine, Node.js Media Processor và Buffer API.**

---

## 📌 Mục Lục
1. [Tổng quan dự án](#-tổng-quan-dự-án)
2. [Kiến trúc hệ thống](#-kiến-trúc-hệ-thống)
3. [Các tính năng cốt lõi](#-các-tính-năng-cốt-lõi)
4. [Cấu trúc thư mục](#-cấu-trúc-thư-mục)
5. [Yêu cầu hệ thống](#-yêu-cầu-hệ-thống)
6. [Hướng dẫn cài đặt & Khởi chạy](#-hướng-dẫn-cài-đặt--khởi-chạy)
7. [Các đường dẫn Web Dashboard](#-các-đường-dẫn-web-dashboard)
8. [Cấu hình biến môi trường (.env)](#-cấu-hình-biến-môi-trường-env)
9. [Bảo mật & Lưu ý quan trọng](#-bảo-mật--lưu-ý-quan-trọng)

---

## 📖 Tổng Quan Dự Án

**Content Flow** là nền tảng quản trị và tự động hóa toàn bộ quy trình xuất bản nội dung của **Ecolar**, giải quyết triệt để vấn đề phân mảnh giữa đội ngũ Content, Designer và Kỹ thuật:
- **Không còn nhập liệu thủ công:** Ý tưởng và prompt từ Google Sheets được n8n điều phối để gọi AI sinh nội dung và tạo hình ảnh/video tự động.
- **Duyệt bài và Hẹn giờ tập trung:** Toàn bộ quá trình chọn option content, phê duyệt hàng loạt, đổi kênh đăng, chọn hình ảnh/video từ Google Drive đều được thao tác trực quan trên Web Dashboard.
- **Đăng bài đa nền tảng:** Phân phối đồng thời tới **TikTok**, **Facebook Fanpage** và **Facebook Group** thông qua Buffer GraphQL API và các cổng Direct API riêng.
- **Tự động đồng bộ báo cáo:** Worker chạy nền tự động bắt sự kiện xuất bản thành công trên Buffer để ghi ngược đường link bài viết thực tế về tab Google Sheet `Publish Content`.

---

## 🏗 Kiến Trúc Hệ Thống

Hệ thống được thiết kế theo mô hình 4 tầng độc lập nhưng kết nối chặt chẽ qua REST API nội bộ:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ TẦNG 1: DỮ LIỆU & Ý TƯỞNG (Google Sheets & Google Drive)                     │
│ • Lưu trữ chủ đề, prompt, 3 options content, thời gian hẹn đăng             │
│ • Kho lưu trữ media (ảnh banner, video raw) trên Google Drive               │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │
┌──────────────────────────────────────▼──────────────────────────────────────┐
│ TẦNG 2: BỘ NÃO ĐIỀU PHỐI (n8n Workflow Engine - Docker :5678)               │
│ • Quét hàng cần xử lý từ Sheets                                             │
│ • Tích hợp LLMs (Claude / GPT-4 / Gemini) sinh nội dung & copy              │
│ • Gọi DALL-E / Puppeteer tạo ảnh minh họa                                   │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │ (REST API nội bộ: host.docker.internal:3001)
┌──────────────────────────────────────▼──────────────────────────────────────┐
│ TẦNG 3: BACKEND ENGINE & DASHBOARD (Node.js Express :3001)                  │
│ • Web Dashboard: Quản lý hàng bài viết, điều khiển n8n, duyệt hàng đợi Buffer│
│ • Xử lý Media: Tải Drive, đóng Watermark video (FFmpeg), render HTML        │
│   thành ảnh (Puppeteer + Sharp), cắt Panorama, Resumable Upload             │
│ • Background Worker: Định kỳ quét Buffer queue -> sync về Google Sheets     │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │ (Buffer GraphQL API / Direct Social APIs)
┌──────────────────────────────────────▼──────────────────────────────────────┐
│ TẦNG 4: MẠNG XÃ HỘI & PHÂN PHỐI                                             │
│ 📱 TikTok Channel   |   🏢 Facebook Fanpage   |   👥 Facebook Group          │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## ✨ Các Tính Năng Cốt Lõi

### 1. 📋 Content Management & Google Sheets Sync
- Đồng bộ 2 chiều với Google Sheets (tab `Content Selector` và `Publish Content`).
- Xem danh sách bài viết theo thẻ (Card view) hoặc bảng dữ liệu (Table view).
- Phê duyệt hàng loạt (`Approve Batch`), hẹn giờ đăng hàng loạt (`Schedule Batch`), chuyển kênh phân phối hàng loạt (`Channel Batch`).
- Chọn nhanh 1 trong 3 Option nội dung do AI tạo ra, chỉnh sửa trực tiếp caption, hashtags.
- Tự động quét và lấy ảnh xem trước (Thumbnails) từ thư mục Google Drive đính kèm.

### 2. ⚡ Trung Tâm Điều Khiển n8n (Automation Center)
- Theo dõi trạng thái hoạt động của Docker Container n8n (`Running` / `Stopped`).
- Kích hoạt n8n trực tiếp từ Dashboard:
  - **Tạo Content mới:** Gọi workflow sinh nội dung từ prompt/chủ đề.
  - **Tạo Ảnh AI:** Gọi workflow sinh ảnh minh họa.
  - **Đăng bài:** Kích hoạt quét và đẩy các bài đã duyệt sang Buffer.
- Kích hoạt xử lý cho **từng dòng cụ thể** hoặc **dừng khẩn cấp** execution đang chạy.
- Trình xem Log hệ thống thời gian thực (Live Log Viewer) phục vụ debug.

### 3. 📱 Quản Lý Hàng Đợi Buffer (Buffer Control)
- Quản lý hàng đợi bài đăng theo từng kênh (`TikTok`, `Facebook Page`, `Facebook Group`).
- Nút **Publish Now**: Đăng bài ngay lập tức ra mạng xã hội mà không cần chờ đến giờ hẹn.
- Chỉnh sửa nội dung, đổi lịch đăng (re-schedule) hoặc xoá bài trong queue.
- **Auto-Sync Worker:** Background worker chạy mỗi 45 giây kiểm tra các bài chuyển trạng thái `sent` trên Buffer để lấy permalink bài viết thật ghi vào Google Sheets.

### 4. 🚀 Đăng Cứu Hộ / Đăng Nhanh (Direct Publisher)
- Bỏ qua toàn bộ quy trình Google Sheets khi cần đăng gấp:
  - Nhập đường link Google Drive (video hoặc folder ảnh).
  - Chọn kênh xuất bản (`TikTok`, `FB Page`, `FB Group`).
  - Hệ thống tự động tải file, đóng watermark, đẩy thẳng lên Buffer hoặc Direct API.

### 5. 🎨 Media & Render Engine
- **Video Watermarking:** Sử dụng `ffmpeg-static` để đóng logo thương hiệu tự động vào góc video với tỉ lệ khung hình chuẩn.
- **HTML-to-Image Rendering:** Dùng `puppeteer` chụp ảnh các template HTML/CSS chất lượng cao (dành cho bài đăng quote, infographic, thông báo).
- **Image Processing:** Tối ưu hóa dung lượng, resize, cắt ghép ảnh panorama với `sharp`.
- **Facebook Resumable Upload:** Hỗ trợ upload video dung lượng lớn qua Graph API resumable protocol mà không bị timeout.

### 6. 🛡️ Bảo Mật & Mutation Guard
- Middleware `mutationGuard` ngăn chặn triệt để các request trái phép từ bên ngoài Internet gọi vào các endpoint thay đổi dữ liệu hoặc tốn tài nguyên GPU/CPU.
- Chỉ cho phép request nội bộ (LAN / Docker Loopback / Dashboard có cùng hostname).

---

## 📁 Cấu Trúc Thư Mục

```plaintext
content-flow/
├── assets/                    # File tài nguyên tĩnh (logo, font, watermark)
├── public/                    # Giao diện tĩnh & stylesheet
├── templates/                 # Các trang HTML Dashboard
│   ├── automation.html        # Trung tâm điều khiển n8n & Live Logs
│   ├── buffer.html            # Giao diện quản lý hàng đợi Buffer
│   ├── content-detail.html    # Trang chi tiết chỉnh sửa 1 bài viết
│   └── content-list.html      # Bảng danh sách & phê duyệt bài viết
├── src/
│   ├── routes/                # API Endpoints chia theo module
│   │   ├── dashboard.routes.js# Toàn bộ router cho UI & API điều khiển
│   │   ├── facebook.routes.js # Upload ảnh, video, reels Facebook
│   │   ├── image.routes.js    # Cắt ghép ảnh, AI edit
│   │   ├── render.routes.js   # Puppeteer render HTML -> Ảnh
│   │   ├── tiktok.routes.js   # TikTok OAuth & Direct Publishing
│   │   └── video.routes.js    # Tải Drive & đóng watermark video
│   ├── services/              # Logic xử lý nghiệp vụ
│   │   ├── buffer.service.js  # Buffer GraphQL API & Queue Sync Worker
│   │   ├── cloudinary.service.js # Upload media Cloudinary
│   │   ├── facebook.service.js# Facebook Graph API
│   │   ├── openai.service.js  # Tích hợp OpenAI DALL-E / GPT
│   │   ├── puppeteer.service.js # Headless browser render
│   │   ├── sheets.service.js  # Google Sheets v4 & Drive v3 API
│   │   ├── tiktok.service.js  # TikTok Content Posting API
│   │   └── watermark.service.js # FFmpeg đóng dấu video
│   └── utils/                 # Hàm tiện ích chung (parser, helper, token)
├── .env.example               # Mẫu biến môi trường
├── .gitignore                 # Chặn commit thông tin nhạy cảm
├── credentials.json           # Google Cloud Service Account (KHÔNG commit)
├── content-flow-V2-with-duplicate.json # n8n Workflow export
├── index.html                 # Trang Portal Hub điều hướng chính
├── index.js                   # Điểm khởi chạy Express Server chính
└── package.json               # Dependencies & npm scripts
```

---

## 💻 Yêu Cầu Hệ Thống

* **Node.js:** Phiên bản `>= 18.x` (khuyến nghị Node 20 LTS).
* **Docker & Docker Compose:** Dùng để chạy n8n workflow engine.
* **Tài khoản & Dịch vụ liên kết:**
  * **Google Cloud Project:** Đã kích hoạt *Google Sheets API* và *Google Drive API*. Tạo Service Account và tải file key `credentials.json`.
  * **Buffer Account:** Lấy `BUFFER_ACCESS_TOKEN` từ trang cá nhân Buffer hoặc qua GraphQL API.
  * **Cloudinary (Tuỳ chọn):** Tài khoản lưu trữ ảnh/video đám mây.
  * **TikTok Developer App (Tuỳ chọn):** Nếu dùng TikTok Direct API.

---

## 🚀 Hướng Dẫn Cài Đặt & Khởi Chạy

### Bước 1: Cài đặt Dependencies
```bash
git clone <URL_REPO_CUA_BAN>
cd content-flow
npm install
```

### Bước 2: Cấu hình File Môi Trường (.env)
Sao chép file mẫu và điền các thông tin bí mật:
```bash
cp .env.example .env
```
*(Chi tiết các biến xem tại mục [Cấu hình biến môi trường](#-cấu-hình-biến-môi-trường-env)).*

### Bước 3: Cấu hình Google Credentials
1. Tải file Service Account JSON từ Google Cloud Console.
2. Đổi tên thành `credentials.json` và đặt tại thư mục gốc của project:
   ```plaintext
   content-flow/credentials.json
   ```
3. Chia sẻ quyền **Editor (Chỉnh sửa)** của Google Sheet và thư mục Google Drive cho địa chỉ email của Service Account (dạng `xxx@xxx.iam.gserviceaccount.com`).

### Bước 4: Khởi chạy Backend Server
* Chế độ Development (tự reload khi sửa code):
  ```bash
  npm run dev
  ```
* Chế độ Production:
  ```bash
  npm start
  ```
Server sẽ lắng nghe tại: `http://localhost:3001`

### Bước 5: Cài đặt và Import n8n Workflow
1. Khởi chạy n8n qua Docker (nếu chưa có):
   ```bash
   docker run -d --name n8n -p 5678:5678 -v n8n_data:/home/node/.n8n n8nio/n8n
   ```
2. Mở trình duyệt vào `http://localhost:5678`.
3. Import file workflow [content-flow-V2-with-duplicate.json](file:///d:/content-flow/content-flow-V2-with-duplicate.json).
4. Thiết lập Webhook và gán `N8N_API_KEY` vào file `.env`.

---

## 🌐 Các Đường Dẫn Web Dashboard

Sau khi server khởi chạy, bạn có thể truy cập trực tiếp các giao diện:

| Đường dẫn | Mục đích |
| :--- | :--- |
| **`http://localhost:3001/`** | **Portal Hub**: Trang chủ điều hướng trung tâm |
| **`http://localhost:3001/content`** | **Content Hub**: Bảng danh sách bài viết từ Sheets, duyệt bài & hẹn giờ |
| **`http://localhost:3001/content/:row`** | **Content Detail**: Chỉnh sửa chi tiết nội dung, media của 1 hàng |
| **`http://localhost:3001/buffer`** | **Buffer Queue**: Giám sát hàng đợi các kênh, publish ngay lập tức |
| **`http://localhost:3001/automation`** | **n8n Controller**: Trạng thái n8n, kích hoạt flow, live logs |

---

## ⚙ Cấu Hình Biến Môi Trường (.env)

| Tên biến | Bắt buộc | Mô tả | Mặc định |
| :--- | :---: | :--- | :--- |
| `PORT` | Không | Cổng Express server chạy | `3001` |
| `BASE_URL` | Có | URL gốc của server (Localhost hoặc Ngrok URL) | `http://localhost:3001` |
| `GOOGLE_SHEET_ID` | Có | ID của Google Sheet quản lý bài viết | - |
| `GOOGLE_SHEET_NAME` | Không | Tên Tab chứa ý tưởng/bài viết | `Content Selector` |
| `GOOGLE_PUBLISH_SHEET_NAME`| Không | Tên Tab lưu trữ bài đã xuất bản | `Publish Content` |
| `GOOGLE_CREDENTIALS_PATH` | Không | Đường dẫn tới file Google Service Account | `./credentials.json` |
| `BUFFER_ACCESS_TOKEN` | Có | Access token lấy từ Buffer GraphQL / Dashboard | - |
| `BUFFER_TIKTOK_CHANNEL_ID` | Có | Channel ID của kênh TikTok trên Buffer | - |
| `BUFFER_FB_PAGE_CHANNEL_ID`| Có | Channel ID của Facebook Fanpage trên Buffer | - |
| `BUFFER_FB_GROUP_CHANNEL_ID`| Có| Channel ID của Facebook Group trên Buffer | - |
| `N8N_BASE_URL` | Không | Địa chỉ của n8n container | `http://localhost:5678` |
| `N8N_API_KEY` | Có (nếu dùng trigger)| API Key n8n để kích hoạt và dừng workflow | - |
| `N8N_WORKFLOW_ID` | Không | ID của workflow chính trong n8n | - |
| `CLOUDINARY_CLOUD_NAME` | Tuỳ chọn | Tên Cloudinary Cloud | - |
| `CLOUDINARY_API_KEY` | Tuỳ chọn | API Key Cloudinary | - |
| `CLOUDINARY_API_SECRET` | Tuỳ chọn | API Secret Cloudinary | - |
| `TIKTOK_CLIENT_KEY` | Tuỳ chọn | Client Key của TikTok App | - |
| `TIKTOK_CLIENT_SECRET` | Tuỳ chọn | Client Secret của TikTok App | - |

---

## 🔒 Bảo Mật & Lưu Ý Quan Trọng

1. **Tuyệt đối không commit file thông tin mật lên Git:**
   - Đảm bảo các file sau luôn có trong `.gitignore`:
     - `.env`
     - `credentials.json`
     - `token.json`
     - Thư mục `tokens/`
     - `ngrok_backend.yml`
2. **Quyền truy cập Google Drive:**
   - Để n8n hoặc backend đọc được ảnh/video trong Drive, thư mục Drive đó phải được share quyền **Viewer** hoặc **Editor** cho email Service Account.
3. **Mạng nội bộ trong Docker:**
   - Khi n8n chạy trong Docker muốn gọi về Backend Express trên máy host, hãy sử dụng địa chỉ `http://host.docker.internal:3001` thay vì `localhost:3001`.
