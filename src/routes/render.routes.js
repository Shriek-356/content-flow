import { Router } from "express";
import {
  renderHtmlToPngBuffer,
  buildHtmlFromTemplate
} from "../services/puppeteer.service.js";

const router = Router();

// ============================================================
// POST /render-html
// Render mã HTML/CSS bất kỳ thành ảnh PNG 1200x1200px
// ============================================================
router.post("/render-html", async (req, res) => {
  const { html, width = 1200, height = 1200 } = req.body;
  if (!html) return res.status(400).json({ success: false, message: "Thiếu tham số html" });

  try {
    const buffer = await renderHtmlToPngBuffer(html, width, height);
    res.setHeader("Content-Type", "image/png");
    return res.send(buffer);
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

// ============================================================
// POST /render-template
// Nhận JSON payload, điền vào template HTML rồi render ra ảnh PNG
// ============================================================
router.post("/render-template", async (req, res) => {
  try {
    const payload = req.body;
    if (!payload.content_type) {
      return res.status(400).json({ success: false, message: "Thiếu content_type" });
    }
    const html = buildHtmlFromTemplate(payload);
    const imageBuffer = await renderHtmlToPngBuffer(
      html,
      payload.canvas_width || 1200,
      payload.canvas_height || 1200
    );
    res.setHeader("Content-Type", "image/png");
    return res.send(imageBuffer);
  } catch (error) {
    console.error("❌ Lỗi /render-template:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
});

// ============================================================
// POST /render-template/preview-html
// Xem trước mã HTML sau khi ghép dữ liệu (không render PNG)
// ============================================================
router.post("/render-template/preview-html", (req, res) => {
  try {
    const html = buildHtmlFromTemplate(req.body);
    res.setHeader("Content-Type", "text/html");
    return res.send(html);
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

export default router;
