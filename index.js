import "dotenv/config";
import express from "express";
import fs from "fs";
import path from "path";

// Import modular routers
import videoRoutes from "./src/routes/video.routes.js";
import renderRoutes from "./src/routes/render.routes.js";
import imageRoutes from "./src/routes/image.routes.js";
import tiktokRoutes from "./src/routes/tiktok.routes.js";
import facebookRoutes from "./src/routes/facebook.routes.js";
import dashboardRoutes from "./src/routes/dashboard.routes.js";

const app = express();
const PORT = process.env.PORT || 3001;

// Global Middlewares
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));
app.use("/assets", express.static("assets"));
app.use("/tmp", express.static("tmp"));
app.use("/public", express.static("public"));

// P0: KHÔNG serve static root "." nữa — từng lộ credentials.json / tokens / data ra internet.
// Chỉ cho phép file xác thực tên miền (.txt ở root, chặn path traversal) + trang tĩnh cho phép.
app.get(/^\/([^/]+\.txt)$/, (req, res) => {
  const filePath = path.join(process.cwd(), path.basename(req.params[0]));
  if (!fs.existsSync(filePath)) return res.status(404).send("Not found");
  return res.sendFile(filePath);
});
for (const page of ["privacy.html", "terms.html"]) {
  app.get(`/${page}`, (_, res) => res.sendFile(path.join(process.cwd(), page)));
}

// P0: Chặn gọi từ ngoài internet vào các endpoint đổi dữ liệu / tốn tài nguyên.
// Cho phép: (1) trình duyệt dashboard (Referer/Origin cùng host, kể cả qua ngrok),
// (2) gọi nội bộ không qua proxy (không có X-Forwarded-For + IP loopback/LAN: n8n docker,
// backend tự gọi chính nó, script local). Ngoại lệ: /tiktok/callback (TikTok redirect về).
// Lưu ý: không bật trust proxy — cần IP socket thật để phân biệt traffic qua ngrok.
function mutationGuard(req, res, next) {
  if (req.path === "/tiktok/callback") return next();
  const mutating =
    req.path.startsWith("/api/") ||
    req.path.startsWith("/upload-") ||
    req.path === "/edit-image-openai" ||
    req.path === "/watermark-video" ||
    req.path === "/split-panorama" ||
    req.path.startsWith("/render-") ||
    req.path.startsWith("/tiktok/");
  if (!mutating) return next();

  const host = (req.get("host") || "").split(":")[0].toLowerCase();
  const ref = req.get("referer") || req.get("origin") || "";
  let refHost = "";
  try {
    if (ref) refHost = new URL(ref).hostname.toLowerCase();
  } catch (_) {}
  if (refHost && refHost === host) return next();

  const hasXff = Boolean(req.get("x-forwarded-for"));
  const ip = (req.ip || "").replace(/^::ffff:/, "");
  const isLoopback = ip === "127.0.0.1" || ip === "::1" || ip === "localhost";
  const isPrivateLan = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);
  if (!hasXff && (isLoopback || isPrivateLan)) return next();

  console.warn(`⛔ [GUARD] Chặn ${req.method} ${req.path} (không Referer nội bộ, ip=${ip || "unknown"})`);
  return res.status(403).json({ success: false, error: "Forbidden" });
}
app.use(mutationGuard);

// Mount Routers
app.use("/", videoRoutes);
app.use("/", renderRoutes);
app.use("/", imageRoutes);
app.use("/", tiktokRoutes);
app.use("/", facebookRoutes);
app.use("/", dashboardRoutes);

// Health check
app.get("/health", (_, res) => res.json({ status: "ok", time: new Date().toISOString() }));

// Start Server
app.listen(PORT, "0.0.0.0", () => {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`🚀 Content Automation Server đang chạy!`);
  console.log(`🌐 http://localhost:${PORT}`);
  console.log(`📌 Nhóm Video:`);
  console.log(`   - POST /upload-video`);
  console.log(`   - POST /watermark-video`);
  console.log(`📌 Nhóm Ảnh & Template:`);
  console.log(`   - POST /render-html`);
  console.log(`   - POST /render-template`);
  console.log(`   - POST /edit-image-openai`);
  console.log(`${"=".repeat(60)}\n`);
});

import { BufferService } from "./src/services/buffer.service.js";

// Background Worker: Tự động kiểm tra các bài viết trong hàng đợi (Queue) đến hạn xuất bản
// Nếu Buffer đã đăng xong ('sent') -> Tự động ghi ngay vào tab Google Sheet 'Publish Content'
setInterval(async () => {
  try {
    await BufferService.syncDueQueuePosts();
  } catch (_) {}
}, 45 * 1000);

// Khởi chạy kiểm tra ngay 5 giây sau khi server bật
setTimeout(async () => {
  try {
    await BufferService.syncDueQueuePosts();
  } catch (_) {}
}, 5000);


