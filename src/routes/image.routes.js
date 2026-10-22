import { Router } from "express";
import { editImageWithOpenAI } from "../services/openai.service.js";
import { createSliceMask } from "../utils/mask.util.js";
import { CloudinaryService } from "../services/cloudinary.service.js";

const router = Router();

// ============================================================
// POST /edit-image-openai
// Gọi OpenAI Image Edit API (hỗ trợ nhiều ảnh từ Drive, URL, Base64 + Mask RGBA)
// ============================================================
router.post("/edit-image-openai", async (req, res) => {
  const {
    prompt,
    prompt_for_generator,
    images = [],
    image_urls = [],
    raw_images = [],
    raw_image_ids = [],
    raw_image_1_url,
    raw_image_2_url,
    mask,
    mask_url,
    mask_b64,
    mask_file,
    model = "gpt-image-2",
    size,
    quality,
    api_key
  } = req.body;

  const finalPrompt = prompt || prompt_for_generator;
  const finalMask = mask || mask_b64 || mask_url || mask_file || null;
  const apiKey = api_key || req.headers.authorization?.replace(/^Bearer\s+/i, "") || process.env.OPENAI_API_KEY;

  if (!finalPrompt) {
    return res.status(400).json({
      success: false,
      message: "Thiếu tham số 'prompt' hoặc 'prompt_for_generator'"
    });
  }

  if (!apiKey) {
    return res.status(400).json({
      success: false,
      message: "Thiếu OpenAI API Key (truyền trong 'api_key' hoặc Header Authorization)"
    });
  }

  // Hàm trích xuất link hoặc ID từ string/object { url, id }
  const extractSource = (item) => {
    if (!item) return null;
    if (typeof item === "string") return item;
    if (typeof item === "object") return item.url || item.id || null;
    return null;
  };

  // Gom tất cả nguồn ảnh đầu vào thành 1 danh sách
  const rawList = [
    ...(Array.isArray(images) ? images : [images]),
    ...(Array.isArray(image_urls) ? image_urls : [image_urls]),
    ...(Array.isArray(raw_images) ? raw_images : [raw_images]),
    ...(Array.isArray(raw_image_ids) ? raw_image_ids : [raw_image_ids]),
    raw_image_1_url,
    raw_image_2_url
  ];

  const rawSources = rawList.map(extractSource).filter(Boolean);

  try {
    const openAiData = await editImageWithOpenAI({
      prompt: finalPrompt,
      rawSources,
      mask: finalMask,
      model,
      size,
      quality,
      apiKey
    });

    // Nếu OpenAI trả về b64_json, tự động upload lên Cloudinary để có link xem
    let imageUrl = openAiData.data?.[0]?.url || null;
    const b64 = openAiData.data?.[0]?.b64_json;
    let fileName = null;

    if (b64) {
      const imgBuffer = Buffer.from(b64, "base64");
      fileName = `ai_gen_${Date.now()}.png`;

      // Luôn lưu bản copy vào tmp để tương thích ngược với các workflow n8n dùng file_name
      try {
        const fs = await import("fs");
        const path = await import("path");
        const tmpDir = path.join(process.cwd(), "tmp");
        if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
        await fs.promises.writeFile(path.join(tmpDir, fileName), imgBuffer);
      } catch (err) {
        console.warn("⚠️ Không thể lưu ảnh đệm vào tmp:", err.message);
      }

      if (CloudinaryService.isConfigured()) {
        const cld = await CloudinaryService.uploadBuffer(imgBuffer, {
          folder: "content-flow/ai-generated",
          resource_type: "image",
          filename: fileName
        });
        imageUrl = cld.secure_url;
        console.log(`☁️ [CLOUDINARY] Ảnh AI đã sẵn sàng: ${imageUrl}`);
      } else {
        const host = req.get("host") || "localhost:3001";
        const protocol = req.protocol === "https" || req.headers["x-forwarded-proto"] === "https" ? "https" : "http";
        const baseUrl = process.env.BASE_URL || `${protocol}://${host}`;
        imageUrl = `${baseUrl}/tmp/${fileName}`;
        console.log(`💾 Đã lưu ảnh thành công vào: tmp/${fileName}`);
        console.log(`🌐 Link xem ảnh: ${imageUrl}`);
      }
    }

    console.log(`${"=".repeat(60)}\n`);
    return res.status(200).json({
      success: true,
      image_url: imageUrl,
      file_name: fileName,
      data: openAiData
    });

  } catch (error) {
    console.error(`❌ Lỗi xử lý edit image:`, error.message);
    console.log(`${"=".repeat(60)}\n`);
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
      details: error.details || null
    });
  }
});

// ============================================================
// BẢNG 6 STYLE (DỰ PHÒNG) — TỌA ĐỘ 2D ĐỤNG CHUẨN
//
// Tư tưởng: Panorama = canvas nhất định, cắt đúng vị trí 2D (x,y,w,h)
//            rồi post lên Facebook theo thứ tự → ghép lại thành 1 bức hoàn chỉnh.
//
// canvas_width / canvas_height: kích thước chuẩn hoá ảnh nguồn trước khi cắt
// slides[].x, y, w, h: tọa độ cắt trên canvas đã chuẩn hoá
// slides[].out_w, out_h: kích thước asset xuất ra (resize sau khi cắt)
// ============================================================
const GRID_STYLES_MAP = {

  // ── 1 ảnh ──────────────────────────────────────────────────
  // Canvas 1200x1200 → 1 slide duy nhất
  STYLE_1: {
    canvas_width: 1200, canvas_height: 1200,
    slides: [
      { slide_number: 1, x: 0, y: 0, w: 1200, h: 1200, out_w: 1200, out_h: 1200 }
    ]
  },

  // ── 2 ảnh ──────────────────────────────────────────────────
  // Canvas 2400x1200 → 2 cột vuông
  // FB: [─── 1 ───][─── 2 ───]
  STYLE_2: {
    canvas_width: 2400, canvas_height: 1200,
    slides: [
      { slide_number: 1, x: 0, y: 0, w: 1200, h: 1200, out_w: 1200, out_h: 1200 },
      { slide_number: 2, x: 1200, y: 0, w: 1200, h: 1200, out_w: 1200, out_h: 1200 }
    ]
  },

  // ── 3 ảnh ──────────────────────────────────────────────────
  // Canvas 2400x2400 → 1 dải ngang trên (2400x1200) + 2 ô vuông dưới (1200x1200)
  // FB: [══════════ 1 (ngang, full width) ══════════] (cắt top 800px → xuất 1200x800)
  //     [────────── 2 ──────────][────────── 3 ──────────]  (cắt bottom 1200px từ y=800 → xuất 1200x1200)
  STYLE_3: {
    canvas_width: 2400,
    canvas_height: 2400,
    slides: [
      {
        slide_number: 1,
        x: 0,
        y: 0,
        w: 2400,
        h: 1200,
        out_w: 1200,
        out_h: 600
      },
      {
        slide_number: 2,
        x: 0,
        y: 1200,
        w: 1200,
        h: 1200,
        out_w: 1200,
        out_h: 1200
      },
      {
        slide_number: 3,
        x: 1200,
        y: 1200,
        w: 1200,
        h: 1200,
        out_w: 1200,
        out_h: 1200
      }
    ]
  },

  // ── 4 ảnh ──────────────────────────────────────────────────
  // Canvas 2400x2400 → 2x2 grid 4 ô vuông bằng nhau
  // FB: [── 1 ──][── 2 ──]
  //     [── 3 ──][── 4 ──]
  STYLE_4: {
    canvas_width: 2400, canvas_height: 2400,
    slides: [
      { slide_number: 1, x: 0, y: 0, w: 1200, h: 1200, out_w: 1200, out_h: 1200 },
      { slide_number: 2, x: 1200, y: 0, w: 1200, h: 1200, out_w: 1200, out_h: 1200 },
      { slide_number: 3, x: 0, y: 1200, w: 1200, h: 1200, out_w: 1200, out_h: 1200 },
      { slide_number: 4, x: 1200, y: 1200, w: 1200, h: 1200, out_w: 1200, out_h: 1200 }
    ]
  },

  // Canvas 2000x3600 → 1 cột dọc trái + 3 ô vuông xếp chồng phải
  // FB: [══ 1 dọc ══][── 2 ──]
  //     [═ (full  ═][── 3 ──]
  //     [═ height)═][── 4 ──]
  STYLE_5: {
    canvas_width: 2000, canvas_height: 3600,
    slides: [
      { slide_number: 1, x: 0, y: 0, w: 800, h: 3600, out_w: 800, out_h: 1200 },
      { slide_number: 2, x: 800, y: 0, w: 1200, h: 1200, out_w: 1200, out_h: 1200 },
      { slide_number: 3, x: 800, y: 1200, w: 1200, h: 1200, out_w: 1200, out_h: 1200 },
      { slide_number: 4, x: 800, y: 2400, w: 1200, h: 1200, out_w: 1200, out_h: 1200 }
    ]
  },

  // Canvas 3600x2000 → 1 dải ngang trên + 3 ô vuông dưới
  // FB: [══════════════ 1 (ngang, full width) ══════════════]
  //     [──── 2 ────][──── 3 ────][──── 4 ────]  (dưới)
  STYLE_6: {
    canvas_width: 3600, canvas_height: 2000,
    slides: [
      { slide_number: 1, x: 0, y: 0, w: 3600, h: 800, out_w: 1200, out_h: 800 },
      { slide_number: 2, x: 0, y: 800, w: 1200, h: 1200, out_w: 1200, out_h: 1200 },
      { slide_number: 3, x: 1200, y: 800, w: 1200, h: 1200, out_w: 1200, out_h: 1200 },
      { slide_number: 4, x: 2400, y: 800, w: 1200, h: 1200, out_w: 1200, out_h: 1200 }
    ]
  }

};

// Alias hỗ trợ các tên Style cũ từ Prompt Builder để không bị lệch
GRID_STYLES_MAP.STYLE_7 = GRID_STYLES_MAP.STYLE_3;   // Style 7 cũ (3 ảnh: 1 trên 2 dưới) -> STYLE_3
GRID_STYLES_MAP.STYLE_8 = GRID_STYLES_MAP.STYLE_4;   // Style 8 cũ (4 ảnh vuông 2x2) -> STYLE_4
GRID_STYLES_MAP.STYLE_9 = GRID_STYLES_MAP.STYLE_5;   // Style 9 cũ (4 ảnh: 1 dọc 3 vuông) -> STYLE_5
GRID_STYLES_MAP.STYLE_10 = GRID_STYLES_MAP.STYLE_6;  // Style 10 cũ (4 ảnh: 1 ngang 3 vuông) -> STYLE_6


// ============================================================
// POST /split-panorama
// Cắt ảnh Panorama / Grid Collage ĐỘNG 100% THEO THÔNG SỐ TỪ PROMPT BUILDER
// ============================================================
router.post("/split-panorama", async (req, res) => {
  const {
    image,
    image_url,
    b64_json,
    file_name,
    selected_style,
    slides_count,
    slides_layout,
    slide_zones,
    cut_positions,
    panorama_width,
    panorama_height
  } = req.body;

  const rawInput = image || image_url || b64_json || file_name;

  if (!rawInput) {
    return res.status(400).json({
      success: false,
      message: "Thiếu dữ liệu ảnh (truyền vào image, image_url, b64_json hoặc file_name)"
    });
  }

  try {
    const sharp = (await import("sharp")).default;
    const fs = await import("fs");
    const path = await import("path");

    let inputBuffer = null;

    if (typeof rawInput === "string" && (rawInput.startsWith("http://") || rawInput.startsWith("https://"))) {
      const fetched = await fetch(rawInput);
      if (!fetched.ok) throw new Error(`Không thể tải ảnh từ URL: ${rawInput}`);
      inputBuffer = Buffer.from(await fetched.arrayBuffer());
    } else if (typeof rawInput === "string" && rawInput.startsWith("data:image")) {
      const cleanB64 = rawInput.replace(/^data:image\/\w+;base64,/, "");
      inputBuffer = Buffer.from(cleanB64, "base64");
    } else if (typeof rawInput === "string" && /^[A-Za-z0-9+/=]{100,}$/.test(rawInput.trim())) {
      inputBuffer = Buffer.from(rawInput.trim(), "base64");
    } else if (typeof rawInput === "string") {
      const localPath = path.join(process.cwd(), "tmp", rawInput);
      if (fs.existsSync(localPath)) {
        inputBuffer = await fs.promises.readFile(localPath);
      }
    }

    if (!inputBuffer) {
      throw new Error("Không thể đọc được dữ liệu ảnh Panorama từ input");
    }

    const metadata = await sharp(inputBuffer).metadata();
    const origWidth = metadata.width;
    const origHeight = metadata.height;

    const tmpDir = path.join(process.cwd(), "tmp");
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

    const slices = [];
    const timestamp = Date.now();
    const host = req.get("host") || "localhost:3001";
    const protocol = req.protocol === "https" || req.headers["x-forwarded-proto"] === "https" ? "https" : "http";
    const baseUrl = process.env.BASE_URL || `${protocol}://${host}`;

    // Thu thập metadata từ slides_layout (layout_note, template_hint) nếu có
    const rawLayoutList = Array.isArray(slides_layout) && slides_layout.length > 0
      ? slides_layout
      : (Array.isArray(slide_zones) && slide_zones.length > 0 ? slide_zones : []);

    // Tạo metadata map theo slide_number để enrich sau khi cắt
    const metaBySlide = {};
    for (const l of rawLayoutList) {
      const num = l.slide_number || l.variant_no;
      if (num) metaBySlide[num] = { layout_note: l.layout_note || "", template_hint: l.template_hint || "" };
    }

    // 🌟 ƯU TIÊN 1: NẾU selected_style CÓ TRONG GRID_STYLES_MAP → CẮT 2D ĐÚNG TƯ TƯỞNG
    // (slides_layout từ Prompt Builder chỉ dùng cho metadata, KHÔNG dùng tọa độ cắt)
    const styleKey = String(selected_style || "").toUpperCase().trim();
    const styleSpec = GRID_STYLES_MAP[styleKey];

    if (styleSpec) {
      const { canvas_width, canvas_height, slides: styleSlides } = styleSpec;
      console.log(`🧩 [GRID 2D] Style ${styleKey} (${styleSlides.length} slides) — Canvas ${canvas_width}×${canvas_height} — Cắt 2D chính xác`);

      // Bước 1: Chuẩn hoá ảnh nguồn về đúng kích thước canvas
      const normalizedCanvas = await sharp(inputBuffer)
        .resize(canvas_width, canvas_height, { fit: "fill", kernel: sharp.kernel.lanczos3 })
        .toBuffer();

      console.log(`   📏 Đã chuẩn hoá canvas: ${canvas_width}×${canvas_height}px`);

      // Bước 2: Cắt từng slide theo tọa độ 2D chính xác
      for (const slide of styleSlides) {
        const rawSlice = await sharp(normalizedCanvas)
          .extract({ left: slide.x, top: slide.y, width: slide.w, height: slide.h })
          .toBuffer();

        const needsResize = slide.w !== slide.out_w || slide.h !== slide.out_h;
        const finalSliceBuf = needsResize
          ? await sharp(rawSlice)
            .resize(slide.out_w, slide.out_h, { fit: "fill", kernel: sharp.kernel.lanczos3 })
            .sharpen({ sigma: 0.8 })
            .png()
            .toBuffer()
          : await sharp(rawSlice).sharpen({ sigma: 0.8 }).png().toBuffer();

        console.log(`   ✂️ Slide ${slide.slide_number}: [x=${slide.x}, y=${slide.y}, ${slide.w}×${slide.h}] → Output [${slide.out_w}×${slide.out_h}]`);

        const fileName = `grid_${styleKey.toLowerCase()}_${timestamp}_${slide.slide_number}.png`;
        let sliceUrl = "";
        let maskUrl = null;
        let maskFileName = null;
        let maskBuf = null;

        try {
          maskBuf = await createSliceMask({
            width: slide.out_w,
            height: slide.out_h,
            margin: 80,
            feather: 24
          });
          maskFileName = `mask_${styleKey.toLowerCase()}_${timestamp}_${slide.slide_number}.png`;
        } catch (mErr) {
          console.warn(`   ⚠️ Không thể tạo mask cho slide ${slide.slide_number}:`, mErr.message);
        }

        if (CloudinaryService.isConfigured()) {
          const cldSlice = await CloudinaryService.uploadBuffer(finalSliceBuf, {
            folder: "content-flow/slices",
            resource_type: "image",
            filename: fileName
          });
          sliceUrl = cldSlice.secure_url;

          if (maskBuf) {
            const cldMask = await CloudinaryService.uploadBuffer(maskBuf, {
              folder: "content-flow/masks",
              resource_type: "image",
              filename: maskFileName
            });
            maskUrl = cldMask.secure_url;
          }
        } else {
          const filePath = path.join(tmpDir, fileName);
          await fs.promises.writeFile(filePath, finalSliceBuf);
          sliceUrl = `${baseUrl}/tmp/${fileName}`;

          if (maskBuf) {
            const maskFilePath = path.join(tmpDir, maskFileName);
            await fs.promises.writeFile(maskFilePath, maskBuf);
            maskUrl = `${baseUrl}/tmp/${maskFileName}`;
          }
        }

        const meta = metaBySlide[slide.slide_number] || {};
        slices.push({
          slide_number: slide.slide_number,
          style: styleKey,
          file_name: fileName,
          image_url: sliceUrl,
          b64_json: finalSliceBuf.toString("base64"),
          mask_file_name: maskFileName,
          mask_image_url: maskUrl,
          mask_b64: maskBuf ? maskBuf.toString("base64") : null,
          width: slide.out_w,
          height: slide.out_h,
          layout_note: meta.layout_note || "",
          template_hint: meta.template_hint || ""
        });
      }

      console.log(`✅ [GRID 2D] Đã cắt ${slices.length} slide cho ${styleKey} (${slices.map(s => `${s.width}×${s.height}`).join(", ")})`);

      return res.status(200).json({
        success: true,
        mode: "GRID_2D",
        style: styleKey,
        canvas_dimensions: { width: canvas_width, height: canvas_height },
        original_dimensions: { width: origWidth, height: origHeight },
        slides_count: slices.length,
        slices
      });
    }

    // 🌟 ƯU TIÊN 2: DYNAMIC 1D — Dùng khi style KHÔNG có trong map (custom/unknown style)
    // Chỉ chạy khi có slides_layout và không match GRID_STYLES_MAP
    if (rawLayoutList.length > 0) {
      console.log(`🧩 [DYNAMIC 1D] Style "${styleKey}" không có trong GRID_STYLES_MAP → cắt theo slides_layout`);

      const count = rawLayoutList.length;
      let totalLogicalWidth = parseInt(panorama_width, 10) || 0;
      if (!totalLogicalWidth) {
        const maxEnd = Math.max(...rawLayoutList.map(l => (typeof l.end_x === "number" ? l.end_x : 0)));
        if (maxEnd > 0) {
          totalLogicalWidth = maxEnd;
        } else {
          totalLogicalWidth = rawLayoutList.reduce((acc, l) => acc + (parseInt(l.width || l.zone_width || l.source_width, 10) || 1200), 0);
        }
      }

      for (let i = 0; i < count; i++) {
        const layout = rawLayoutList[i];
        const slideNum = layout.slide_number || layout.variant_no || (i + 1);
        const targetWidth = parseInt(layout.width || layout.zone_width || layout.source_width, 10) || 1200;
        const targetHeight = parseInt(layout.height || layout.zone_height || layout.source_height, 10) || 1200;

        let startRatio = i / count;
        let endRatio = (i + 1) / count;

        if (typeof layout.start_x === "number" && typeof layout.end_x === "number" && totalLogicalWidth > 0) {
          startRatio = layout.start_x / totalLogicalWidth;
          endRatio = layout.end_x / totalLogicalWidth;
        } else if (Array.isArray(cut_positions) && cut_positions.length >= count - 1 && totalLogicalWidth > 0) {
          const prevCut = i === 0 ? 0 : cut_positions[i - 1];
          const nextCut = i === count - 1 ? totalLogicalWidth : cut_positions[i];
          startRatio = prevCut / totalLogicalWidth;
          endRatio = nextCut / totalLogicalWidth;
        }

        const left = Math.max(0, Math.min(origWidth - 1, Math.round(startRatio * origWidth)));
        const right = Math.max(left + 1, Math.min(origWidth, Math.round(endRatio * origWidth)));
        const cropWidth = Math.max(1, right - left);

        console.log(`   ✂️ Slide ${slideNum}: x=[${left}→${right}] → [${targetWidth}×${targetHeight}px]`);

        const rawSlice = await sharp(inputBuffer)
          .extract({ left, top: 0, width: cropWidth, height: origHeight })
          .toBuffer();

        const finalSliceBuf = await sharp(rawSlice)
          .resize(targetWidth, targetHeight, { fit: "fill", kernel: sharp.kernel.lanczos3 })
          .sharpen({ sigma: 0.8 })
          .png()
          .toBuffer();

        const fileName = `slide_slice_${timestamp}_${slideNum}.png`;
        let sliceUrl = "";
        let maskUrl = null;
        let maskFileName = null;
        let maskBuf = null;

        try {
          maskBuf = await createSliceMask({
            width: targetWidth,
            height: targetHeight,
            margin: 80,
            feather: 24
          });
          maskFileName = `mask_slice_${timestamp}_${slideNum}.png`;
        } catch (mErr) {
          console.warn(`   ⚠️ Không thể tạo mask cho slide ${slideNum}:`, mErr.message);
        }

        if (CloudinaryService.isConfigured()) {
          const cldSlice = await CloudinaryService.uploadBuffer(finalSliceBuf, {
            folder: "content-flow/slices",
            resource_type: "image",
            filename: fileName
          });
          sliceUrl = cldSlice.secure_url;

          if (maskBuf) {
            const cldMask = await CloudinaryService.uploadBuffer(maskBuf, {
              folder: "content-flow/masks",
              resource_type: "image",
              filename: maskFileName
            });
            maskUrl = cldMask.secure_url;
          }
        } else {
          const filePath = path.join(tmpDir, fileName);
          await fs.promises.writeFile(filePath, finalSliceBuf);
          sliceUrl = `${baseUrl}/tmp/${fileName}`;

          if (maskBuf) {
            const maskFilePath = path.join(tmpDir, maskFileName);
            await fs.promises.writeFile(maskFilePath, maskBuf);
            maskUrl = `${baseUrl}/tmp/${maskFileName}`;
          }
        }

        slices.push({
          slide_number: slideNum,
          file_name: fileName,
          image_url: sliceUrl,
          b64_json: finalSliceBuf.toString("base64"),
          mask_file_name: maskFileName,
          mask_image_url: maskUrl,
          mask_b64: maskBuf ? maskBuf.toString("base64") : null,
          width: targetWidth,
          height: targetHeight,
          layout_note: layout.layout_note || "",
          template_hint: layout.template_hint || ""
        });
      }

      console.log(`✅ [DYNAMIC SLICE] Đã cắt thành công ${slices.length} slide động (${slices.map(s => `${s.width}x${s.height}`).join(", ")})`);

      return res.status(200).json({
        success: true,
        mode: "DYNAMIC_LAYOUT",
        original_dimensions: { width: origWidth, height: origHeight },
        slides_count: slices.length,
        slices
      });
    }

    // 🌟 ƯU TIÊN 3: FALLBACK MẶC ĐỊNH CHIA ĐỀU N PHẦN VUÔNG 1080x1080
    const count = Math.max(1, parseInt(slides_count, 10) || 3);
    const sliceUnitWidth = Math.floor(origWidth / count);

    for (let i = 0; i < count; i++) {
      const left = i * sliceUnitWidth;
      const currentWidth = (i === count - 1) ? (origWidth - left) : sliceUnitWidth;

      const rawSlice = await sharp(inputBuffer)
        .extract({ left, top: 0, width: currentWidth, height: origHeight })
        .toBuffer();

      const finalSliceBuf = await sharp(rawSlice)
        .resize(1080, 1080, { fit: "fill", kernel: sharp.kernel.lanczos3 })
        .sharpen({ sigma: 0.8 })
        .png()
        .toBuffer();

      const fileName = `default_slice_${timestamp}_${i + 1}.png`;
      let sliceUrl = "";
      let maskUrl = null;
      let maskFileName = null;
      let maskBuf = null;

      try {
        maskBuf = await createSliceMask({
          width: 1080,
          height: 1080,
          margin: 80,
          feather: 24
        });
        maskFileName = `mask_default_${timestamp}_${i + 1}.png`;
      } catch (mErr) {
        console.warn(`   ⚠️ Không thể tạo mask cho slide ${i + 1}:`, mErr.message);
      }

      if (CloudinaryService.isConfigured()) {
        const cldSlice = await CloudinaryService.uploadBuffer(finalSliceBuf, {
          folder: "content-flow/slices",
          resource_type: "image",
          filename: fileName
        });
        sliceUrl = cldSlice.secure_url;

        if (maskBuf) {
          const cldMask = await CloudinaryService.uploadBuffer(maskBuf, {
            folder: "content-flow/masks",
            resource_type: "image",
            filename: maskFileName
          });
          maskUrl = cldMask.secure_url;
        }
      } else {
        const filePath = path.join(tmpDir, fileName);
        await fs.promises.writeFile(filePath, finalSliceBuf);
        sliceUrl = `${baseUrl}/tmp/${fileName}`;

        if (maskBuf) {
          const maskFilePath = path.join(tmpDir, maskFileName);
          await fs.promises.writeFile(maskFilePath, maskBuf);
          maskUrl = `${baseUrl}/tmp/${maskFileName}`;
        }
      }

      slices.push({
        slide_number: i + 1,
        file_name: fileName,
        image_url: sliceUrl,
        b64_json: finalSliceBuf.toString("base64"),
        mask_file_name: maskFileName,
        mask_image_url: maskUrl,
        mask_b64: maskBuf ? maskBuf.toString("base64") : null,
        width: 1080,
        height: 1080
      });
    }

    return res.status(200).json({
      success: true,
      mode: "EQUAL_SLICES",
      original_dimensions: { width: origWidth, height: origHeight },
      slides_count: count,
      slices
    });

  } catch (error) {
    console.error("❌ Lỗi /split-panorama:", error.message);
    return res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

export default router;

