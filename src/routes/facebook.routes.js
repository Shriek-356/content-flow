import { Router } from "express";
import fs from "fs";
import path from "path";
import sharp from "sharp";
import { downloadFromGoogleDrive } from "../utils/drive.util.js";
import { applyWatermark } from "../services/watermark.service.js";
import { BufferService } from "../services/buffer.service.js";
import { SheetsService } from "../services/sheets.service.js";
import { recordPost } from "../utils/posts.util.js";
import { logger } from "../utils/logger.util.js";
import { CloudinaryService } from "../services/cloudinary.service.js";

const router = Router();

// ============================================================
// POST /upload-fb-group-video
// Đăng video lên Facebook Group qua Buffer (Trọn gói: Tải Drive -> Đóng Watermark -> Đăng Group)
// ============================================================
router.post("/upload-fb-group-video", async (req, res) => {
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
      save_to_draft = false,
      due_at,
      scheduled_time,
      channel_id = process.env.BUFFER_FB_GROUP_CHANNEL_ID,
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

    let targetChannelId = channel_id;
    if (!targetChannelId || targetChannelId.includes("DÁN_ID") || !/^[a-zA-Z0-9_-]{10,}$/.test(targetChannelId)) {
      targetChannelId = process.env.BUFFER_FB_GROUP_CHANNEL_ID;
    }

    if (!targetChannelId) {
      return res.status(400).json({
        success: false,
        error: "Thiếu BUFFER_FB_GROUP_CHANNEL_ID trong file .env"
      });
    }

    console.log(`\n${"=".repeat(60)}`);
    console.log(`🎬 [FB GROUP UPLOAD VIA BUFFER] Bắt đầu xử lý`);
    console.log(`📁 Nguồn: ${rawUrl.slice(0, 80)}...`);
    console.log(`📺 FB Group Channel ID: ${targetChannelId}`);
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
          folder: "content-flow/facebook",
          resource_type: "video",
          filename: `fb_group_video_${Date.now()}`
        });
        finalVideoUrl = cld.secure_url;
        console.log(`☁️ [CLOUDINARY] File video sẵn sàng: ${finalVideoUrl}`);
      } else {
        // Fallback: Lưu file ra tmp/ để tạo URL công khai
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

    // 2. Đăng lên Facebook Group qua Buffer Service (yêu cầu notification scheduling cho FB Groups)
    const bufferPost = await BufferService.publishVideo({
      videoUrl: finalVideoUrl,
      text: finalCaption,
      channelId: targetChannelId,
      schedulingType: "notification",
      saveToDraft: Boolean(save_to_draft),
      dueAt: targetDueAt,
      token: buffer_token
    });

    console.log(`🎉 [FB GROUP UPLOAD VIA BUFFER] THÀNH CÔNG! Post ID: ${bufferPost.id}`);
    console.log(`${"=".repeat(60)}\n`);
    logger.log(`🎉 [FB GROUP UPLOAD] Thành công! Post ID: ${bufferPost.id}`, "success");

    recordPost({
      post_id: bufferPost.id,
      platform: "facebook_group",
      type: "VIDEO",
      title: finalCaption.slice(0, 90),
      caption: finalCaption,
      status: save_to_draft ? "DRAFT_IN_BUFFER" : "NOTIFICATION_PENDING",
      video_url: finalVideoUrl,
      watermarked: Boolean(watermark),
      channel_id: targetChannelId
    });

    // Cập nhật buffer_post_id vào Google Sheet nếu có chỉ định dòng hoặc tự động khớp nội dung
    let finalRowNum = targetRowNum;
    if (!finalRowNum && finalCaption) {
      try {
        const matched = await findMatchingSheetRow(finalCaption, "facebook");
        if (matched) finalRowNum = matched.row_number;
      } catch (_) {}
    }

    if (finalRowNum) {
      try {
        await SheetsService.updateRow(finalRowNum, {
          status: save_to_draft ? "draft" : (targetDueAt ? "scheduled" : "publish")
        });
      } catch (sheetErr) {
        console.warn(`⚠️ [FB Group] Không thể cập nhật status Sheet dòng #${finalRowNum}:`, sheetErr.message);
      }
    }

    if (bufferPost?.id && (bufferPost.status === 'sent' || bufferPost.external_url)) {
      try {
        await SheetsService.recordPublishedPost({
          buffer_post_id: bufferPost.id,
          live_post_url: bufferPost.external_url || '',
          channel: 'Facebook Group',
          title: finalCaption ? finalCaption.slice(0, 80) : '',
          caption: finalCaption || '',
          source_row: finalRowNum,
          status: 'sent',
          media_urls: finalVideoUrl || ''
        });
      } catch (_) {}
    }

    return res.status(200).json({
      success: true,
      platform: "facebook_group",
      post_id: bufferPost.id,
      status: bufferPost.status || (save_to_draft ? "draft" : "published"),
      video_url: finalVideoUrl,
      watermarked: Boolean(watermark),
      message: "Đã xử lý watermark và đăng video lên Facebook Group thành công!"
    });

  } catch (err) {
    console.error("❌ Lỗi Upload FB Group Video qua Buffer:", err.message);
    console.log(`${"=".repeat(60)}\n`);
    return res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

// ============================================================
// POST /upload-fb-group-photo
// Đăng Album Ảnh lên Facebook Group qua Buffer Notification Publishing
// (Meta đã khai tử Groups API tháng 4/2024 - chỉ hỗ trợ notification mode)
// ============================================================
router.post("/upload-fb-group-photo", async (req, res) => {
  try {
    const {
      image_urls,
      images,
      photos,
      title,
      description,
      fullMessage,
      save_to_draft = false,
      due_at,
      scheduled_time,
      channel_id = process.env.BUFFER_FB_GROUP_CHANNEL_ID,
      buffer_token,
      row_number,
      target_row
    } = req.body;

    const targetRowNum = row_number || target_row || null;
    const targetDueAt = due_at || scheduled_time || null;

    const rawList = image_urls || images || photos || [];
    const validList = (Array.isArray(rawList) ? rawList : [rawList]).filter(
      (u) => typeof u === "string" && u.trim().length > 0
    );

    if (validList.length === 0) {
      return res.status(400).json({ success: false, error: "Thiếu danh sách ảnh 'image_urls' để đăng!" });
    }

    let targetChannelId = channel_id;
    if (!targetChannelId || targetChannelId.includes("DÁN_ID") || !/^[a-zA-Z0-9_-]{10,}$/.test(targetChannelId)) {
      targetChannelId = process.env.BUFFER_FB_GROUP_CHANNEL_ID;
    }

    if (!targetChannelId) {
      return res.status(400).json({
        success: false,
        error: "Thiếu BUFFER_FB_GROUP_CHANNEL_ID trong file .env"
      });
    }

    const finalCaption = fullMessage || caption || title || description || "Album ảnh mới từ Ecolar";

    console.log(`\n${"=".repeat(60)}`);
    console.log(`🖼️ [FB GROUP PHOTO VIA BUFFER] Bắt đầu xử lý`);
    console.log(`📺 FB Group Channel ID: ${targetChannelId}`);
    console.log(`📝 Caption: ${finalCaption.slice(0, 80)}...`);
    console.log(`📸 Số lượng ảnh đầu vào: ${validList.length}`);
    console.log(`⚙️ Mode: NOTIFICATION PUBLISHING (Meta Groups API giới hạn)`);

    // Chuẩn hóa và lưu ảnh vào tmp/ để tạo URL công khai cho Buffer kéo về
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

      if (
        u.includes("drive.google.com") ||
        u.includes("drive.usercontent.google.com") ||
        /^[a-zA-Z0-9_-]{10,}$/.test(u)
      ) {
        console.log(`   ⬇️ Ảnh ${i + 1}: Tải từ Google Drive...`);
        const driveRes = await downloadFromGoogleDrive(u);
        imgBuffer = Buffer.from(await driveRes.arrayBuffer());
      } else if (u.startsWith("http")) {
        console.log(`   ⬇️ Ảnh ${i + 1}: Tải từ URL...`);
        const fetchRes = await fetch(u);
        if (!fetchRes.ok) {
          console.warn(`   ⚠️ Ảnh ${i + 1} HTTP ${fetchRes.status} - Bỏ qua`);
          continue;
        }
        imgBuffer = Buffer.from(await fetchRes.arrayBuffer());
      } else {
        console.warn(`   ⚠️ Ảnh ${i + 1}: URL không hợp lệ - Bỏ qua`);
        continue;
      }

      // Chuẩn hóa sang JPEG chất lượng cao (Facebook yêu cầu JPEG/PNG chuẩn)
      const jpegBuffer = await sharp(imgBuffer)
        .jpeg({ quality: 92 })
        .toBuffer();

      if (CloudinaryService.isConfigured()) {
        const cld = await CloudinaryService.uploadBuffer(jpegBuffer, {
          folder: "content-flow/facebook",
          resource_type: "image",
          filename: `fb_group_photo_${timestamp}_${i}`
        });
        publicPhotoUrls.push(cld.secure_url);
        console.log(`   ☁️ [CLOUDINARY] Ảnh ${i + 1}/${validList.length} sẵn sàng: ${cld.secure_url}`);
      } else {
        const fileName = `fb_photo_${timestamp}_${i}.jpg`;
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

    // Đăng Album Ảnh lên FB Group qua Buffer Notification Publishing
    const bufferPost = await BufferService.publishPhotos({
      imageUrls: publicPhotoUrls,
      text: finalCaption,
      channelId: targetChannelId,
      schedulingType: "notification",   // BẮT BUỘC cho Facebook Group
      facebookType: "post",             // Bắt buộc cho kênh Facebook
      saveToDraft: Boolean(save_to_draft),
      dueAt: targetDueAt,
      token: buffer_token
    });

    console.log(`🎉 [FB GROUP PHOTO VIA BUFFER] THÀNH CÔNG! Post ID: ${bufferPost.id}`);
    console.log(`${"=".repeat(60)}\n`);
    logger.log(`🎉 [FB GROUP PHOTO] Thành công ${publicPhotoUrls.length} ảnh! Post ID: ${bufferPost.id}`, "success");

    recordPost({
      post_id: bufferPost.id,
      platform: "facebook_group",
      type: "PHOTO_MODE",
      title: finalCaption.slice(0, 90),
      caption: finalCaption,
      status: save_to_draft ? "DRAFT_IN_BUFFER" : "NOTIFICATION_PENDING",
      photo_count: publicPhotoUrls.length,
      channel_id: targetChannelId
    });

    // Cập nhật buffer_post_id vào Google Sheet nếu có chỉ định dòng hoặc tự động khớp nội dung
    let finalRowNum = targetRowNum;
    if (!finalRowNum && finalCaption) {
      try {
        const matched = await findMatchingSheetRow(finalCaption, "facebook");
        if (matched) finalRowNum = matched.row_number;
      } catch (_) {}
    }

    if (finalRowNum) {
      try {
        await SheetsService.updateRow(finalRowNum, {
          status: save_to_draft ? "draft" : (targetDueAt ? "scheduled" : "publish")
        });
      } catch (sheetErr) {
        console.warn(`⚠️ [FB Group Photo] Không thể cập nhật status Sheet dòng #${finalRowNum}:`, sheetErr.message);
      }
    }

    if (bufferPost?.id && (bufferPost.status === 'sent' || bufferPost.external_url)) {
      try {
        await SheetsService.recordPublishedPost({
          buffer_post_id: bufferPost.id,
          live_post_url: bufferPost.external_url || '',
          channel: 'Facebook Group',
          title: finalCaption ? finalCaption.slice(0, 80) : '',
          caption: finalCaption || '',
          source_row: finalRowNum,
          status: 'sent',
          media_urls: publicPhotoUrls
        });
      } catch (_) {}
    }

    return res.status(200).json({
      success: true,
      platform: "facebook_group",
      post_id: bufferPost.id,
      status: bufferPost.status || (save_to_draft ? "draft" : "notification_pending"),
      photos: publicPhotoUrls,
      photo_count: publicPhotoUrls.length,
      message: `Đã xử lý và tạo Notification Publishing cho ${publicPhotoUrls.length} ảnh lên Facebook Group qua Buffer!`,
      note: "Kiểm tra điện thoại (app Buffer) để hoàn tất đăng bài vào Facebook Group."
    });

  } catch (err) {
    console.error("❌ Lỗi Upload FB Group Photo qua Buffer:", err.message);
    console.log(`${"=".repeat(60)}\n`);
    return res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

// ============================================================
// POST /upload-fb-page-video
// Đăng Video lên Facebook Fanpage qua Buffer (Tự động 100% - Auto Publish)
// ============================================================
router.post("/upload-fb-page-video", async (req, res) => {
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
      save_to_draft = false,
      due_at,
      scheduled_time,
      channel_id = process.env.BUFFER_FB_PAGE_CHANNEL_ID,
      facebook_type = "post",
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

    let targetChannelId = channel_id;
    if (!targetChannelId || targetChannelId.includes("DÁN_ID") || !/^[a-zA-Z0-9_-]{10,}$/.test(targetChannelId)) {
      targetChannelId = process.env.BUFFER_FB_PAGE_CHANNEL_ID;
    }

    if (!targetChannelId) {
      return res.status(400).json({
        success: false,
        error: "Thiếu BUFFER_FB_PAGE_CHANNEL_ID trong file .env"
      });
    }

    console.log(`\n${"=".repeat(60)}`);
    console.log(`🎬 [FB PAGE VIDEO VIA BUFFER] Bắt đầu xử lý (Tự động 100%)`);
    console.log(`📁 Nguồn: ${rawUrl.slice(0, 80)}...`);
    console.log(`📺 FB Page Channel ID: ${targetChannelId}`);
    console.log(`📝 Caption: ${finalCaption.slice(0, 80)}...`);
    console.log(`🏷️ Watermark: ${watermark ? `BẬT (${watermark_position}, Mờ: ${opacity})` : "TẮT"}`);
    console.log(`⚙️ Chế độ: ${save_to_draft ? "LƯU NHÁP" : "ĐĂNG TỰ ĐỘNG (AUTOMATIC)"}`);

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
          folder: "content-flow/facebook",
          resource_type: "video",
          filename: `fb_page_video_${Date.now()}`
        });
        finalVideoUrl = cld.secure_url;
        console.log(`☁️ [CLOUDINARY] File video sẵn sàng: ${finalVideoUrl}`);
      } else {
        // Fallback: Lưu file ra tmp/ để tạo URL công khai
        const tmpDir = path.join(process.cwd(), "tmp");
        if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

        const fileName = `wm_fb_page_${Date.now()}.mp4`;
        const filePath = path.join(tmpDir, fileName);
        await fs.promises.writeFile(filePath, videoBuffer);

        const host = req.get("host") || "localhost:3001";
        const protocol = req.protocol === "https" || req.headers["x-forwarded-proto"] === "https" ? "https" : "http";
        const baseUrl = process.env.BASE_URL || `${protocol}://${host}`;
        finalVideoUrl = `${baseUrl}/tmp/${fileName}`;
        console.log(`✅ File video sẵn sàng: ${finalVideoUrl}`);
      }
    }

    // 2. Đăng lên Facebook Fanpage qua Buffer (schedulingType: automatic)
    const bufferPost = await BufferService.publishVideo({
      videoUrl: finalVideoUrl,
      text: finalCaption,
      channelId: targetChannelId,
      schedulingType: "automatic",
      facebookType: facebook_type || "post",
      saveToDraft: Boolean(save_to_draft),
      dueAt: targetDueAt,
      token: buffer_token
    });

    console.log(`🎉 [FB PAGE VIDEO VIA BUFFER] THÀNH CÔNG! Post ID: ${bufferPost.id}`);
    console.log(`${"=".repeat(60)}\n`);
    logger.log(`🎉 [FB PAGE VIDEO] Thành công! Post ID: ${bufferPost.id}`, "success");

    recordPost({
      post_id: bufferPost.id,
      platform: "facebook_page",
      type: "VIDEO",
      title: finalCaption.slice(0, 90),
      caption: finalCaption,
      status: save_to_draft ? "DRAFT_IN_BUFFER" : "PUBLISHED_VIA_BUFFER",
      video_url: finalVideoUrl,
      watermarked: Boolean(watermark),
      channel_id: targetChannelId
    });

    // Cập nhật buffer_post_id vào Google Sheet nếu có chỉ định dòng hoặc tự động khớp nội dung
    let finalRowNum = targetRowNum;
    if (!finalRowNum && finalCaption) {
      try {
        const matched = await findMatchingSheetRow(finalCaption, "facebook");
        if (matched) finalRowNum = matched.row_number;
      } catch (_) {}
    }

    if (finalRowNum) {
      try {
        await SheetsService.updateRow(finalRowNum, {
          status: save_to_draft ? "draft" : (targetDueAt ? "scheduled" : "publish")
        });
      } catch (sheetErr) {
        console.warn(`⚠️ [FB Page Video] Không thể cập nhật status Sheet dòng #${finalRowNum}:`, sheetErr.message);
      }
    }

    if (bufferPost?.id && (bufferPost.status === 'sent' || bufferPost.external_url)) {
      try {
        await SheetsService.recordPublishedPost({
          buffer_post_id: bufferPost.id,
          live_post_url: bufferPost.external_url || '',
          channel: 'Haha hihi',
          title: finalCaption ? finalCaption.slice(0, 80) : '',
          caption: finalCaption || '',
          source_row: finalRowNum,
          status: 'sent',
          media_urls: finalVideoUrl || ''
        });
      } catch (_) {}
    }

    return res.status(200).json({
      success: true,
      platform: "facebook_page",
      post_id: bufferPost.id,
      status: bufferPost.status || (save_to_draft ? "draft" : "published"),
      video_url: finalVideoUrl,
      watermarked: Boolean(watermark),
      message: "Đã xử lý watermark và tự động đăng video lên Facebook Fanpage qua Buffer thành công!"
    });

  } catch (err) {
    console.error("❌ Lỗi Upload FB Page Video qua Buffer:", err.message);
    console.log(`${"=".repeat(60)}\n`);
    return res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

// ============================================================
// POST /upload-fb-page-photo
// Đăng Album Ảnh lên Facebook Fanpage qua Buffer (Tự động 100% - Auto Publish)
// ============================================================
router.post("/upload-fb-page-photo", async (req, res) => {
  try {
    const {
      image_urls,
      images,
      photos,
      title,
      description,
      fullMessage,
      save_to_draft = false,
      due_at,
      scheduled_time,
      channel_id = process.env.BUFFER_FB_PAGE_CHANNEL_ID,
      buffer_token,
      row_number,
      target_row
    } = req.body;

    const targetRowNum = row_number || target_row || null;
    const targetDueAt = due_at || scheduled_time || null;

    const rawList = image_urls || images || photos || [];
    const validList = (Array.isArray(rawList) ? rawList : [rawList]).filter(
      (u) => typeof u === "string" && u.trim().length > 0
    );

    if (validList.length === 0) {
      return res.status(400).json({ success: false, error: "Thiếu danh sách ảnh 'image_urls' để đăng!" });
    }

    let targetChannelId = channel_id;
    if (!targetChannelId || targetChannelId.includes("DÁN_ID") || !/^[a-zA-Z0-9_-]{10,}$/.test(targetChannelId)) {
      targetChannelId = process.env.BUFFER_FB_PAGE_CHANNEL_ID;
    }

    if (!targetChannelId) {
      return res.status(400).json({
        success: false,
        error: "Thiếu BUFFER_FB_PAGE_CHANNEL_ID trong file .env"
      });
    }

    const finalCaption = fullMessage || caption || title || description || "Album ảnh mới từ Ecolar";

    console.log(`\n${"=".repeat(60)}`);
    console.log(`🖼️ [FB PAGE PHOTO VIA BUFFER] Bắt đầu xử lý (Tự động 100%)`);
    console.log(`📺 FB Page Channel ID: ${targetChannelId}`);
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

      if (
        u.includes("drive.google.com") ||
        u.includes("drive.usercontent.google.com") ||
        /^[a-zA-Z0-9_-]{10,}$/.test(u)
      ) {
        console.log(`   ⬇️ Ảnh ${i + 1}: Tải từ Google Drive...`);
        const driveRes = await downloadFromGoogleDrive(u);
        imgBuffer = Buffer.from(await driveRes.arrayBuffer());
      } else if (u.startsWith("http")) {
        console.log(`   ⬇️ Ảnh ${i + 1}: Tải từ URL...`);
        const fetchRes = await fetch(u);
        if (!fetchRes.ok) {
          console.warn(`   ⚠️ Ảnh ${i + 1} HTTP ${fetchRes.status} - Bỏ qua`);
          continue;
        }
        imgBuffer = Buffer.from(await fetchRes.arrayBuffer());
      } else {
        console.warn(`   ⚠️ Ảnh ${i + 1}: URL không hợp lệ - Bỏ qua`);
        continue;
      }

      // Chuẩn hóa sang JPEG chất lượng cao
      const jpegBuffer = await sharp(imgBuffer)
        .jpeg({ quality: 92 })
        .toBuffer();

      if (CloudinaryService.isConfigured()) {
        const cld = await CloudinaryService.uploadBuffer(jpegBuffer, {
          folder: "content-flow/facebook",
          resource_type: "image",
          filename: `fb_page_photo_${timestamp}_${i}`
        });
        publicPhotoUrls.push(cld.secure_url);
        console.log(`   ☁️ [CLOUDINARY] Ảnh ${i + 1}/${validList.length} sẵn sàng: ${cld.secure_url}`);
      } else {
        const fileName = `fb_page_photo_${timestamp}_${i}.jpg`;
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

    // Đăng Album Ảnh lên FB Fanpage qua Buffer (automatic)
    const bufferPost = await BufferService.publishPhotos({
      imageUrls: publicPhotoUrls,
      text: finalCaption,
      channelId: targetChannelId,
      schedulingType: "automatic",
      facebookType: "post",
      saveToDraft: Boolean(save_to_draft),
      dueAt: targetDueAt,
      token: buffer_token
    });

    console.log(`🎉 [FB PAGE PHOTO VIA BUFFER] THÀNH CÔNG! Post ID: ${bufferPost.id}`);
    console.log(`${"=".repeat(60)}\n`);
    logger.log(`🎉 [FB PAGE PHOTO] Thành công ${publicPhotoUrls.length} ảnh! Post ID: ${bufferPost.id}`, "success");

    recordPost({
      post_id: bufferPost.id,
      platform: "facebook_page",
      type: "PHOTO_MODE",
      title: finalCaption.slice(0, 90),
      caption: finalCaption,
      status: save_to_draft ? "DRAFT_IN_BUFFER" : "PUBLISHED_VIA_BUFFER",
      photo_count: publicPhotoUrls.length,
      channel_id: targetChannelId
    });

    // Cập nhật buffer_post_id vào Google Sheet nếu có chỉ định dòng hoặc tự động khớp nội dung
    let finalRowNum = targetRowNum;
    if (!finalRowNum && finalCaption) {
      try {
        const matched = await findMatchingSheetRow(finalCaption, "facebook");
        if (matched) finalRowNum = matched.row_number;
      } catch (_) {}
    }

    if (finalRowNum) {
      try {
        await SheetsService.updateRow(finalRowNum, {
          status: save_to_draft ? "draft" : (targetDueAt ? "scheduled" : "publish")
        });
      } catch (sheetErr) {
        console.warn(`⚠️ [FB Page Photo] Không thể cập nhật status Sheet dòng #${finalRowNum}:`, sheetErr.message);
      }
    }

    if (bufferPost?.id && (bufferPost.status === 'sent' || bufferPost.external_url)) {
      try {
        await SheetsService.recordPublishedPost({
          buffer_post_id: bufferPost.id,
          live_post_url: bufferPost.external_url || '',
          channel: 'Haha hihi',
          title: finalCaption ? finalCaption.slice(0, 80) : '',
          caption: finalCaption || '',
          source_row: finalRowNum,
          status: 'sent',
          media_urls: publicPhotoUrls
        });
      } catch (_) {}
    }

    return res.status(200).json({
      success: true,
      platform: "facebook_page",
      post_id: bufferPost.id,
      status: bufferPost.status || (save_to_draft ? "draft" : "published"),
      photos: publicPhotoUrls,
      photo_count: publicPhotoUrls.length,
      message: `Đã xử lý và tự động đăng thành công ${publicPhotoUrls.length} ảnh lên Facebook Fanpage qua Buffer!`
    });

  } catch (err) {
    console.error("❌ Lỗi Upload FB Page Photo qua Buffer:", err.message);
    console.log(`${"=".repeat(60)}\n`);
    return res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

export default router;


