import { v2 as cloudinary } from "cloudinary";
import { logger } from "../utils/logger.util.js";

/**
 * CloudinaryService
 * Quản lý việc tải ảnh/video từ bộ nhớ RAM lên Cloudinary CDN
 * Giúp tạo đường link HTTPS công khai siêu tốc cho Buffer kéo về,
 * loại bỏ việc ghi file ra đĩa (thư mục tmp) và không cần ngrok.
 */
class CloudinaryService {
  static _initialized = false;

  static init() {
    if (this._initialized) return;

    const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
    const apiKey = process.env.CLOUDINARY_API_KEY;
    const apiSecret = process.env.CLOUDINARY_API_SECRET;

    if (cloudName && apiKey && apiSecret) {
      cloudinary.config({
        cloud_name: cloudName,
        api_key: apiKey,
        api_secret: apiSecret,
        secure: true
      });
      this._initialized = true;
      logger.log(`☁️ [CLOUDINARY] Đã kết nối với tài khoản: ${cloudName}`, "info");
    }
  }

  static isConfigured() {
    this.init();
    return Boolean(
      process.env.CLOUDINARY_CLOUD_NAME &&
      process.env.CLOUDINARY_API_KEY &&
      process.env.CLOUDINARY_API_SECRET
    );
  }

  /**
   * Tải Buffer (Node.js Buffer từ RAM) trực tiếp lên Cloudinary
   * @param {Buffer} buffer - Dữ liệu ảnh hoặc video trong RAM
   * @param {Object} options - Cấu hình tải lên (folder, resource_type, public_id, ...)
   * @returns {Promise<{success: boolean, url: string, public_id: string, bytes: number}>}
   */
  static async uploadBuffer(buffer, options = {}) {
    this.init();

    if (!this.isConfigured()) {
      throw new Error("Chưa cấu hình tài khoản Cloudinary trong file .env!");
    }

    if (!buffer || !Buffer.isBuffer(buffer)) {
      throw new Error("Dữ liệu đầu vào phải là một Node.js Buffer hợp lệ!");
    }

    const {
      folder = "content-flow",
      resource_type = "auto", // "image" | "video" | "raw" | "auto"
      filename = null,
      tags = ["content-flow"]
    } = options;

    return new Promise((resolve, reject) => {
      const uploadOptions = {
        folder,
        resource_type,
        tags
      };

      if (filename) {
        uploadOptions.public_id = filename.replace(/\.[^/.]+$/, ""); // Loại bỏ extension để Cloudinary tự gán
      }

      const uploadStream = cloudinary.uploader.upload_stream(uploadOptions, (error, result) => {
        if (error) {
          logger.log(`❌ [CLOUDINARY UPLOAD ERROR] ${error.message}`, "error");
          return reject(error);
        }

        logger.log(`☁️ [CLOUDINARY] Tải lên thành công: ${result.secure_url} (${(result.bytes / 1024).toFixed(1)} KB)`, "success");
        resolve({
          success: true,
          url: result.secure_url,
          secure_url: result.secure_url,
          public_id: result.public_id,
          format: result.format,
          bytes: result.bytes,
          resource_type: result.resource_type
        });
      });

      uploadStream.end(buffer);
    });
  }

  /**
   * Tải một file từ đường dẫn ổ đĩa lên Cloudinary
   * @param {string} filePath - Đường dẫn file vật lý
   * @param {Object} options - Cấu hình upload
   */
  static async uploadFile(filePath, options = {}) {
    this.init();

    if (!this.isConfigured()) {
      throw new Error("Chưa cấu hình tài khoản Cloudinary trong file .env!");
    }

    const {
      folder = "content-flow",
      resource_type = "auto"
    } = options;

    const result = await cloudinary.uploader.upload(filePath, {
      folder,
      resource_type
    });

    return {
      success: true,
      url: result.secure_url,
      secure_url: result.secure_url,
      public_id: result.public_id,
      bytes: result.bytes
    };
  }
}

export { CloudinaryService };
