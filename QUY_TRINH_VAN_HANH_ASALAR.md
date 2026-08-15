# BÁO CÁO QUY TRÌNH SỐ HÓA VẬN HÀNH SALES & MARKETING ASALAR
**Chuẩn hóa nghiệp vụ – Kiểm soát chặt chẽ – Sẵn sàng cho AI & Automation**

* **Đơn vị lập:** Phòng IT & Automation Asalar
* **Người thực hiện:** Duy Khang (Chuyên viên IT & Automation)
* **Tài liệu:** Tài liệu nội bộ
* **Thời gian:** Tháng 08/2026 (Cập nhật Flow v15)

---

### 1. MỤC TIÊU
Quy trình số hóa và tự động hóa vận hành Sales & Marketing Asalar được phòng IT xây dựng nhằm chuẩn hóa toàn bộ các nghiệp vụ từ khi tiếp nhận định hướng nội dung, tự động thiết kế hình ảnh AI, đóng gói kho media trên Google Drive đến xuất bản đa kênh và quản lý báo cáo QC chất lượng sản phẩm. 

Việc chuẩn hóa giúp đảm bảo tính chính xác, thống nhất trong xử lý truyền thông thương hiệu Ecolar, giảm tối đa phụ thuộc vào thao tác thủ công của nhân sự MKT, hỗ trợ đào tạo nhân sự mới và tạo nền tảng vững chắc để hạ tầng AI & Automation vận hành tự động 24/7.

---

### 2. 5 CÂU HỎI CỐT LÕI

| Câu hỏi | Nội dung trả lời |
| :--- | :--- |
| **1. Đầu vào là gì?** | • Yêu cầu/định hướng bài viết nhập tại Google Sheets `Content Selector`.<br>• Mẫu Logo Ecolar màu chuẩn bản quyền (mã hóa Base64 nhúng trong n8n).<br>• Ảnh chụp lô hàng kiểm tra chất lượng (QC) từ kỹ thuật viên gửi qua Zalo Bot. |
| **2. Ai chịu trách nhiệm?** | • **Phòng IT:** Xây dựng, tối ưu và duy trì hạ tầng n8n, API Facebook & AI Agents.<br>• **Nhân sự MKT:** Nhập mục tiêu & định hướng nội dung ban đầu.<br>• **Gemini AI & Vision Agent:** Sáng tạo 3 options bài viết & tự thiết kế banner/infographic.<br>• **Leader MKT:** Phê duyệt Option bài viết 1-click trên Google Sheets.<br>• **Bot QC:** Tự động gom nhóm ảnh 2 phút & bóc tách báo cáo COA. |
| **3. Các bước thực hiện ra sao?** | **Bước 1:** Nhập định hướng vào Google Sheets `Content Selector`.<br>**Bước 2:** Gemini gen 3 options bài viết sạch + AI thiết kế ảnh & ghép Logo Ecolar Base64.<br>**Bước 3:** Đóng gói kho ảnh vào Folder Google Drive Demo (`Anh_Demo` cột AF).<br>**Bước 4:** Leader xem trước ảnh qua link Drive & duyệt 1-click.<br>**Bước 5:** n8n bốc bài, ghép chữ ký chuẩn + UTM link và xuất bản tự động qua Facebook API. |
| **4. Kiểm soát ở đâu?** | • **Làm sạch văn bản:** Gỡ bỏ 100% nhãn AI rác (`[Nội dung do AI tạo]`, `📌 HOOK:`, `📝 NỘI DUNG:`) và chuẩn hóa thương hiệu "Ecolar" độc lập.<br>• **Kiểm soát hình ảnh:** Leader xem trước trọn bộ ảnh demo qua link Drive cột AF trước khi xuất bản.<br>• **Kiểm soát link & chữ ký:** Tự động đính kèm Chữ ký thương hiệu Ecolar chuẩn và gắn link UTM tracking Landing Page.<br>• **Kiểm soát nhóm Chat:** Gom đệm 2 phút (Silent Accumulation) ảnh QC để không làm trôi tin nhắn nhóm. |
| **5. Đầu ra phục vụ ai?** | • **Fanpage Facebook Ecolar:** Nhận bài đăng tự động công khai (Album/Single Photo/Video/Reels).<br>• **Phòng MKT & Leader:** Quản lý bài viết tập trung trên Google Sheets & Google Drive.<br>• **Phòng QC & Ban Giám đốc:** Báo cáo COA kiểm định chất lượng sản phẩm lô hàng. |

---

### 3. CẤU TRÚC SOP
Mỗi SOP của quy trình số hóa được phòng IT xây dựng theo một cấu trúc thống nhất nhằm đảm bảo tính đầy đủ và dễ áp dụng, bao gồm bảy thành phần sau:
* **Tên quy trình** – Xác định phạm vi nghiệp vụ số hóa (Marketing Auto Pipeline v15 & COA QC Bot).
* **Mục đích** – Lý do và giá trị tự động hóa của quy trình (Tiết kiệm 95% thời gian, 0% lỗi thủ công).
* **Đầu vào** – Dữ liệu Google Sheets, prompt định hướng, logo thương hiệu và kho ảnh QC.
* **Các bước thực hiện** – Trình tự 5 bước xử lý cụ thể trong luồng tự động n8n v15.
* **Điểm kiểm soát** – Các chốt chặn chất lượng (Filter nhãn AI, Link Drive Preview cột AF, Human-in-the-Loop approval, Gom đệm 2 phút).
* **Đầu ra** – Bài viết xuất bản công khai trên Facebook kèm link UTM, Folder Drive bài đăng và Báo cáo COA.
* **Cơ hội ứng dụng AI & Automation** – Tiềm năng mở rộng và nâng cấp hệ thống (Zalo OA, TikTok, AI Content Refinement).

Cấu trúc này giúp quy trình được trình bày rõ ràng, dễ cập nhật, dễ đào tạo nhân sự và thuận lợi cho việc vận hành bảo trì hệ thống IT.

---

### 4. CHI TIẾT QUY TRÌNH THỰC THI 5 BƯỚC (FLOW V15)

```
[MKT Nhập Sheets] ➔ [Gemini Gen 3 Options Clean Text] ➔ [AI Thiết Kế Ảnh + Ghép Logo Base64] ➔ [Tạo Folder Drive Demo Cột AF] ➔ [Leader Duyệt 1-Click] ➔ [Đăng Auto FB Graph API]
```

1. **Bước 1 (Nhập định hướng):** MKT nhập thông điệp, sản phẩm (Gà Ai Cập / Ecolar), mục tiêu vào Sheet `Content Selector`.
2. **Bước 2 (AI Content & Image Design):** Gemini Content Creator sinh 3 Options bài viết làm sạch nhãn AI. AI Image Agent tự động ghép Logo Ecolar Base64 thiết kế banner/infographic chuẩn nhận diện.
3. **Bước 3 (Đóng gói Folder Drive Demo):** n8n tạo Folder riêng trên Drive lưu trọn bộ ảnh demo và tự động cập nhật link folder về cột **`Anh_Demo` (Cột AF)**.
4. **Bước 4 (Duyệt bài Human-in-the-Loop):** Leader mở link Drive cột AF kiểm tra ảnh, chọn `Op 1`, `Op 2` hoặc `Op 3` và đổi trạng thái thành `publish`.
5. **Bước 5 (Xuất bản tự động):** n8n bốc bài, quét Drive lấy ảnh direct link, gắn Chữ ký thương hiệu Ecolar + UTM link tracking và đăng tự động qua Facebook API.

---

### 5. CƠ HỘI ỨNG DỤNG AI & AUTOMATION

Quy trình vận hành Marketing & QC có nhiều tiềm năng ứng dụng AI và Automation ở các công đoạn lặp lại, cụ thể:
* **Sáng tạo & Chuẩn hóa nội dung:** AI tự động phân tích định hướng, viết bài theo đa phong cách và làm sạch 100% các từ ngữ rác hoặc tiền tố AI.
* **Tự động hóa thiết kế đồ họa:** AI Image Vision tự động căn chỉnh bố cục ảnh sản phẩm và đóng dấu Logo thương hiệu cố định chuẩn xác.
* **Tự động quản lý tài nguyên:** Tự động khởi tạo và phân loại thư mục lưu trữ trên Google Drive cho từng chiến dịch.
* **Tự động hóa truyền thông đa kênh:** Tự động đăng bài công khai theo định dạng (Carousel Album, Video, Reels, Single Photo) kèm UTM Link tracking hiệu quả tiếp thị.
* **Xử lý ảnh thị giác (Vision AI) trong QC:** Tự động đọc và bóc tách thông tin trọng lượng, màu sắc sản phẩm từ hình ảnh thực tế trang trại để xuất báo cáo COA.

Việc ứng dụng AI và Automation từ phòng IT không chỉ giúp giảm 95% thời gian xử lý thủ công mà còn hạn chế tối đa sai sót, giúp đội ngũ tập trung vào chiến lược phát triển thương hiệu.

---

### 6. BẢNG SO SÁNH HIỆU QUẢ VẬN HÀNH

| Hạng mục Vận hành | Quy trình Thủ công (Cũ) | Quy trình Số hóa Mới (Flow v15) | Hiệu quả Đạt được |
| :--- | :--- | :--- | :--- |
| **Thời gian xử lý 1 bài** | 60 - 90 phút (Viết bài, thiết kế ảnh, ghép logo, dán chữ ký) | **2 - 3 phút** (Nhập định hướng & Chọn Option duyệt) | **Tiết kiệm 95% thời gian** |
| **Thiết kế & Ghép Logo** | Làm Photoshop/Canva thủ công từng tấm | **AI tự thiết kế & Ghép Logo Ecolar Base64 tự động** | **Tự động hóa 100% khâu ảnh** |
| **Quản lý Kho Ảnh Demo** | Lưu rải rác trên máy tính cá nhân | **Tự động tạo Folder Drive Demo gắn vào cột AF** | **Quản lý tập trung, xem trước 1-click** |
| **Chất lượng Bài viết** | Dễ dính từ ngữ rác, dư nhãn AI | **Tự dọn sạch nhãn AI, chuẩn hóa thương hiệu "Ecolar"** | **Bài viết sạch 100%, chuẩn branding** |
| **Đăng bài & Phân phối** | Tải ảnh về máy, đăng thủ công từng bài | **Tự quét Drive & Đăng Batch API kèm UTM Link** | **0% sai sót link & chữ ký** |

---
— Hết báo cáo —
