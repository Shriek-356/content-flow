# Ecolar Content Automation Platform (Content Flow)

He thong tu dong hoa sang tao, kiem duyet va phan phoi noi dung da kenh (TikTok, Facebook Fanpage, Facebook Group). He thong ket hop giua Google Workspace (Sheets, Drive), n8n Workflow Engine, Node.js Media Engine va Buffer API / TikTok Direct API.

---

## Muc Luc

1. [Tong Quan He Thong](#tong-quan-he-thong)
2. [Kien Truc He Thong](#kien-truc-he-thong)
3. [Chi Tiet Cac Phan He Chuc Nang](#chi-tiet-cac-phan-he-chuc-nang)
   - [Phan he 1: Quan ly Content va Dong bo Google Sheets](#phan-he-1-quan-ly-content-va-dong-bo-google-sheets)
   - [Phan he 2: Dieu khien n8n va Giam sat Tu dong](#phan-he-2-dieu-khien-n8n-va-giam-sat-tu-dong)
   - [Phan he 3: Quan ly Hang doi va Duyet dang Buffer](#phan-he-3-quan-ly-hang-doi-va-duyet-dang-buffer)
   - [Phan he 4: Dang truc tiep khong qua Sheets (Direct Publisher)](#phan-he-4-dang-truc-tiep-khong-qua-sheets-direct-publisher)
   - [Phan he 5: Xu ly Media va Render Engine](#phan-he-5-xu-ly-media-va-render-engine)
   - [Phan he 6: Background Worker va Dong bo Ket qua](#phan-he-6-background-worker-va-dong-bo-ket-qua)
4. [Co Che Bao Mat va Phan Quyen (Mutation Guard)](#co-che-bao-mat-va-phan-quyen-mutation-guard)
5. [Cau Truc Thu Muc](#cau-truc-thu-muc)
6. [Yeu Cau He Thong](#yeu-cau-he-thong)
7. [Huong Dan Cai Dat va Khoi Chay](#huong-dan-cai-dat-va-khoi-chay)
8. [Danh Sach Giao Dien Web Dashboard](#danh-sach-giao-dien-web-dashboard)
9. [Bang Tham Chieu Bien Moi Truong (.env)](#bang-tham-chieu-bien-moi-truong-env)
10. [Nguyen Tac Bao Mat Thong Tin Du An](#nguyen-tac-bao-mat-thong-tin-du-an)

---

## Tong Quan He Thong

Ecolar Content Automation Platform la giai phap toan dien giup van hanh chuoi san xuat noi dung marketing:
- **Thu thap va Khoi tao y tuong:** Luu tru prompt, chu de va thong tin san pham tren Google Sheets.
- **Tu dong hoa sang tao noi dung bang AI:** n8n ket hop mo hinh Google Gemini va OpenAI de sinh 3 phuong an bai viet (Option 1, Option 2, Option 3), dong thoi sinh anh minh hoa hoac trigger render.
- **Kiem duyet va Hieu chinh tap trung:** Cung cap Dashboard giao dien truc quan giup Content Leader xem truoc anh tu Drive, chon option toi uu, sua caption va duyet hang loat.
- **Phan phoi da kenh tu dong:** Day bai sang Buffer de phan phoi toi TikTok, Facebook Fanpage, Facebook Group, hoac xuat ban truc tiep qua TikTok Content Posting API.
- **Khep kin vong doi du lieu:** Background worker theo doi trang thai bai dang tren Buffer, khi xuat ban thanh cong se lay permalink bai viet thuc te ghi nguoc ve Google Sheets phuc vu do luong va luu tru.

---

## Kien Truc He Thong

He thong van hanh dua tren mo hinh 4 tang doc lap:

```
+-----------------------------------------------------------------------------+
| TANG 1: DU LIEU & TAI NGUYEN (Google Cloud Platform)                        |
| - Google Sheets: Tab "Content Selector" (lap ke hoach) va "Publish Content" |
| - Google Drive: Thu muc chua media goc (video raw, anh chup thuc te)        |
+--------------------------------------|--------------------------------------+
                                       |
+--------------------------------------v--------------------------------------+
| TANG 2: N8N WORKFLOW ENGINE (Docker: Port 5678)                             |
| - Workflow: content-flow-V2-official.json (112 nodes)                       |
| - Cac trigger: Manual Trigger, Schedule Cron, Webhook Receiver              |
| - AI Agents: Google Gemini (Chat & Text), OpenAI                            |
+--------------------------------------|--------------------------------------+
                                       | (Goi API noi bo: host.docker.internal:3001)
+--------------------------------------v--------------------------------------+
| TANG 3: BACKEND NODE.JS HELPER & DASHBOARD (Express: Port 3001)             |
| - Web Dashboard: Portal Hub, Content Management, Buffer Manager, Automation |
| - Media Processor: FFmpeg Watermark, Puppeteer HTML Render, Sharp Panorama  |
| - Background Worker: Kiem tra Buffer queue moi 45 giay va dong bo Sheets    |
+--------------------------------------|--------------------------------------+
                                       | (Buffer GraphQL API / Direct Social APIs)
+--------------------------------------v--------------------------------------+
| TANG 4: KENH XUAT BAN & PHAN PHOI                                           |
| - TikTok Channel                                                            |
| - Facebook Fanpage                                                          |
| - Facebook Group                                                            |
+-----------------------------------------------------------------------------+
```

---

## Chi Tiet Cac Phan He Chuc Nang

### Phan he 1: Quan ly Content va Dong bo Google Sheets
- **Duong dan truy cap:** `http://localhost:3001/content` va `http://localhost:3001/content/:row_number`
- **Dong bo hai chieu:**
  - Doc danh sach hang tu tab `Content Selector`.
  - Hien thi du lieu theo hai che do: Card View (the truc quan) va Table View (bang chi tiet).
  - Ho tro loc nhanh theo trang thai (`Chua duyet`, `Da duyet`, `Loi`, `Da dang`) va kenh phan phoi (`TikTok`, `FB Page`, `FB Group`).
- **Thao tac hang loat (Bulk Actions):**
  - `Approve Batch`: Phe duyet hang loat noi dung duoc chon.
  - `Schedule Batch`: Phan bo gio dang tu dong cach nhau theo khoang thoi gian duoc thiet lap.
  - `Channel Batch`: Chuyen doi kenh xuat ban dong loat cho nhieu bai.
  - `Delete Batch`: Xoa du lieu tren Google Sheets truc tiep tu giao dien.
  - `Publish Selected`: Day truc tiep cac bai da duyet sang Buffer khong can cho cron.
- **Trang bien tap chi tiet bai viet:**
  - Chon 1 trong 3 Option noi dung do AI sinh ra.
  - Chinh sua Tieu de, Caption, Hashtag va Thoi gian xuat ban.
  - Tich hop lay thumbnail xem truoc tu thu muc Google Drive dinh kem.
  - Sao chep noi dung (Duplicate Post): Goi webhook n8n de nhan ban noi dung sang mot hang moi.

### Phan he 2: Dieu khien n8n va Giam sat Tu dong
- **Duong dan truy cap:** `http://localhost:3001/automation`
- **Kiem soat trang thai n8n:**
  - Health check trang thai container n8n dang chay hay dung.
  - Hien thi thong tin ve phien thuc thi gan nhat (Execution status, Start time, Duration).
- **Kich hoat luong tu dong khong can mo n8n:**
  - `Tao Content`: Goi Webhook `trigger-generate-content` hoac Management API.
  - `Tao Anh AI`: Goi Webhook `trigger-generate-images`.
  - `Dang Bai`: Goi Webhook `trigger-publish`.
  - `Xu ly theo dong`: Kich hoat chay quy trinh cho duy nhat mot so thu tu dong cu the tren Sheet.
- **Co che dung khan cap:**
  - Nut `Dung khan cap`: Ket noi toi n8n API de huy cac execution dang chay treo.
- **Live Server Logs:**
  - Truyen thong tin log thoi gian thuc tu Express server qua Server-Sent Events (SSE).

### Phan he 3: Quan ly Hang doi va Duyet dang Buffer
- **Duong dan truy cap:** `http://localhost:3001/buffer`
- **Quan ly hang doi da kenh:**
  - Theo doi cac bai viet dang nam trong Queue cua tung kenh (`TikTok`, `FB Page`, `FB Group`).
  - Kiem tra han muc quota con lai trong thang tren tung kenh Buffer.
- **Xuat ban ngay lap tuc (Publish Now):**
  - Bo qua thoi gian hen gio, day bai viet dang ngay lap tuc len mang xa hoi.
- **Quan tri hang doi:**
  - Chinh sua caption, doi lich dang (re-schedule) hoac xoa bai khoi hang doi Buffer.
  - Lam moi link anh/video da het han (refresh signed media URLs).
  - Cap nhat hoac thay the `BUFFER_ACCESS_TOKEN` truc tiep tren Dashboard.

### Phan he 4: Dang truc tiep khong qua Sheets (Direct Publisher)
- Tinh nang danh cho tinh huong cap bach:
  - Nhap truc tiep duong link file video hoac thu muc anh tren Google Drive.
  - Nhap caption, hashtags va chon kenh muon dang.
  - Backend tu dong tai file, xu ly watermark, upload va day sang kenh ma khong can qua quy trinh tao hang tren Sheets.

### Phan he 5: Xu ly Media va Render Engine
- **Video Watermarking (`POST /watermark-video`):**
  - Su dung binary `ffmpeg-static` tich hop san.
  - Dong logo thuong hieu (`assets/logo.png` hoac `ecolar-logo.png`) vao video theo toa do va kich thuoc tuy bien.
- **Render Banner tu HTML (`POST /render-html`, `POST /render-template`):**
  - Khoi tao Headless Chromium qua `puppeteer`.
  - Nap template HTML/CSS kem du lieu dong de render ra file anh PNG/JPEG chat luong cao.
- **Xu ly va Cat anh Panorama (`POST /split-panorama`):**
  - Su dung thu vien `sharp` de cat 1 anh dai thanh 2-3 anh vuong phuc vu dang album vuot carousel.
- **Facebook Resumable Upload (`POST /upload-video`):**
  - Ho tro upload cac video dung luong lon len Facebook Graph API theo giao thuc chunked upload, chong dut ket noi giua chung.
- **TikTok Direct Posting API (`/tiktok/*`):**
  - Xac thuc OAuth 2.0 va luu token cuc bo.
  - Ho tro dang video va dang album anh truc tiep thong qua TikTok Content Posting API v2.

### Phan he 6: Background Worker va Dong bo Ket qua
- Trong file `index.js`, mot interval worker duoc khoi chay ngam:
  - Chu ky: Moi 45 giay (va 5 giay dau sau khi server khoi dong).
  - Chuc nang: Doc tep tin `data/tracked_queue.json`, kiem tra trang thai cac bai viet da den han tren Buffer.
  - Khi Buffer xac nhan trang thai `sent`: Lay ID bai viet va URL thuc te, ghi vao tab Google Sheet `Publish Content`, cap nhat thoi gian dang va danh dau hoan thanh.

---

## Co Che Bao Mat va Phan Quyen (Mutation Guard)

Express Backend duoc trang bi middleware kiem soat truy cap nghiem ngat (`mutationGuard`) nham bao ve he thong khi mo tunnel ra Internet (vi du qua ngrok):

1. **Pham vi ap dung:** Ap dung cho toan bo cac route thay doi du lieu hoac tieu ton tai nguyen:
   - `/api/*`
   - `/upload-*`
   - `/render-*`
   - `/watermark-video`
   - `/split-panorama`
   - `/edit-image-openai`
   - `/tiktok/*` (ngoai tru `/tiktok/callback` de tiep nhan redirect tu TikTok)
2. **Dieu kien cho phep:**
   - Request xuat phat tu Dashboard co Header `Referer` hoac `Origin` trung khop voi hostname cua server.
   - Request noi bo khong qua proxy nguoc (khong co `X-Forwarded-For` va IP la Loopback `127.0.0.1`, `localhost` hoac dai IP mang LAN noi bo `10.x`, `192.168.x`, `172.x`).
3. **Ket qua khi vi pham:** Server tu choi lap tuc voi HTTP 403 Forbidden va ghi log canh bao.

---

## Cau Truc Thu Muc

```plaintext
content-flow/
|-- assets/                         # Tep tin logo, anh mau thuong hieu
|-- data/
|   `-- tracked_queue.json          # File luu trang thai hang doi de background worker theo doi
|-- public/                         # Tai nguyen tinh cho giao dien
|-- templates/                      # Cac file giao dien Dashboard (HTML, CSS, JS)
|   |-- automation.html             # Giao dien dieu khien n8n, Direct Publish va Live Logs
|   |-- buffer.html                 # Giao dien quan ly hang doi va quota Buffer
|   |-- content-detail.html         # Giao dien bien tap chi tiet bai viet & chon option
|   `-- content-list.html           # Giao dien danh sach bai viet, loc va thao tac hang loat
|-- src/
|   |-- routes/                     # Dinh nghia cac route API Express
|   |   |-- dashboard.routes.js     # API phuc vu Dashboard va dieu phoi he thong
|   |   |-- facebook.routes.js      # API Facebook Graph (anh, video, reels)
|   |   |-- image.routes.js         # API cat anh, AI edit anh
|   |   |-- render.routes.js        # API render HTML/CSS thanh anh qua Puppeteer
|   |   |-- tiktok.routes.js        # API TikTok OAuth va Content Posting
|   |   `-- video.routes.js         # API tai Drive va dong watermark video
|   |-- services/                   # Xu ly logic nghiep vu
|   |   |-- buffer.service.js       # Buffer GraphQL client va logic dong bo
|   |   |-- cloudinary.service.js   # Tich hop Cloudinary SDK
|   |   |-- facebook.service.js     # Facebook Graph API client
|   |   |-- openai.service.js       # Tich hop OpenAI API
|   |   |-- puppeteer.service.js    # Khoi tao va render anh qua Headless Chrome
|   |   |-- sheets.service.js       # Google Sheets v4 va Google Drive v3 client
|   |   |-- tiktok.service.js       # TikTok API client
|   |   `-- watermark.service.js    # Xu ly video voi FFmpeg
|   `-- utils/                      # Cac tien ich ho tro
|       |-- drive.util.js           # Xu ly link va ID Google Drive
|       |-- logger.util.js          # Ghi log he thong
|       |-- mask.util.js            # Xu ly mask anh
|       `-- posts.util.js           # Format va xu ly cau truc bai viet
|-- .env.example                    # File mau khai bao bien moi truong
|-- .gitignore                      # Danh sach loai tru khong commit vao Git
|-- content-flow-V2-official.json   # Tep workflow n8n chinh thuc (112 nodes)
|-- credentials.json                # Google Service Account Key (bao mat, khong commit)
|-- index.html                      # Trang chu Portal dieu huong he thong
|-- index.js                        # Diem khoi chay chinh cua ung dung Node.js
|-- package.json                    # Khai bao goi phu thuoc va scripts
`-- workflow_backup.json            # Ban sao luu workflow n8n
```

---

## Yeu Cau He Thong

- **Node.js:** Toi thieu phien ban `18.x` tro len (khuyen nghi dung Node.js 20 LTS).
- **npm:** Phien ban `9.x` tro len.
- **Docker va Docker Compose:** De khoi chay n8n workflow engine tren cong `5678`.
- **Tai khoan va Quyen truy cap API:**
  - Google Cloud Project: Da bat Google Sheets API va Google Drive API, tao Service Account va tai file `credentials.json`.
  - Buffer Account: Co tai khoan Buffer va tao Channel ket noi voi TikTok, Facebook Fanpage, Facebook Group.
  - OpenAI / Google Gemini API Key: Can thiet cho cac node AI trong n8n.

---

## Huong Dan Cai Dat va Khoi Chay

### 1. Cai dat cac goi phu thuoc
Chay lenh sau tai thu muc goc cua du an:
```bash
npm install
```

### 2. Thiet lap file bien moi truong (.env)
Tao file `.env` tu file mau:
```bash
cp .env.example .env
```
Dien day du cac thong so can thiet vao `.env` (xem chi tiet tai muc Bang Tham Chieu Bien Moi Truong).

### 3. Cau hinh Google Cloud Credentials
1. Dat file `credentials.json` lay tu Google Cloud vao thu muc goc cua du an:
   ```plaintext
   content-flow/credentials.json
   ```
2. Mo Google Sheet quan ly noi dung, nhan nut **Share** va them dia chi email cua Service Account (vi du: `content-bot@your-project.iam.gserviceaccount.com`) voi quyen **Editor**.
3. Chia se thu muc Google Drive chua hinh anh/video cho email Service Account voi quyen tuong tu.

### 4. Khoi chay Backend Server
- Che do phat trien (ho tro tu dong khoi dong lai khi sua code):
  ```bash
  npm run dev
  ```
- Che do san sang hoat dong (Production):
  ```bash
  npm start
  ```
Sau khi khoi dong, server mac dinh hoat dong tai dia chi: `http://localhost:3001`

### 5. Khoi chay va Import Workflow vao n8n
1. Khoi chay n8n thong qua Docker:
   ```bash
   docker run -d --name n8n -p 5678:5678 -v n8n_data:/home/node/.n8n n8nio/n8n
   ```
2. Truy cap `http://localhost:5678` tren trinh duyet.
3. Chon **Import from File** va tai tep `content-flow-V2-official.json` vao.
4. Gan thong tin Credentials (Google Sheets, Drive, Gemini, OpenAI) trong n8n va kich hoat workflow (Active).
5. Lay API Key cua n8n (tai phan Settings > n8n API) va dien vao bien `N8N_API_KEY` trong file `.env` cua backend.

---

## Danh Sach Giao Dien Web Dashboard

| Dia chi URL | Ten man hinh | Chuc nang chinh |
| :--- | :--- | :--- |
| `http://localhost:3001/` | Portal Navigation | Trang dieu huong tong quan den cac phan he |
| `http://localhost:3001/content` | Content Hub | Danh sach bai viet, loc, thao tac duyet va hen gio hang loat |
| `http://localhost:3001/content/:row` | Content Editor | Chinh sua noi dung, chon option AI, xem anh Drive cua 1 dong |
| `http://localhost:3001/buffer` | Buffer Manager | Kiem tra hang doi tung kenh, xem quota, dang ngay lap tuc |
| `http://localhost:3001/automation` | Automation Center | Theo doi n8n, kich hoat workflow, dang truc tiep, xem live logs |

---

## Bang Tham Chieu Bien Moi Truong (.env)

| Ten bien | Yeu cau | Gia tri mac dinh | Giai thich chi tiet |
| :--- | :---: | :--- | :--- |
| `PORT` | Khong | `3001` | Cong Express server lang nghe |
| `BASE_URL` | Co | `http://localhost:3001` | URL co so cua backend (Local hoac domain Ngrok) |
| `GOOGLE_SHEET_ID` | Co | - | ID cua file Google Sheets quan ly bai viet |
| `GOOGLE_SHEET_NAME` | Khong | `Content Selector` | Ten tab chua noi dung can phe duyet |
| `GOOGLE_PUBLISH_SHEET_NAME` | Khong | `Publish Content` | Ten tab luu thong tin bai viet da dang |
| `GOOGLE_SHEET_GID` | Khong | `2121812891` | GID cua tab Content Selector |
| `GOOGLE_PUBLISH_SHEET_GID` | Khong | `743957638` | GID cua tab Publish Content |
| `GOOGLE_SHEET_DATA_START_ROW` | Khong | `5` | Dong bat dau chua du lieu tren Sheet |
| `GOOGLE_CREDENTIALS_PATH` | Khong | `./credentials.json` | Duong dan toi file Google Service Account |
| `GOOGLE_API_KEY` | Khong | - | API Key Google (dung ho tro doc thumbnail Drive) |
| `BUFFER_ACCESS_TOKEN` | Co | - | Token xac thuc truy van Buffer GraphQL API |
| `BUFFER_TIKTOK_CHANNEL_ID` | Co | - | Channel ID cua kenh TikTok tren Buffer |
| `BUFFER_FB_PAGE_CHANNEL_ID` | Co | - | Channel ID cua Facebook Fanpage tren Buffer |
| `BUFFER_FB_GROUP_CHANNEL_ID` | Co | - | Channel ID cua Facebook Group tren Buffer |
| `N8N_BASE_URL` | Khong | `http://localhost:5678` | Dia chi ket noi toi n8n service |
| `N8N_API_KEY` | Co | - | API Key dung de kich hoat va dung execution tren n8n |
| `N8N_WORKFLOW_ID` | Khong | `uWbys7XrXlEP1iy9` | ID cua workflow n8n can dieu khien |
| `TIKTOK_CLIENT_KEY` | Khong | - | Client Key dang ky tren TikTok for Developers |
| `TIKTOK_CLIENT_SECRET` | Khong | - | Client Secret dang ky tren TikTok for Developers |
| `TIKTOK_REDIRECT_URI` | Khong | `{BASE_URL}/tiktok/callback` | Callback URL nhan OAuth code tu TikTok |
| `CLOUDINARY_CLOUD_NAME` | Khong | - | Ten Cloud tren Cloudinary (neu su dung) |
| `CLOUDINARY_API_KEY` | Khong | - | API Key Cloudinary |
| `CLOUDINARY_API_SECRET` | Khong | - | API Secret Cloudinary |

---

## Nguyen Tac Bao Mat Thong Tin Du An

1. **Cam tuyet doi commit cac file bi mat len Git Repository:**
   - Cac tep tin va thu muc sau bat buoc phai nam trong `.gitignore`:
     - `.env` (chua toan bo token va secret key)
     - `credentials.json` (chua private key cua Google Cloud Service Account)
     - `token.json` va thu muc `tokens/` (chua OAuth token TikTok va cac mang xa hoi)
     - `ngrok_backend.yml` (chua authtoken cua ngrok)
     - `*.pem`, `*.key` (cac chung chi bao mat)
2. **Kiem tra git status truoc khi commit:**
   - Luon chay `git status` de xac nhan khong co file bi mat nao nam trong danh sach untracked truoc khi thuc hien `git add` va `git commit`.
3. **Giao tiep giua Docker va Host:**
   - Khi cau hinh n8n goi ve backend Node.js chay tren may host, khong dung `localhost:3001` ma su dung `http://host.docker.internal:3001`.
