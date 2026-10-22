# Ecolar Content Automation Platform (Content Flow)

Hệ thống tự động hóa sáng tạo, kiểm duyệt và phân phối nội dung đa kênh (TikTok, Facebook Fanpage, Facebook Group). Hệ thống kết hợp giữa Google Workspace (Sheets, Drive), n8n Workflow Engine, Node.js Media Processor và Buffer API / TikTok Direct API.

---

## Mục Lục

1. [Tổng Quan Hệ Thống](#tổng-quan-hệ-thống)
2. [Kiến Trúc Hệ Thống](#kiến-trúc-hệ-thống)
3. [Chi Tiết Các Phân Hệ Chức Năng](#chi-tiết-các-phân-hệ-chức-năng)
   - [Phân hệ 1: Quản lý Content và Đồng bộ Google Sheets](#phân-hệ-1-quản-lý-content-và-đồng-bộ-google-sheets)
   - [Phân hệ 2: Điều khiển n8n và Giám sát Tự động](#phân-hệ-2-điều-khiển-n8n-và-giám-sát-tự-động)
   - [Phân hệ 3: Quản lý Hàng đợi và Duyệt đăng Buffer](#phân-hệ-3-quản-lý-hàng-đợi-và-duyệt-đăng-buffer)
   - [Phân hệ 4: Đăng trực tiếp không qua Sheets (Direct Publisher)](#phân-hệ-4-đăng-trực-tiếp-không-qua-sheets-direct-publisher)
   - [Phân hệ 5: Xử lý Media và Render Engine](#phân-hệ-5-xử-lý-media-và-render-engine)
   - [Phân hệ 6: Background Worker và Tự động Cập nhật Báo cáo](#phân-hệ-6-background-worker-và-tự-động-cập-nhật-báo-cáo)
4. [Cơ Chế Bảo Mật và Phân Quyền (Mutation Guard)](#cơ-chế-bảo-mật-và-phân-quyền-mutation-guard)
5. [Cấu Trúc Thư Mục](#cấu-trúc-thư-mục)
6. [Yêu Cầu Hệ Thống](#yêu-cầu-hệ-thống)
7. [Hướng Dẫn Cài Đặt và Khởi Chạy](#hướng-dẫn-cài-đặt-và-khởi-chạy)
8. [Danh Sách Giao Diện Web Dashboard](#danh-sách-giao-diện-web-dashboard)
9. [Bảng Tham Chiếu Biến Môi Trường (.env)](#bảng-tham-chiếu-biến-môi-trường-env)
10. [Nguyên Tắc Bảo Mật Thông Tin Dự Án](#nguyên-tắc-bảo-mật-thông-tin-dự-án)

---

## Tổng Quan Hệ Thống

Ecolar Content Automation Platform là giải pháp toàn diện giúp vận hành chuỗi sản xuất và phân phối nội dung tiếp thị:
- **Thu thập và Khởi tạo ý tưởng:** Lưu trữ chủ đề, prompt và thông tin định hướng trên Google Sheets.
- **Tự động hóa sáng tạo nội dung bằng AI:** n8n tích hợp mô hình Google Gemini và OpenAI để sinh 3 phương án bài viết (Option 1, Option 2, Option 3), đồng thời hỗ trợ sinh ảnh minh họa hoặc kích hoạt bộ render.
- **Kiểm duyệt và Hiệu chỉnh tập trung:** Cung cấp Web Dashboard giao diện trực quan giúp Content Leader xem trước hình ảnh từ Drive, chọn option tối ưu, biên tập caption và duyệt hàng loạt.
- **Phân phối đa kênh tự động:** Đẩy bài sang Buffer để phân phối tới TikTok, Facebook Fanpage, Facebook Group, hoặc xuất bản trực tiếp qua TikTok Content Posting API.
- **Khép kín vòng đời dữ liệu:** Background worker liên tục theo dõi trạng thái bài đăng trên Buffer, khi xuất bản thành công sẽ tự động lấy permalink thực tế ghi ngược về Google Sheets phục vụ báo cáo và lưu trữ.

---

## Kiến Trúc Hệ Thống

Hệ thống vận hành dựa trên mô hình 4 tầng độc lập kết nối qua REST API nội bộ:

```
+-----------------------------------------------------------------------------+
| TẦNG 1: DỮ LIỆU & TÀI NGUYÊN (Google Cloud Platform)                        |
| - Google Sheets: Tab "Content Selector" (kế hoạch) và "Publish Content"     |
| - Google Drive: Thư mục chứa media gốc (video raw, ảnh thực tế)             |
+--------------------------------------|--------------------------------------+
                                       |
+--------------------------------------v--------------------------------------+
| TẦNG 2: N8N WORKFLOW ENGINE (Docker: Port 5678)                             |
| - Workflow: content-flow-V2-official.json (112 nodes)                       |
| - Các trigger: Manual Trigger, Schedule Cron, Webhook Receiver              |
| - AI Agents: Google Gemini (Chat & Text), OpenAI                            |
+--------------------------------------|--------------------------------------+
                                       | (Gọi API nội bộ: host.docker.internal:3001)
+--------------------------------------v--------------------------------------+
| TẦNG 3: BACKEND NODE.JS HELPER & DASHBOARD (Express: Port 3001)             |
| - Web Dashboard: Portal Hub, Content Management, Buffer Manager, Automation |
| - Media Processor: FFmpeg Watermark, Puppeteer HTML Render, Sharp Panorama  |
| - Background Worker: Quét hàng đợi Buffer mỗi 45 giây và đồng bộ Sheets     |
+--------------------------------------|--------------------------------------+
                                       | (Buffer GraphQL API / Direct Social APIs)
+--------------------------------------v--------------------------------------+
| TẦNG 4: KÊNH XUẤT BẢN & PHÂN PHỐI                                           |
| - TikTok Channel                                                            |
| - Facebook Fanpage                                                          |
| - Facebook Group                                                            |
+-----------------------------------------------------------------------------+
```

---

## Chi Tiết Các Phân Hệ Chức Năng

### Phân hệ 1: Quản lý Content và Đồng bộ Google Sheets
- **Đường dẫn truy cập:** `http://localhost:3001/content` và `http://localhost:3001/content/:row_number`
- **Đồng bộ hai chiều:**
  - Đọc và hiển thị danh sách bài viết từ tab `Content Selector`.
  - Cung cấp hai chế độ hiển thị: Card View (dạng thẻ trực quan) và Table View (dạng bảng dữ liệu).
  - Hỗ trợ lọc nhanh theo trạng thái (`Chưa duyệt`, `Đã duyệt`, `Lỗi`, `Đã đăng`) và theo kênh (`TikTok`, `FB Page`, `FB Group`).
- **Thao tác hàng loạt (Bulk Actions):**
  - `Approve Batch`: Phê duyệt đồng thời nhiều bài viết đã chọn.
  - `Schedule Batch`: Tự động phân bổ lịch hẹn đăng cách nhau theo khoảng thời gian tùy chọn.
  - `Channel Batch`: Đổi kênh xuất bản hàng loạt.
  - `Delete Batch`: Xóa dữ liệu trên Google Sheets trực tiếp từ Dashboard.
  - `Publish Selected`: Đẩy trực tiếp các bài đã duyệt sang hàng đợi Buffer mà không cần chờ lịch quét định kỳ.
- **Trang biên tập chi tiết bài viết:**
  - Lựa chọn 1 trong 3 phương án nội dung do AI tạo ra (Option 1, 2, 3).
  - Hiệu chỉnh Tiêu đề, Caption, Hashtag và Thời gian xuất bản.
  - Tự động lấy ảnh thu nhỏ (Thumbnails) từ liên kết Google Drive đính kèm.
  - Tính năng nhân bản bài viết (Duplicate Post): Kích hoạt webhook n8n để sao chép bài viết sang hàng mới.

### Phân hệ 2: Điều khiển n8n và Giám sát Tự động
- **Đường dẫn truy cập:** `http://localhost:3001/automation`
- **Kiểm soát trạng thái n8n:**
  - Health check trạng thái Docker container n8n (`Running` / `Stopped`).
  - Hiển thị thông tin phiên thực thi gần nhất (Execution Status, Start time, Duration).
- **Kích hoạt luồng trực tiếp không cần mở canvas n8n:**
  - `Tạo Content`: Gọi Webhook `trigger-generate-content` hoặc Management API.
  - `Tạo Ảnh AI`: Gọi Webhook `trigger-generate-images`.
  - `Đăng Bài`: Gọi Webhook `trigger-publish`.
  - `Xử lý theo dòng`: Kích hoạt quy trình cho duy nhất một số dòng cụ thể trên Google Sheets.
- **Cơ chế dừng khẩn cấp:**
  - Nút `Dừng khẩn cấp`: Kết nối n8n API để dừng ngay các execution đang chạy hoặc bị treo.
- **Live Server Logs:**
  - Truyền phát log thời gian thực từ Express server về trình duyệt qua Server-Sent Events (SSE).

### Phân hệ 3: Quản lý Hàng đợi và Duyệt đăng Buffer
- **Đường dẫn truy cập:** `http://localhost:3001/buffer`
- **Quản lý hàng đợi đa kênh:**
  - Theo dõi bài viết đang nằm trong Queue của từng kênh riêng biệt (`TikTok`, `FB Page`, `FB Group`).
  - Kiểm tra hạn mức bài đăng còn lại trong tháng trên từng kênh (`Buffer Quota`).
- **Xuất bản ngay lập tức (Publish Now):**
  - Bỏ qua lịch hẹn, đẩy bài viết xuất bản ngay lập tức lên mạng xã hội.
- **Quản trị hàng đợi:**
  - Chỉnh sửa nội dung caption, đổi giờ hẹn đăng hoặc xóa bài khỏi hàng đợi Buffer.
  - Làm mới liên kết media đã hết hạn (refresh signed URLs).
  - Cập nhật hoặc đổi `BUFFER_ACCESS_TOKEN` trực tiếp ngay trên giao diện.

### Phân hệ 4: Đăng trực tiếp không qua Sheets (Direct Publisher)
- Phục vụ các tình huống phát sinh khẩn cấp:
  - Nhập trực tiếp đường dẫn video hoặc thư mục ảnh từ Google Drive.
  - Nhập caption, hashtag và chọn kênh xuất bản.
  - Backend tự động tải file, xử lý watermark, tối ưu dung lượng và đẩy thẳng sang Buffer hoặc Direct API mà không cần tạo dòng trên Sheets.

### Phân hệ 5: Xử lý Media và Render Engine
- **Đóng Watermark Video (`POST /watermark-video`):**
  - Sử dụng binary `ffmpeg-static` tích hợp sẵn.
  - Tải video từ Drive, ghép logo thương hiệu (`assets/logo.png` hoặc `ecolar-logo.png`) vào video theo tọa độ, độ mờ và kích thước mong muốn.
- **Render Banner từ HTML/CSS (`POST /render-html`, `POST /render-template`):**
  - Khởi tạo Headless Chrome qua `puppeteer`.
  - Nạp template mẫu (quote, infographic, thông báo) kèm biến động để chụp ảnh PNG/JPEG chất lượng cao.
- **Xử lý và Cắt ảnh Panorama (`POST /split-panorama`):**
  - Sử dụng thư viện `sharp` để cắt 1 ảnh toàn cảnh thành 2-3 ảnh vuông tỉ lệ 1:1, phục vụ đăng album ảnh vuốt mượt trên mạng xã hội.
- **Facebook Resumable Upload (`POST /upload-video`):**
  - Hỗ trợ tải các video dung lượng lớn lên Facebook Graph API theo giao thức phân đoạn (chunked resumable upload), tránh lỗi timeout.
- **TikTok Direct Posting API (`/tiktok/*`):**
  - Xác thực OAuth 2.0 lưu token cục bộ.
  - Hỗ trợ đăng video và album ảnh trực tiếp qua TikTok Content Posting API v2.

### Phân hệ 6: Background Worker và Tự động Cập nhật Báo cáo
- Trong `index.js`, một tác vụ nền được thiết lập chạy định kỳ:
  - Chu kỳ: Mỗi 45 giây (và chạy lần đầu 5 giây sau khi bật server).
  - Hoạt động: Đọc danh sách theo dõi từ file `data/tracked_queue.json`, truy vấn trạng thái bài viết từ Buffer GraphQL API.
  - Khi bài viết chuyển sang trạng thái `sent`: Thu thập ID bài đăng và permalink thực tế trên mạng xã hội, ghi trực tiếp vào tab `Publish Content` của Google Sheets, cập nhật mốc thời gian hoàn thành.

---

## Cơ Chế Bảo Mật và Phân Quyền (Mutation Guard)

Express Backend tích hợp middleware kiểm soát truy cập nghiêm ngặt (`mutationGuard`) nhằm bảo vệ máy chủ khi mở public qua reverse proxy (như ngrok):

1. **Phạm vi bảo vệ:** Áp dụng cho mọi route thay đổi dữ liệu hoặc tiêu tốn tài nguyên hệ thống:
   - `/api/*`
   - `/upload-*`
   - `/render-*`
   - `/watermark-video`
   - `/split-panorama`
   - `/edit-image-openai`
   - `/tiktok/*` (ngoại trừ `/tiktok/callback` để đón redirect OAuth từ TikTok)
2. **Tiêu chuẩn cho phép:**
   - Request xuất phát từ giao diện Dashboard có Header `Referer` hoặc `Origin` khớp với hostname của server.
   - Request nội bộ trực tiếp không qua reverse proxy (không có `X-Forwarded-For`, IP là Loopback `127.0.0.1`, `localhost` hoặc dải mạng riêng `10.x`, `192.168.x`, `172.x`).
3. **Phản hồi khi vi phạm:** Trả về mã lỗi HTTP 403 Forbidden và ghi log cảnh báo tới hệ thống.

---

## Cấu Trúc Thư Mục

```plaintext
content-flow/
|-- assets/                         # Tài nguyên logo, watermark, ảnh mẫu
|-- data/
|   `-- tracked_queue.json          # Danh sách bài đăng đang được background worker theo dõi
|-- public/                         # File tĩnh phục vụ giao diện
|-- templates/                      # Các trang giao diện Web Dashboard
|   |-- automation.html             # Điều khiển n8n, Direct Publisher và Live Logs
|   |-- buffer.html                 # Quản lý hàng đợi và quota Buffer
|   |-- content-detail.html         # Biên tập nội dung chi tiết & duyệt option AI
|   `-- content-list.html           # Danh sách bài viết từ Sheets & thao tác hàng loạt
|-- src/
|   |-- routes/                     # Các module định tuyến Express
|   |   |-- dashboard.routes.js     # Router chính phục vụ Dashboard và các API quản trị
|   |   |-- facebook.routes.js      # Router upload Facebook Graph (ảnh, video, reels)
|   |   |-- image.routes.js         # Router xử lý cắt ghép ảnh, AI edit
|   |   |-- render.routes.js        # Router render HTML sang ảnh qua Puppeteer
|   |   |-- tiktok.routes.js        # Router xác thực và upload TikTok API
|   |   `-- video.routes.js         # Router tải Drive và watermark video
|   |-- services/                   # Xử lý nghiệp vụ logic
|   |   |-- buffer.service.js       # Buffer GraphQL client và worker đồng bộ
|   |   |-- cloudinary.service.js   # Cloudinary SDK client
|   |   |-- facebook.service.js     # Facebook Graph API client
|   |   |-- openai.service.js       # OpenAI API client
|   |   |-- puppeteer.service.js    # Quản lý Headless Chrome render ảnh
|   |   |-- sheets.service.js       # Google Sheets v4 và Drive v3 client
|   |   |-- tiktok.service.js       # TikTok API client
|   |   `-- watermark.service.js    # Xử lý video với FFmpeg
|   `-- utils/                      # Các module tiện ích
|       |-- drive.util.js           # Xử lý liên kết và ID Google Drive
|       |-- logger.util.js          # Hệ thống ghi log bộ nhớ và console
|       |-- mask.util.js            # Tiện ích xử lý mask hình ảnh
|       `-- posts.util.js           # Chuẩn hóa cấu trúc bài viết
|-- .env.example                    # File mẫu cấu hình biến môi trường
|-- .gitignore                      # Danh sách file và thư mục loại trừ khỏi Git
|-- content-flow-V2-official.json   # File xuất workflow n8n chính thức (112 nodes)
|-- credentials.json                # Khóa xác thực Google Service Account (bảo mật, không commit)
|-- index.html                      # Trang điều hướng Portal trung tâm
|-- index.js                        # Điểm khởi chạy chính của ứng dụng Express
|-- package.json                    # Khai báo thư viện phụ thuộc và scripts
`-- workflow_backup.json            # Bản sao lưu dự phòng của workflow n8n
```

---

## Yêu Cầu Hệ Thống

- **Node.js:** Phiên bản `18.x` trở lên (khuyến nghị Node.js 20 LTS).
- **npm:** Phiên bản `9.x` trở lên.
- **Docker & Docker Compose:** Dùng để chạy n8n workflow engine trên cổng `5678`.
- **Tài khoản và Khóa truy cập dịch vụ:**
  - Google Cloud Project: Bật Google Sheets API và Google Drive API, tạo Service Account và tải file `credentials.json`.
  - Buffer Account: Kết nối các kênh TikTok, Facebook Fanpage, Facebook Group và lấy Access Token.
  - OpenAI / Google Gemini API Key: Khai báo trong n8n phục vụ sinh nội dung.

---

## Hướng Dẫn Cài Đặt và Khởi Chạy

### 1. Cài đặt các thư viện phụ thuộc
Chạy lệnh sau tại thư mục gốc của dự án:
```bash
npm install
```

### 2. Thiết lập biến môi trường (.env)
Tạo file `.env` từ file mẫu:
```bash
cp .env.example .env
```
Điền các giá trị thực tế tương ứng với tài khoản của bạn (xem bảng tham chiếu bên dưới).

### 3. Cấu hình xác thực Google Cloud
1. Đặt file `credentials.json` lấy từ Google Cloud Console vào thư mục gốc dự án:
   ```plaintext
   content-flow/credentials.json
   ```
2. Mở Google Sheet cần quản lý, nhấn nút **Share** và thêm email của Service Account (dạng `xxx@xxx.iam.gserviceaccount.com`) với quyền **Editor**.
3. Chia sẻ thư mục Google Drive chứa hình ảnh/video cho email Service Account với quyền tương tự.

### 4. Khởi chạy Backend Server
- Chế độ phát triển (tự động nạp lại khi cập nhật mã nguồn):
  ```bash
  npm run dev
  ```
- Chế độ vận hành chính thức (Production):
  ```bash
  npm start
  ```
Sau khi chạy, máy chủ mở tại địa chỉ: `http://localhost:3001`

### 5. Khởi chạy và Nạp Workflow vào n8n
1. Khởi chạy container n8n qua Docker:
   ```bash
   docker run -d --name n8n -p 5678:5678 -v n8n_data:/home/node/.n8n n8nio/n8n
   ```
2. Mở trình duyệt tại `http://localhost:5678`.
3. Chọn **Import from File** và chọn file `content-flow-V2-official.json`.
4. Cấu hình Credentials tương ứng (Google Sheets, Google Drive, Gemini, OpenAI) trong n8n và chuyển workflow sang trạng thái **Active**.
5. Lấy API Key của n8n (Settings > n8n API) và khai báo vào biến `N8N_API_KEY` trong file `.env` của backend.

---

## Danh Sách Giao Diện Web Dashboard

| Đường dẫn URL | Tên màn hình | Chức năng chính |
| :--- | :--- | :--- |
| `http://localhost:3001/` | Portal Navigation | Trang chủ điều hướng trung tâm |
| `http://localhost:3001/content` | Content Hub | Danh sách bài viết, bộ lọc trạng thái, thao tác duyệt và hẹn giờ hàng loạt |
| `http://localhost:3001/content/:row` | Content Editor | Chỉnh sửa nội dung, lựa chọn 1 trong 3 option AI, xem ảnh Drive của từng bài |
| `http://localhost:3001/buffer` | Buffer Manager | Theo dõi hàng đợi từng kênh, kiểm tra quota, xuất bản ngay lập tức |
| `http://localhost:3001/automation` | Automation Center | Giám sát n8n, kích hoạt workflow, đăng cứu hộ trực tiếp, xem live logs |

---

## Bảng Tham Chiếu Biến Môi Trường (.env)

| Tên biến | Yêu cầu | Giá trị mặc định | Giải thích chi tiết |
| :--- | :---: | :--- | :--- |
| `PORT` | Không | `3001` | Cổng dịch vụ Express lắng nghe |
| `BASE_URL` | Có | `http://localhost:3001` | URL gốc của backend (Local hoặc tên miền Ngrok) |
| `GOOGLE_SHEET_ID` | Có | - | ID của bảng tính Google Sheets quản lý bài viết |
| `GOOGLE_SHEET_NAME` | Không | `Content Selector` | Tên tab chứa nội dung cần duyệt |
| `GOOGLE_PUBLISH_SHEET_NAME` | Không | `Publish Content` | Tên tab lưu trữ thông tin các bài đã đăng |
| `GOOGLE_SHEET_GID` | Không | `2121812891` | GID của tab Content Selector |
| `GOOGLE_PUBLISH_SHEET_GID` | Không | `743957638` | GID của tab Publish Content |
| `GOOGLE_SHEET_DATA_START_ROW` | Không | `5` | Dòng bắt đầu chứa dữ liệu bài viết |
| `GOOGLE_CREDENTIALS_PATH` | Không | `./credentials.json` | Đường dẫn đến file Service Account JSON |
| `GOOGLE_API_KEY` | Không | - | Google API Key (hỗ trợ đọc thumbnail Drive) |
| `BUFFER_ACCESS_TOKEN` | Có | - | Token xác thực truy vấn Buffer GraphQL API |
| `BUFFER_TIKTOK_CHANNEL_ID` | Có | - | Channel ID của kênh TikTok trên Buffer |
| `BUFFER_FB_PAGE_CHANNEL_ID` | Có | - | Channel ID của Facebook Fanpage trên Buffer |
| `BUFFER_FB_GROUP_CHANNEL_ID` | Có | - | Channel ID của Facebook Group trên Buffer |
| `N8N_BASE_URL` | Không | `http://localhost:5678` | Địa chỉ kết nối tới n8n service |
| `N8N_API_KEY` | Có | - | API Key dùng để kích hoạt và dừng execution trên n8n |
| `N8N_WORKFLOW_ID` | Không | `uWbys7XrXlEP1iy9` | ID của workflow n8n cần điều khiển |
| `TIKTOK_CLIENT_KEY` | Không | - | Client Key từ TikTok for Developers |
| `TIKTOK_CLIENT_SECRET` | Không | - | Client Secret từ TikTok for Developers |
| `TIKTOK_REDIRECT_URI` | Không | `{BASE_URL}/tiktok/callback` | Callback URL nhận OAuth code từ TikTok |
| `CLOUDINARY_CLOUD_NAME` | Không | - | Tên Cloud trên Cloudinary (nếu sử dụng) |
| `CLOUDINARY_API_KEY` | Không | - | API Key Cloudinary |
| `CLOUDINARY_API_SECRET` | Không | - | API Secret Cloudinary |

---

## Nguyên Tắc Bảo Mật Thông Tin Dự Án

1. **Tuyệt đối không commit các file bí mật lên Git Repository:**
   - Các file và thư mục sau bắt buộc phải có trong `.gitignore`:
     - `.env` (chứa toàn bộ token và secret key)
     - `credentials.json` (chứa private key của Google Cloud Service Account)
     - `token.json` và thư mục `tokens/` (chứa OAuth token của TikTok và mạng xã hội)
     - `ngrok_backend.yml` (chứa authtoken của ngrok)
     - `*.pem`, `*.key` (các chứng chỉ bảo mật)
2. **Kiểm tra trạng thái Git trước khi commit:**
   - Luôn chạy lệnh `git status` để đảm bảo không có file nhạy cảm nào nằm trong danh sách chuẩn bị commit (`Changes to be committed` hoặc `Untracked files`).
3. **Giao tiếp giữa Docker và Máy chủ Host:**
   - Khi cấu hình n8n trong Docker gọi về backend Node.js trên máy host, sử dụng `http://host.docker.internal:3001` thay vì `localhost:3001`.
