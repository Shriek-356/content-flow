import express from "express";
import fs from "fs";
import path from "path";
import sharp from "sharp";
import { TikTokService } from "../services/tiktok.service.js";
import { BufferService } from "../services/buffer.service.js";
import { SheetsService } from "../services/sheets.service.js";
import { downloadFromGoogleDrive } from "../utils/drive.util.js";
import { applyWatermark } from "../services/watermark.service.js";
import { findMatchingSheetRow } from "../utils/posts.util.js";
import { CloudinaryService } from "../services/cloudinary.service.js";

const router = express.Router();

/**
 * 1. Khởi tạo quy trình Login TikTok (Redirect đến trang đăng nhập)
 */
router.get("/tiktok/auth", (req, res) => {
  const host = req.get("host");
  const protocol = req.protocol === "https" || req.headers["x-forwarded-proto"] === "https" ? "https" : "http";
  const redirectUri = process.env.TIKTOK_REDIRECT_URI || `${protocol}://${host}/tiktok/callback`;

  console.log("Redirecting to TikTok OAuth with URI:", redirectUri);
  const authUrl = TikTokService.getAuthUrl(redirectUri);
  return res.redirect(authUrl);
});

/**
 * 2. Callback nhận Authorization Code từ TikTok
 */
router.get("/tiktok/callback", async (req, res) => {
  const { code, error, error_description } = req.query;

  if (error) {
    return res.status(400).send(`<h3>Lỗi đăng nhập TikTok:</h3><p>${error_description || error}</p>`);
  }

  if (!code) {
    return res.status(400).send("<h3>Không tìm thấy Authorization Code từ TikTok</h3>");
  }

  try {
    const host = req.get("host");
    const protocol = req.protocol === "https" || req.headers["x-forwarded-proto"] === "https" ? "https" : "http";
    const redirectUri = process.env.TIKTOK_REDIRECT_URI || `${protocol}://${host}/tiktok/callback`;

    const tokenData = await TikTokService.exchangeCodeForToken(code, redirectUri);

    return res.send(`
      <div style="font-family: Arial, sans-serif; text-align: center; margin-top: 50px;">
        <h2 style="color: #22c55e;">🎉 KẾT NỐI TIKTOK THÀNH CÔNG!</h2>
        <p>Hệ thống Content Automation đã lưu mã Token ủy quyền của kênh TikTok.</p>
        <p>Bây giờ bạn có thể tự động đăng video và album ảnh từ n8n lên TikTok!</p>
        <p><strong>OpenID:</strong> ${tokenData.open_id || "N/A"}</p>
        <a href="/" style="display: inline-block; margin-top: 20px; padding: 10px 20px; background: #000; color: #fff; text-decoration: none; border-radius: 5px;">Về trang chủ</a>
      </div>
    `);
  } catch (err) {
    console.error("TikTok Callback Error:", err.message);
    return res.status(500).send(`<h3>Lỗi đổi Token:</h3><p>${err.message}</p>`);
  }
});

/**
 * 3. Kiểm tra trạng thái kết nối TikTok
 */
router.get("/tiktok/status", (req, res) => {
  const token = TikTokService.getStoredToken();
  if (token && token.access_token) {
    return res.json({
      connected: true,
      open_id: token.open_id,
      updated_at: token.updated_at,
    });
  }
  return res.json({ connected: false, message: "Chưa kết nối tài khoản TikTok" });
});

/**
 * 4. API Đăng Video TikTok (Trọn gói: Tải Drive -> Đóng Watermark -> Đăng qua Buffer)
 */
router.post("/upload-tiktok-video", async (req, res) => {
  try {
    const {
      drive_url,
      video_url,
      id,
      title,
      description,
      fullMessage,
      caption,
      watermark = true,
      watermark_position = "diagonal",
      logo_width = 380,
      opacity = 0.15,
      custom_logo = null,
      scheduling_type = "automatic",
      save_to_draft = false,
      due_at,
      scheduled_time,
      channel_id,
      buffer_token,
      row_number,
      target_row
    } = req.body;

    const targetRowNum = row_number || target_row || null;
    const targetDueAt = due_at || scheduled_time || null;

    const rawUrl = drive_url || video_url || (id ? `https://drive.google.com/uc?export=download&id=${id}` : null);
    const finalCaption = fullMessage || caption || title || description || "Video mới từ Ecolar";

    if (!rawUrl) {
      return res.status(400).json({ success: false, error: "Thiếu tham số 'drive_url', 'video_url' hoặc 'id'" });
    }

    console.log(`\n${"=".repeat(60)}`);
    console.log(`🎬 [TIKTOK UPLOAD TRỌN GÓI] Bắt đầu xử lý`);
    console.log(`📁 Nguồn: ${rawUrl.slice(0, 80)}...`);
    console.log(`📝 Caption: ${finalCaption.slice(0, 80)}...`);
    console.log(`🏷️ Watermark: ${watermark ? `BẬT (${watermark_position}, Mờ: ${opacity})` : "TẮT"}`);

    let finalVideoUrl = rawUrl;

    // 1. Tải video từ Google Drive & Đóng Watermark nếu được bật
    const isDrive = rawUrl.includes("drive.google.com") || rawUrl.includes("drive.usercontent.google.com");
    if (watermark === true || watermark === "true" || isDrive) {
      console.log(`⬇️ Đang tải video từ Google Drive để xử lý...`);
      const driveRes = await downloadFromGoogleDrive(rawUrl);
      let videoBuffer = Buffer.from(await driveRes.arrayBuffer());

      if (watermark === true || watermark === "true") {
        let logoPath = custom_logo || path.join(process.cwd(), "assets", "logo-watermark.png");
        if (!fs.existsSync(logoPath)) {
          logoPath = path.join(process.cwd(), "assets", "logo.png");
        }
        if (fs.existsSync(logoPath)) {
          console.log(`🎨 Đang gắn watermark qua FFmpeg...`);
          videoBuffer = await applyWatermark(
            videoBuffer,
            logoPath,
            watermark_position,
            parseInt(logo_width),
            parseFloat(opacity)
          );
        }
      }

      // Ưu tiên tải trực tiếp lên Cloudinary (không cần ghi ổ cứng / không cần ngrok)
      if (CloudinaryService.isConfigured()) {
        const cld = await CloudinaryService.uploadBuffer(videoBuffer, {
          folder: "content-flow/tiktok",
          resource_type: "video",
          filename: `tiktok_wm_video_${Date.now()}`
        });
        finalVideoUrl = cld.secure_url;
        console.log(`☁️ [CLOUDINARY] File video sẵn sàng: ${finalVideoUrl}`);
      } else {
        // Fallback: Lưu file ra tmp/ nếu chưa có Cloudinary
        const tmpDir = path.join(process.cwd(), "tmp");
        if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

        const fileName = `wm_video_${Date.now()}.mp4`;
        const filePath = path.join(tmpDir, fileName);
        await fs.promises.writeFile(filePath, videoBuffer);

        const host = req.get("host") || "localhost:3001";
        const protocol = req.protocol === "https" || req.headers["x-forwarded-proto"] === "https" ? "https" : "http";
        const baseUrl = process.env.BASE_URL || `${protocol}://${host}`;
        finalVideoUrl = `${baseUrl}/tmp/${fileName}`;
        console.log(`✅ File video sẵn sàng: ${finalVideoUrl}`);
      }
    }

    // 2. Gọi Buffer GraphQL Service để đăng lên TikTok
    const bufferPost = await BufferService.publishVideo({
      videoUrl: finalVideoUrl,
      text: finalCaption,
      channelId: channel_id,
      schedulingType: scheduling_type,
      saveToDraft: Boolean(save_to_draft),
      dueAt: targetDueAt,
      token: buffer_token
    });

    // 3. Ghi lịch sử vào Database cục bộ
    TikTokService.recordPostHistory({
      publish_id: bufferPost.id,
      type: "VIDEO",
      title: (finalCaption.split("\n")[0] || "").substring(0, 90),
      description: finalCaption,
      status: save_to_draft ? "DRAFT_IN_BUFFER" : "PUBLISHED_VIA_BUFFER",
      metadata: {
        channel_id: channel_id || process.env.BUFFER_TIKTOK_CHANNEL_ID,
        video_url: finalVideoUrl,
        buffer_post_id: bufferPost.id
      }
    });

    // Cập nhật buffer_post_id vào Google Sheet nếu có chỉ định dòng hoặc tự động khớp nội dung
    let finalRowNum = targetRowNum;
    if (!finalRowNum && finalCaption) {
      try {
        const matched = await findMatchingSheetRow(finalCaption, "tiktok");
        if (matched) finalRowNum = matched.row_number;
      } catch (_) {}
    }

    if (finalRowNum) {
      try {
        await SheetsService.updateRow(finalRowNum, {
          status: save_to_draft ? "draft" : (targetDueAt ? "scheduled" : "publish")
        });
      } catch (sheetErr) {
        console.warn(`⚠️ [TikTok] Không thể cập nhật status Sheet dòng #${finalRowNum}:`, sheetErr.message);
      }
    }

    if (bufferPost?.id && (bufferPost.status === 'sent' || bufferPost.external_url)) {
      try {
        await SheetsService.recordPublishedPost({
          buffer_post_id: bufferPost.id,
          live_post_url: bufferPost.external_url || '',
          channel: 'gaaicap2',
          title: finalCaption ? finalCaption.slice(0, 80) : '',
          caption: finalCaption || '',
          source_row: finalRowNum,
          status: 'sent',
          media_urls: finalVideoUrl || ''
        });
      } catch (_) {}
    }

    console.log(`🎉 [TIKTOK UPLOAD TRỌN GÓI] THÀNH CÔNG! Post ID: ${bufferPost.id}`);
    console.log(`${"=".repeat(60)}\n`);

    return res.status(200).json({
      success: true,
      platform: "buffer",
      post_id: bufferPost.id,
      status: bufferPost.status || (save_to_draft ? "draft" : "published"),
      video_url: finalVideoUrl,
      watermarked: Boolean(watermark),
      message: "Đã xử lý watermark và đẩy sang Buffer đăng TikTok thành công!"
    });

  } catch (err) {
    console.error("❌ Lỗi Upload TikTok Video qua Buffer:", err.message);
    console.log(`${"=".repeat(60)}\n`);
    return res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

/**
 * 5. API Đăng Album Ảnh TikTok qua Buffer (Tự động tải Drive -> Chuẩn hóa JPEG -> Đăng qua Buffer)
 */
router.post("/upload-tiktok-photo", async (req, res) => {
  try {
    const {
      image_urls,
      images,
      photos,
      title,
      description,
      fullMessage,
      caption,
      scheduling_type = "automatic",
      save_to_draft = false,
      due_at,
      scheduled_time,
      channel_id = process.env.BUFFER_TIKTOK_CHANNEL_ID,
      buffer_token,
      row_number,
      target_row
    } = req.body;

    const targetRowNum = row_number || target_row || null;
    const targetDueAt = due_at || scheduled_time || null;

    const rawList = image_urls || images || photos || [];
    const validList = (Array.isArray(rawList) ? rawList : [rawList])
      .filter(u => typeof u === "string" && u.trim().length > 0 && !u.includes("id=undefined") && !u.includes("undefined"));

    if (validList.length === 0) {
      return res.status(400).json({ 
        success: false, 
        error: "Thư mục Media sẽ đăng (Cột AC) không có file ảnh nào hợp lệ để đăng TikTok! Vui lòng kiểm tra lại Google Drive hoặc chuyển ảnh từ Kho Media sang." 
      });
    }

    const finalCaption = fullMessage || caption || title || description || "Album ảnh mới từ Ecolar";

    console.log(`\n${"=".repeat(60)}`);
    console.log(`🖼️ [TIKTOK PHOTO UPLOAD VIA BUFFER] Bắt đầu xử lý`);
    console.log(`📝 Caption: ${finalCaption.slice(0, 80)}...`);
    console.log(`📸 Số lượng ảnh đầu vào: ${validList.length}`);

    // Chuẩn hóa và lưu ảnh vào tmp/ để tạo URL công khai
    const tmpDir = path.join(process.cwd(), "tmp");
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

    const host = req.get("host") || "localhost:3001";
    const protocol = req.protocol === "https" || req.headers["x-forwarded-proto"] === "https" ? "https" : "http";
    const baseUrl = process.env.BASE_URL || `${protocol}://${host}`;
    const timestamp = Date.now();

    const publicPhotoUrls = [];

    for (let i = 0; i < validList.length; i++) {
      const u = validList[i];
      let imgBuffer;

      if (u.includes("drive.google.com") || u.includes("drive.usercontent.google.com") || /^[a-zA-Z0-9_-]{10,}$/.test(u)) {
        const driveRes = await downloadFromGoogleDrive(u);
        imgBuffer = Buffer.from(await driveRes.arrayBuffer());
      } else if (u.startsWith("http")) {
        const fetchRes = await fetch(u);
        imgBuffer = Buffer.from(await fetchRes.arrayBuffer());
      } else {
        continue;
      }

      // Chuẩn hóa ảnh sang JPEG chất lượng cao
      const jpegBuffer = await sharp(imgBuffer)
        .jpeg({ quality: 92 })
        .toBuffer();

      if (CloudinaryService.isConfigured()) {
        const cld = await CloudinaryService.uploadBuffer(jpegBuffer, {
          folder: "content-flow/tiktok",
          resource_type: "image",
          filename: `tiktok_photo_${timestamp}_${i}`
        });
        publicPhotoUrls.push(cld.secure_url);
        console.log(`   ☁️ [CLOUDINARY] Ảnh ${i + 1}/${validList.length} sẵn sàng: ${cld.secure_url}`);
      } else {
        const fileName = `tiktok_photo_${timestamp}_${i}.jpg`;
        const filePath = path.join(tmpDir, fileName);
        await fs.promises.writeFile(filePath, jpegBuffer);

        const pubUrl = `${baseUrl}/tmp/${fileName}`;
        publicPhotoUrls.push(pubUrl);
        console.log(`   ✅ Ảnh ${i + 1}/${validList.length} sẵn sàng: ${pubUrl}`);
      }
    }

    if (publicPhotoUrls.length === 0) {
      return res.status(400).json({ success: false, error: "Không có ảnh nào xử lý thành công để đăng!" });
    }

    // Đăng Album ảnh qua Buffer GraphQL API
    const bufferPost = await BufferService.publishPhotos({
      imageUrls: publicPhotoUrls,
      text: finalCaption,
      channelId: channel_id || process.env.BUFFER_TIKTOK_CHANNEL_ID,
      schedulingType: scheduling_type,
      saveToDraft: Boolean(save_to_draft),
      dueAt: targetDueAt,
      token: buffer_token
    });

    // Ghi lịch sử
    TikTokService.recordPostHistory({
      publish_id: bufferPost.id,
      type: "PHOTO_MODE",
      title: (finalCaption.split("\n")[0] || "").substring(0, 90),
      description: finalCaption,
      status: save_to_draft ? "DRAFT_IN_BUFFER" : "PUBLISHED_VIA_BUFFER",
      metadata: {
        channel_id: channel_id || process.env.BUFFER_TIKTOK_CHANNEL_ID,
        photo_count: publicPhotoUrls.length,
        buffer_post_id: bufferPost.id
      }
    });

    // Cập nhật buffer_post_id vào Google Sheet nếu có chỉ định dòng hoặc tự động khớp nội dung
    let finalRowNum = targetRowNum;
    if (!finalRowNum && finalCaption) {
      try {
        const matched = await findMatchingSheetRow(finalCaption, "tiktok");
        if (matched) finalRowNum = matched.row_number;
      } catch (_) {}
    }

    if (finalRowNum) {
      try {
        await SheetsService.updateRow(finalRowNum, {
          status: save_to_draft ? "draft" : (targetDueAt ? "scheduled" : "publish")
        });
      } catch (sheetErr) {
        console.warn(`⚠️ [TikTok] Không thể cập nhật status Sheet dòng #${finalRowNum}:`, sheetErr.message);
      }
    }

    if (bufferPost?.id && (bufferPost.status === 'sent' || bufferPost.external_url)) {
      try {
        await SheetsService.recordPublishedPost({
          buffer_post_id: bufferPost.id,
          live_post_url: bufferPost.external_url || '',
          channel: 'gaaicap2',
          title: finalCaption ? finalCaption.slice(0, 80) : '',
          caption: finalCaption || '',
          source_row: finalRowNum,
          status: 'sent',
          media_urls: publicPhotoUrls
        });
      } catch (_) {}
    }

    console.log(`🎉 [TIKTOK PHOTO UPLOAD VIA BUFFER] THÀNH CÔNG! Post ID: ${bufferPost.id}`);
    console.log(`${"=".repeat(60)}\n`);

    return res.status(200).json({
      success: true,
      platform: "buffer",
      post_id: bufferPost.id,
      status: bufferPost.status || (save_to_draft ? "draft" : "published"),
      photos: publicPhotoUrls,
      message: `Đã xử lý và đăng thành công ${publicPhotoUrls.length} ảnh lên TikTok qua Buffer!`
    });

  } catch (err) {
    console.error("❌ Lỗi Upload TikTok Photo qua Buffer:", err.message);
    console.log(`${"=".repeat(60)}\n`);
    return res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

/**
 * 6. API Kiểm Tra Trạng Thái Bài Đăng Live từ TikTok
 * Endpoint: POST /tiktok/publish/status hoặc GET /tiktok/publish/status/:publishId
 */
router.all("/tiktok/publish/status/:publishId?", async (req, res) => {
  try {
    const publishId = req.params.publishId || req.body?.publish_id || req.query?.publish_id;
    if (!publishId) {
      return res.status(400).json({ error: "Thiếu tham số publish_id" });
    }

    const statusResult = await TikTokService.checkPublishStatus(publishId);
    return res.json({
      success: true,
      publish_id: publishId,
      result: statusResult,
    });
  } catch (err) {
    console.error("Check TikTok Status Error:", err.message);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * 7. API Hủy Lệnh Đăng Bài và Xác Nhận Lại Trạng Thái
 * Endpoint: POST /tiktok/publish/cancel
 */
router.post("/tiktok/publish/cancel", async (req, res) => {
  try {
    const { publish_id } = req.body;
    if (!publish_id) {
      return res.status(400).json({ error: "Thiếu tham số publish_id" });
    }

    const cancelResult = await TikTokService.cancelPublish(publish_id);
    return res.json({
      success: true,
      publish_id,
      data: cancelResult,
    });
  } catch (err) {
    console.error("Cancel TikTok Publish Error:", err.message);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * 8. API Xem Lịch Sử Các Bài Đã Gửi Sang TikTok
 * Endpoint: GET /tiktok/posts/history
 */
router.get("/tiktok/posts/history", async (req, res) => {
  try {
    const history = await TikTokService.getPostsHistory();
    return res.json({
      success: true,
      count: history.length,
      data: history,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

export default router;
