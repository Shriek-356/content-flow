import fs from "fs";
import path from "path";
import sharp from "sharp";
import { CloudinaryService } from "./cloudinary.service.js";
import { SheetsService } from "./sheets.service.js";

const TOKEN_PATH = path.resolve("tokens/tiktok_token.json");

if (!fs.existsSync(path.dirname(TOKEN_PATH))) {
  fs.mkdirSync(path.dirname(TOKEN_PATH), { recursive: true });
}
if (!fs.existsSync(path.resolve("tmp"))) {
  fs.mkdirSync(path.resolve("tmp"), { recursive: true });
}


export class TikTokService {
  /**
   * Đọc token hiện tại từ file
   */
  static getStoredToken() {
    try {
      if (fs.existsSync(TOKEN_PATH)) {
        return JSON.parse(fs.readFileSync(TOKEN_PATH, "utf-8"));
      }
    } catch (e) {
      console.error("Lỗi đọc token TikTok:", e.message);
    }
    return null;
  }

  /**
   * Lưu token vào file
   */
  static saveToken(tokenData) {
    const dataToSave = {
      ...tokenData,
      updated_at: new Date().toISOString(),
    };
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(dataToSave, null, 2));
    return dataToSave;
  }

  /**
   * Quản lý Database lịch sử bài đăng realtime từ Google Sheet 'Publish Content'
   */
  static async getPostsHistory() {
    try {
      const allPublished = await SheetsService.fetchPublishedPosts();
      const tiktokPosts = allPublished.filter(p => 
        p.platform === "tiktok" || 
        (p.channel_name && p.channel_name.toLowerCase().includes("tiktok")) ||
        (p.live_post_url && p.live_post_url.toLowerCase().includes("tiktok"))
      );
      return tiktokPosts.map(p => ({
        publish_id: p.buffer_post_id || p.id,
        type: p.type === "PHOTO_MODE" ? "PHOTO" : "VIDEO",
        title: p.title,
        description: p.caption,
        status: p.status || "sent",
        created_at: p.created_at,
        updated_at: p.updated_at,
        live_post_url: p.live_post_url || p.external_url || "",
        metadata: {
          live_post_url: p.live_post_url || p.external_url || "",
          video_url: p.media_urls || "",
          ...(p.assets ? { assets: p.assets } : {})
        }
      }));
    } catch (e) {
      console.error("Lỗi đọc lịch sử bài đăng TikTok từ Sheet:", e.message);
      return [];
    }
  }

  static async recordPostHistory({ publish_id, type, title, description, status = "SEND_TO_USER_INBOX", metadata = {} }) {
    const isSent = status === "sent" || status === "PUBLISHED_DIRECT" || status === "POSTED" || Boolean(metadata?.live_post_url);
    const postEntry = {
      publish_id,
      type, // 'VIDEO' hoặc 'PHOTO'
      title,
      description,
      status,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      metadata,
    };

    // Đồng bộ trực tiếp vào Google Sheet 'Publish Content'
    try {
      await SheetsService.recordPublishedPost({
        buffer_post_id: publish_id,
        live_post_url: metadata?.live_post_url || "",
        channel: "TikTok",
        title: title || (description ? description.slice(0, 80) : "TikTok Post"),
        caption: description || "",
        published_at: new Date().toISOString(),
        status: isSent ? "sent" : status,
        media_urls: metadata?.video_url || metadata?.cover_url || ""
      });
    } catch (err) {
      console.warn("Lỗi lưu bài TikTok vào Google Sheet 'Publish Content':", err.message);
    }

    return postEntry;
  }

  static async updatePostStatusInDb(publish_id, newStatus, extraInfo = {}) {
    try {
      const isSent = newStatus === "sent" || newStatus === "PUBLISH_COMPLETE" || newStatus === "POSTED";
      if (isSent || extraInfo?.share_url) {
        await SheetsService.recordPublishedPost({
          buffer_post_id: publish_id,
          live_post_url: extraInfo?.share_url || "",
          channel: "TikTok",
          status: "sent",
          published_at: new Date().toISOString()
        });
      }
    } catch (err) {
      console.warn("Lỗi cập nhật trạng thái TikTok sang Google Sheet:", err.message);
    }
  }

  /**
   * Tạo URL đăng nhập ủy quyền TikTok
   */
  static getAuthUrl(redirectUri) {
    const clientKey = process.env.TIKTOK_CLIENT_KEY;
    const scope = "user.info.basic,user.info.profile,user.info.stats,video.upload,video.list,video.publish";
    const state = Math.random().toString(36).substring(7);

    return `https://www.tiktok.com/v2/auth/authorize/?client_key=${clientKey}&scope=${encodeURIComponent(
      scope
    )}&response_type=code&redirect_uri=${encodeURIComponent(
      redirectUri
    )}&state=${state}`;
  }

  /**
   * Đổi Authorization Code lấy Access Token
   */
  static async exchangeCodeForToken(code, redirectUri) {
    const clientKey = process.env.TIKTOK_CLIENT_KEY;
    const clientSecret = process.env.TIKTOK_CLIENT_SECRET;

    const params = new URLSearchParams();
    params.append("client_key", clientKey);
    params.append("client_secret", clientSecret);
    params.append("code", code);
    params.append("grant_type", "authorization_code");
    params.append("redirect_uri", redirectUri);

    const res = await fetch("https://open.tiktokapis.com/v2/oauth/token/", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    });

    const data = await res.json();
    console.log("TikTok Token Exchange Response:", JSON.stringify(data));

    const tokenObj = data?.access_token ? data : (data?.data?.access_token ? data.data : null);

    if (tokenObj && tokenObj.access_token) {
      return this.saveToken(tokenObj);
    } else {
      throw new Error(
        data?.error_description || data?.error?.message || data?.message || JSON.stringify(data)
      );
    }
  }

  /**
   * Lấy Access Token hợp lệ
   */
  static async getValidAccessToken() {
    const token = this.getStoredToken();
    if (!token || !token.access_token) {
      throw new Error("Chưa có Token TikTok. Vui lòng bấm vào link ủy quyền để đăng nhập TikTok trước!");
    }
    return token.access_token;
  }

  /**
   * Tải buffer từ URL — tự động bypass Google Drive cảnh báo virus scan cho file lớn
   */
  static async downloadBufferFromUrl(url) {
    console.log(`[TikTokService] Đang tải media từ: ${url}`);

    // Chuyển link Google Drive sang drive.usercontent.google.com để bypass virus scan
    // (Hoạt động với mọi kích thước file, không cần confirm bổ sung)
    if (url.includes("drive.google.com") && url.includes("id=")) {
      const fileIdMatch = url.match(/[?&]id=([^&]+)/);
      const fileId = fileIdMatch?.[1];
      if (fileId) {
        const directUrl = `https://drive.usercontent.google.com/download?id=${fileId}&export=download&confirm=t`;
        console.log(`[TikTokService] Chuyển sang drive.usercontent URL để bypass virus scan: ${directUrl}`);
        url = directUrl;
      }
    }

    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      },
      redirect: "follow",
    });

    if (!res.ok) {
      throw new Error(`HTTP Error ${res.status}: ${res.statusText}`);
    }

    const contentType = res.headers.get("content-type") || "";
    if (contentType.includes("text/html")) {
      const body = await res.text();
      throw new Error(`Drive trả về HTML thay vì file (${body.length} bytes). Kiểm tra lại quyền chia sẻ của file.`);
    }

    const arrayBuffer = await res.arrayBuffer();
    const buf = Buffer.from(arrayBuffer);
    console.log(`[TikTokService] Tải thành công: ${buf.length} bytes`);
    return buf;
  }

  /**
   * Đăng Video TikTok trực tiếp kèm Caption đầy đủ (Direct Post)
   * Endpoint: POST https://open.tiktokapis.com/v2/post/publish/video/init/
   */
  static async publishVideo({ videoUrl, videoBuffer, title, description, privacyLevel = "PUBLIC_TO_EVERYONE" }) {
    const accessToken = await this.getValidAccessToken();

    let buffer = videoBuffer;
    if (!buffer && videoUrl) {
      buffer = await this.downloadBufferFromUrl(videoUrl);
    }

    if (!buffer || buffer.length === 0) {
      throw new Error("Không có dữ liệu video để tải lên TikTok!");
    }

    const videoSize = buffer.length;
    const fullCaption = (description || title || "").trim();
    console.log(`[TikTokService] Kích thước video: ${(videoSize / 1024 / 1024).toFixed(1)}MB (${videoSize} bytes)`);
    console.log(`[TikTokService] Độ dài caption đính kèm: ${fullCaption.length} ký tự`);

    if (videoSize < 100 * 1024) {
      throw new Error(
        `Video quá nhỏ (${videoSize} bytes). Có thể Google Drive chưa bật quyền công khai hoặc link bị hỏng.`
      );
    }

    const CHUNK_SIZE = 64 * 1024 * 1024; // 64MB mỗi chunk
    const totalChunks = videoSize <= CHUNK_SIZE ? 1 : 2;
    const chunkSize = videoSize <= CHUNK_SIZE ? videoSize : CHUNK_SIZE;

    const privacy = (privacyLevel || "PUBLIC_TO_EVERYONE").toUpperCase();

    const videoInitPayload = {
      post_info: {
        title: fullCaption.substring(0, 2200),
        privacy_level: privacy,
        disable_duet: false,
        disable_comment: false,
        disable_stitch: false,
      },
      source_info: {
        source: "FILE_UPLOAD",
        video_size: videoSize,
        chunk_size: chunkSize,
        total_chunk_count: totalChunks,
      },
    };

    console.log(`[TikTokService] Gửi init Direct Post sang TikTok (${totalChunks} chunk x ${(chunkSize / 1024 / 1024).toFixed(1)}MB, privacy=${privacy})...`);

    const initRes = await fetch("https://open.tiktokapis.com/v2/post/publish/video/init/", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json; charset=UTF-8",
      },
      body: JSON.stringify(videoInitPayload),
    });

    const initData = await initRes.json();
    console.log("[TikTokService] Init Direct Post Response:", JSON.stringify(initData));

    if (!initData.data?.upload_url) {
      throw new Error(initData.error?.message || "Không thể khởi tạo Direct Post video trên TikTok");
    }

    const { publish_id, upload_url } = initData.data;

    // Upload từng chunk tuần tự
    for (let i = 0; i < totalChunks; i++) {
      const start = i * chunkSize;
      const end = (i === totalChunks - 1) ? videoSize : start + chunkSize;
      const chunk = buffer.slice(start, end);
      const actualChunkSize = end - start;

      console.log(`[TikTokService] Upload chunk ${i + 1}/${totalChunks}: bytes ${start}–${end - 1} (${(actualChunkSize / 1024 / 1024).toFixed(1)}MB)...`);

      const uploadRes = await fetch(upload_url, {
        method: "PUT",
        headers: {
          "Content-Type": "video/mp4",
          "Content-Length": String(actualChunkSize),
          "Content-Range": `bytes ${start}-${end - 1}/${videoSize}`,
        },
        body: chunk,
      });

      console.log(`[TikTokService] Chunk ${i + 1} → ${uploadRes.status} ${uploadRes.statusText}`);

      if (!uploadRes.ok) {
        const errBody = await uploadRes.text().catch(() => "");
        throw new Error(
          `Upload chunk ${i + 1}/${totalChunks} thất bại! HTTP ${uploadRes.status} ${uploadRes.statusText}. ${errBody}`.trim()
        );
      }
    }

    // Lưu vào DB sau khi upload thành công
    this.recordPostHistory({
      publish_id,
      type: "VIDEO",
      title: fullCaption.split("\n")[0].substring(0, 90) || "TikTok Video",
      description: fullCaption,
      status: "PUBLISHED_DIRECT",
      metadata: { size: videoSize, chunks: totalChunks, privacy },
    });

    return {
      success: true,
      publish_id,
      caption: fullCaption,
      size: videoSize,
      chunks: totalChunks,
      privacy,
      status: "PUBLISHED_DIRECT",
      message: `Video (${(videoSize / 1024 / 1024).toFixed(1)}MB) đã được đăng trực tiếp lên TikTok kèm đầy đủ Caption!`,
    };
  }

  /**
   * 2. Đăng Chùm Ảnh Vuốt Lướt (Photo Mode) chuẩn 100% tài liệu chính thức Content Posting API

   * Endpoint: POST https://open.tiktokapis.com/v2/post/publish/content/init/
   */
  static async publishPhotoMode({ imageUrls, title, description }) {
    console.log(`[TikTokService] Đang chuẩn bị xuất bản Photo Mode (Album vuốt lướt)...`);
    const accessToken = await this.getValidAccessToken();

    const fullCaption = (description || title || "").trim();

    // Chuẩn hóa Title cho TikTok Photo Mode: 1 dòng duy nhất, tối đa 90 ký tự
    const cleanTitle = (title || fullCaption || "Ecolar - Nông Nghiệp Sạch")
      .split("\n")[0]
      .replace(/[📌📝👉🖼️]/g, "")
      .trim()
      .substring(0, 90);

    // 1. Tải ảnh từ Drive và tự động chuẩn hóa kích thước sang chuẩn HD 1080x1080 JPEG
    let validUrls = (imageUrls || []).filter(u => typeof u === "string" && u.startsWith("http") && !u.includes("undefined"));

    if (validUrls.length === 0) {
      throw new Error("Không có ảnh hợp lệ để đăng lên TikTok!");
    }

    // Địa chỉ domain công khai cố định để TikTok tải ảnh Photo Mode
    const baseUrl = process.env.BASE_URL || "https://bladder-unretired-froth.ngrok-free.dev";

    const timestamp = Date.now();
    const publicPhotoUrls = [];

    for (let i = 0; i < validUrls.length; i++) {
      const u = validUrls[i];
      const rawBuffer = await this.downloadBufferFromUrl(u);

      // Chuẩn hóa ảnh sang chuẩn kích thước 1080x1080 JPEG chất lượng cao
      const jpegBuffer = await sharp(rawBuffer)
        .resize(1080, 1080, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 1 } })
        .jpeg({ quality: 92 })
        .toBuffer();

      if (CloudinaryService.isConfigured()) {
        const cld = await CloudinaryService.uploadBuffer(jpegBuffer, {
          folder: "content-flow/tiktok",
          resource_type: "image",
          filename: `tiktok_direct_photo_${timestamp}_${i}`
        });
        publicPhotoUrls.push(cld.secure_url);
      } else {
        const filename = `tiktok_photo_${timestamp}_${i}.jpg`;
        const filePath = path.resolve(`tmp/${filename}`);
        fs.writeFileSync(filePath, jpegBuffer);
        publicPhotoUrls.push(`${baseUrl}/tmp/${filename}`);
      }
    }

    console.log("[TikTokService] Danh sách URL ảnh JPEG chuẩn 1080x1080:", publicPhotoUrls);

    // 2. Dựng Request Body chuẩn
    const photoPayload = {
      post_mode: "MEDIA_UPLOAD",
      media_type: "PHOTO",
      post_info: {
        title: cleanTitle,
        description: fullCaption.substring(0, 2200),
        auto_add_music: true,
      },
      source_info: {
        source: "PULL_FROM_URL",
        photo_cover_index: 1,
        photo_images: publicPhotoUrls,
      },
    };

    console.log("[TikTokService] Gửi payload Photo Post sang TikTok...");

    const res = await fetch("https://open.tiktokapis.com/v2/post/publish/content/init/", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json; charset=UTF-8",
      },
      body: JSON.stringify(photoPayload),
    });

    const data = await res.json();
    console.log("[TikTokService] Photo Post Init Response:", JSON.stringify(data, null, 2));

    if (data.data && data.data.publish_id) {
      const publish_id = data.data.publish_id;

      // Lưu publish_id vào Database lịch sử
      this.recordPostHistory({
        publish_id,
        type: "PHOTO",
        title: cleanTitle,
        description: fullCaption,
        status: "SEND_TO_USER_INBOX",
        metadata: { photos_count: publicPhotoUrls.length },
      });

      return {
        success: true,
        publish_id,
        title: cleanTitle,
        description: fullCaption,
        photos_count: publicPhotoUrls.length,
        status: "SEND_TO_USER_INBOX",
        message: "Chùm ảnh Photo Mode (dạng lướt) đã được gửi thành công vào Hộp thư TikTok!",
      };
    } else {
      throw new Error(data.error?.message || JSON.stringify(data));
    }
  }

  /**
   * 3. Kiểm tra trạng thái xuất bản (Live từ máy chủ TikTok)
   * Endpoint: POST https://open.tiktokapis.com/v2/post/publish/status/fetch/
   */
  static async checkPublishStatus(publishId) {
    const accessToken = await this.getValidAccessToken();

    const res = await fetch("https://open.tiktokapis.com/v2/post/publish/status/fetch/", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json; charset=UTF-8",
      },
      body: JSON.stringify({ publish_id: publishId }),
    });

    const data = await res.json();
    console.log(`[TikTokService] Status for ${publishId}:`, JSON.stringify(data));

    if (data.data && data.data.status) {
      this.updatePostStatusInDb(publishId, data.data.status, data.data);
    }

    return data;
  }

  /**
   * 4. Hủy lệnh đăng bài (Cancel Publish)
   * Endpoint: POST https://open.tiktokapis.com/v2/post/publish/cancel/
   */
  static async cancelPublish(publishId) {
    console.log(`[TikTokService] Đang yêu cầu TikTok hủy publish_id: ${publishId}`);
    const accessToken = await this.getValidAccessToken();

    const res = await fetch("https://open.tiktokapis.com/v2/post/publish/cancel/", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json; charset=UTF-8",
      },
      body: JSON.stringify({ publish_id: publishId }),
    });

    const cancelData = await res.json();
    console.log(`[TikTokService] Cancel response for ${publishId}:`, JSON.stringify(cancelData));

    // Sau khi gọi cancel, gọi lại Status API để xác nhận thực tế trạng thái từ TikTok
    const verifiedStatus = await this.checkPublishStatus(publishId);

    return {
      cancel_result: cancelData,
      verified_status: verifiedStatus,
    };
  }
}
