# Handoff — Content Automation (Ecolar)

Đọc file này + `BULK_ACTIONS_PLAN.md` để tiếp tục. Server: `D:\content-flow`, Node ESM, Express :3001 (`npm run dev`, watch tự reload). Sheet giờ = giờ VN, parse neo `+07:00` ở mọi nơi (server VN, container n8n UTC).

## Bản đồ hệ thống
- `index.js` — static lockdown (không serve root), `mutationGuard` (chỉ dashboard cùng host hoặc LAN nội bộ, trừ `/tiktok/callback`).
- `src/routes/dashboard.routes.js` — API dashboard: contents, sheet rows, `schedule-batch`, `approve-batch`, `channel-batch`, `delete-batch`, `row-error`, n8n trigger/trigger-selected/stop, buffer sync/token/quota/refresh-links, direct-publish.
- `src/services/` — `sheets.service.js` (CRUD Sheet, `parseSheetTimeVN`, deterministic ghi dòng), `buffer.service.js` (GraphQL Buffer, tracking queue + lấp link tới 2h), `tiktok/facebook/watermark/cloudinary/puppeteer/openai`.
- `templates/` — `content-list.html` (bảng + pill chọn dòng + modals), `content-detail.html` (chi tiết + nút Lưu nổi), `buffer.html` (tab Hàng đợi mặc định).
- n8n `content-flow-V2-TEST` (`uWbys7XrXlEP1iy9`): webhook duplicate/publish/content/images + node lọc publish (chỉ `publish` khi không target + skip giờ quá khứ ra output 2 → HTTP báo lỗi về `/api/sheet/row-error`).

## Đã xong trong session
- Duplicate hết nhân đôi ảnh (guard self-copy, debounce, copy idempotent, trash folder trùng tên, tên `Bai_Viet_Row_X`); AB giữ bản gốc, tạo mới AB về folder chung `1xIR...`.
- Giờ AQ: nhận cả `planned_date`, duplicate kế thừa, ghi dòng xác định (fix append wedging → row 0), validate quá khứ ném lỗi rõ + ghi cột lỗi AP.
- Batch: hẹn giờ (daily/interval/same, preview, 100/lần), duyệt, đổi kênh, đổi trạng thái, xóa (dưới lên trên), trigger n8n theo dòng (tự chuyển status, tuần tự). Pill vàng nổi đầu bảng.
- Buffer: filter sent chỉ hiện bài có link (ngoại lệ >2h), refresh-links, backfill link, link sent thiếu URL không trỏ tab draft.
- Detail: fix crash đệ quy `updateStatusSelectStyle`, nút Lưu ẩn-hiện theo dirty, pill nổi giữa đáy nhấp nháy nhẹ, sticky bar.
- P0 bảo mật xong + verify (secrets 404, ngoài 403, nội bộ OK).
- Bulk B1 + C1 xong 10/09 (chưa live-test): `POST /api/sheet/publish-selected` (Buffer trực tiếp tuần tự, dry_run preview, nút pill **Buffer** + modal Option/chế độ) và Copy/CSV frontend-only (nút pill **Copy**/**CSV**). Không start server test vì `index.js` có interval `syncDueQueuePosts` nền + giữ quota Buffer.
- Fix 10/09: trang Buffer F5 không thấy bài mới do cache server 60s (`BufferService._cachedLivePosts`) + param `sync=true` bị backend bỏ qua (dead param, chỉ `force` mới bypass cache). Sửa `loadBufferPosts(isSilent, fresh)` trong `buffer.html`: F5/tải lại/sau thao tác user gửi `&force=true`, polling ngầm 3s giữ cache để khỏi đốt quota. Nút Đồng bộ vốn đã force nên luôn đúng.

## Đang dở / lưu ý
- P1 validate giờ xong; P2 (log file, PM2 chỉ mới bàn, dọn file, banner quota 80%, snapshot đêm) TẠM HOÃN.
- Chưa live-test: tạo ảnh AI, đăng thật (mới tới dry-run). Lần chạy thật đầu tiên là kiểm chứng cuối.
- Xóa dòng vẫn `deleteDimension` (đổi số dòng!) — user từ chối xóa mềm. Folder trùng tên đã có cơ chế đỡ.
- Trong Drive còn folder mồ côi test (`Bai_Viet_Row_0/34/35` các đợt) — user tự dọn khi rảnh.
- Team sửa Sheet trực tiếp giờ hành chính → test	endpoint nên đọc verify ngay, tránh nhầm.
- Test script nhớ `import dotenv/config` đầu tiên (kẻo rơi sang spreadsheet mẫu), dùng range từ cột A để khỏi lệch index.
