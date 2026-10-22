import { Router } from "express";
import fs from "fs";
import path from "path";
import { downloadFromGoogleDrive } from "../utils/drive.util.js";
import { applyWatermark } from "../services/watermark.service.js";
import { uploadVideoToFacebook } from "../services/facebook.service.js";
import { BufferService } from "../services/buffer.service.js";
import { CloudinaryService } from "../services/cloudinary.service.js";

const router = Router();

// ============================================================
// POST /watermark-video
// Đóng dấu logo watermark vào video từ Google Drive và trả về file video hoặc link public
// ============================================================
router.post("/watermark-video", async (req, res) => {
  const { drive_url, position = "diagonal", logo_width = 380, opacity = 0.12, custom_logo, return_binary = false } = req.body;

  if (!drive_url) {
    return res.status(400).json({ success: false, message: "Thiếu tham số drive_url" });
  }

  try {
    console.log(`\n${"=".repeat(60)}`);
    console.log(`🎬 [WATERMARK VIDEO] Bắt đầu xử lý`);
    console.log(`📁 Link Drive: ${drive_url.slice(0, 80)}...`);
    console.log(`🎨 Vị trí: ${position} | Độ mờ: ${opacity}`);

    console.log(`⬇️ Đang tải video từ Google Drive...`);
    const driveRes = await downloadFromGoogleDrive(drive_url);
    let videoBuffer = Buffer.from(await driveRes.arrayBuffer());

    let logoPath = custom_logo || path.join(process.cwd(), "assets", "logo-watermark.png");
    if (!fs.existsSync(logoPath)) {
      logoPath = path.join(process.cwd(), "assets", "logo.png");
    }

    videoBuffer = await applyWatermark(videoBuffer, logoPath, position, parseInt(logo_width), parseFloat(opacity));

    let fileName = `wm_video_${Date.now()}.mp4`;
    let videoUrl = "";

    if (CloudinaryService.isConfigured()) {
      const cld = await CloudinaryService.uploadBuffer(videoBuffer, {
        folder: "content-flow/videos",
        resource_type: "video",
        filename: fileName
      });
      videoUrl = cld.secure_url;
      console.log(`☁️ [CLOUDINARY] Video đã sẵn sàng trên Cloudinary: ${videoUrl}`);
    } else {
      // Lưu file vào thư mục tmp/ để tạo URL công khai cho Buffer/Facebook tải
      const tmpDir = path.join(process.cwd(), "tmp");
      if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

      const filePath = path.join(tmpDir, fileName);
      await fs.promises.writeFile(filePath, videoBuffer);

      const host = req.get("host") || "localhost:3001";
      const protocol = req.protocol === "https" || req.headers["x-forwarded-proto"] === "https" ? "https" : "http";
      const baseUrl = process.env.BASE_URL || `${protocol}://${host}`;
      videoUrl = `${baseUrl}/tmp/${fileName}`;
    }

    console.log(`✅ Gắn Watermark thành công!`);
    console.log(`🌐 Link video: ${videoUrl}`);
    console.log(`${"=".repeat(60)}\n`);

    if (return_binary === true || return_binary === "true") {
      res.setHeader("Content-Type", "video/mp4");
      res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
      return res.send(videoBuffer);
    }

    return res.status(200).json({
      success: true,
      file_name: fileName,
      video_url: videoUrl,
      size_bytes: videoBuffer.length,
      size_mb: (videoBuffer.length / 1024 / 1024).toFixed(2)
    });
  } catch (error) {
    console.error("❌ Lỗi gắn watermark video:", error.message);
    console.log(`${"=".repeat(60)}\n`);
    return res.status(500).json({ success: false, message: error.message });
  }
});

// ============================================================
// POST /upload-video
// Proxy upload video từ Google Drive lên Facebook (có hỗ trợ gắn Watermark)
// ============================================================
router.post("/upload-video", async (req, res) => {
  const {
    drive_url,
    access_token,
    description,
    page_id,
    watermark = false,
    watermark_position = "diagonal",
    logo_width = 380,
    opacity = 0.12,
    custom_logo = null
  } = req.body;

  if (!drive_url || !access_token) {
    return res.status(400).json({
      success: false,
      message: "Thiếu tham số bắt buộc: drive_url, access_token"
    });
  }

  const target = page_id || "me";

  console.log(`\n${"=".repeat(60)}`);
  console.log(`🎬 [FB VIDEO UPLOAD] Bắt đầu upload`);
  console.log(`📁 Drive: ${drive_url.slice(0, 80)}...`);
  console.log(`👤 Target: ${target}`);
  console.log(`🏷️ Watermark: ${watermark ? `BẬT (${watermark_position}, Mờ: ${opacity})` : "TẮT"}`);

  try {
    console.log(`\n⬇️ Đang tải video từ Google Drive...`);
    const driveRes = await downloadFromGoogleDrive(drive_url);
    let videoBuffer = Buffer.from(await driveRes.arrayBuffer());

    const fileSizeInitial = videoBuffer.length;
    if (fileSizeInitial < 1024) {
      throw new Error(`File tải về quá nhỏ (${fileSizeInitial} bytes) - Drive URL có thể sai hoặc file không public`);
    }

    console.log(`✅ Tải xong: ${(fileSizeInitial / 1024 / 1024).toFixed(1)} MB`);

    // Gắn Watermark nếu được bật
    if (watermark === true || watermark === "true") {
      let logoPath = custom_logo || path.join(process.cwd(), "assets", "logo-watermark.png");
      if (!fs.existsSync(logoPath)) {
        logoPath = path.join(process.cwd(), "assets", "logo.png");
      }

      if (fs.existsSync(logoPath)) {
        videoBuffer = await applyWatermark(
          videoBuffer,
          logoPath,
          watermark_position,
          parseInt(logo_width),
          parseFloat(opacity)
        );
      } else {
        console.warn(`⚠️ Không tìm thấy logo tại ${logoPath}, bỏ qua bước gắn watermark.`);
      }
    }

    const result = await uploadVideoToFacebook({
      videoBuffer,
      access_token,
      description,
      page_id: target
    });

    console.log(`${"=".repeat(60)}\n`);
    return res.status(200).json({
      success: true,
      watermarked: watermark,
      ...result
    });

  } catch (error) {
    console.error(`\n❌ Lỗi upload video:`, error.message);
    console.log(`${"=".repeat(60)}\n`);
    return res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

export default router;
