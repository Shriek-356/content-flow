import sharp from "sharp";

/**
 * Tạo file Mask PNG (RGBA) cho từng Slice theo chuẩn OpenAI Image Edit API.
 * - Vùng mép viền ngoài (margin px): Opaque White (rgba(255,255,255,1)) -> Cấm AI sửa, giữ nguyên 100% phôi nền.
 * - Vùng trung tâm (safe zone): Transparent (rgba(0,0,0,0)) -> Cho phép AI vẽ Headline, Text, Ảnh gà.
 * - Ranh giới có độ mờ mềm (feather px) để hòa trộn tự nhiên.
 *
 * @param {Object} options
 * @param {number} options.width - Chiều rộng của slice (vd: 1200)
 * @param {number} options.height - Chiều cao của slice (vd: 1200, 800)
 * @param {number} [options.margin=80] - Độ dày mép viền cần bảo vệ (pixel)
 * @param {number} [options.feather=24] - Độ làm mờ chuyển tiếp viền (pixel)
 * @returns {Promise<Buffer>} PNG RGBA Buffer của Mask
 */
export async function createSliceMask({
  width = 1200,
  height = 1200,
  margin = 80,
  feather = 24
}) {
  const safeWidth = Math.max(10, width - margin * 2);
  const safeHeight = Math.max(10, height - margin * 2);
  const rx = Math.min(feather * 2, 40);

  // Dùng SVG tạo nền trắng đục + đục lỗ trong suốt ở giữa với blur mềm
  const svg = `
  <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <filter id="soft-blur" x="-20%" y="-20%" width="140%" height="140%">
        <feGaussianBlur stdDeviation="${feather / 2}" />
      </filter>
      <mask id="hole-mask">
        <!-- Nền trắng toàn bộ mask (giữ) -->
        <rect width="100%" height="100%" fill="white" />
        <!-- Đục lỗ đen ở giữa (làm trong suốt) kèm blur mềm -->
        <rect x="${margin}" y="${margin}" width="${safeWidth}" height="${safeHeight}" rx="${rx}" fill="black" filter="url(#soft-blur)" />
      </mask>
    </defs>
    <!-- Vẽ hình chữ nhật trắng đục với mask đục lỗ -->
    <rect width="100%" height="100%" fill="white" mask="url(#hole-mask)" />
  </svg>
  `;

  // Chuyển sang PNG định dạng RGBA chuẩn
  const maskBuf = await sharp(Buffer.from(svg))
    .png({ colorType: "rgba" })
    .toBuffer();

  return maskBuf;
}
