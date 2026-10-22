import sharp from "sharp";
import { downloadFromGoogleDrive } from "../utils/drive.util.js";

/**
 * Service: Xử lý Edit ảnh với OpenAI API (hỗ trợ nhiều ảnh từ Drive, URL, Base64)
 */
export async function editImageWithOpenAI({
  prompt,
  rawSources = [],
  mask,
  model = "gpt-image-2",
  size,
  quality,
  apiKey
}) {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`🎨 [OPENAI IMAGE EDIT] Bắt đầu xử lý`);
  console.log(`🤖 Model: ${model}`);
  console.log(`📝 Prompt: ${prompt.slice(0, 80)}...`);
  console.log(`🖼️ Số lượng ảnh đầu vào: ${rawSources.length}`);
  if (mask) console.log(`🎭 Có Mask đính kèm để bảo vệ nền`);

  const fs = await import("fs");
  const path = await import("path");
  const imageBlobs = [];

  for (let i = 0; i < rawSources.length; i++) {
    const src = rawSources[i];
    if (!src) continue;
    let buf = null;
    let desc = "";

    if (Buffer.isBuffer(src)) {
      buf = src;
      desc = "Buffer";
    } else if (typeof src === "string" && src.startsWith("data:image")) {
      const base64Data = src.replace(/^data:image\/\w+;base64,/, "");
      buf = Buffer.from(base64Data, "base64");
      desc = "Data URI Base64";
    } else if (typeof src === "string" && (src.length > 500 || src.startsWith("iVBORw0KGgo"))) {
      // Chuỗi Base64 thuần từ sharp / split-panorama
      const cleanB64 = src.replace(/\s+/g, "");
      buf = Buffer.from(cleanB64, "base64");
      desc = `Pure Base64 (${Math.round(cleanB64.length / 1024)} KB)`;
    } else if (typeof src === "string" && (src.startsWith("http://") || src.startsWith("https://"))) {
      desc = `URL: ${src.slice(0, 60)}...`;
      console.log(`   ⬇️ Đang tải ảnh ${i + 1} từ ${desc}`);
      if (src.includes("drive.google.com") || src.includes("drive.usercontent.google.com")) {
        const driveRes = await downloadFromGoogleDrive(src);
        buf = Buffer.from(await driveRes.arrayBuffer());
      } else {
        const fetched = await fetch(src);
        if (!fetched.ok) throw new Error(`Không thể tải ảnh từ URL: ${src} (HTTP ${fetched.status})`);
        buf = Buffer.from(await fetched.arrayBuffer());
      }
    } else if (typeof src === "string" && (src.endsWith(".png") || src.endsWith(".jpg") || src.endsWith(".jpeg"))) {
      // File trong thư mục tmp/
      const localPath = path.join(process.cwd(), "tmp", src);
      if (fs.existsSync(localPath)) {
        buf = await fs.promises.readFile(localPath);
        desc = `Local tmp file (${src})`;
      }
    } else if (typeof src === "string" && /^[a-zA-Z0-9_-]{25,45}$/.test(src)) {
      // Google Drive File ID chuẩn (độ dài 25-45 ký tự)
      desc = `Drive ID: ${src}`;
      console.log(`   ⬇️ Đang tải ảnh ${i + 1} từ ${desc}`);
      const driveUrl = `https://drive.google.com/uc?export=download&id=${src}`;
      const driveRes = await downloadFromGoogleDrive(driveUrl);
      buf = Buffer.from(await driveRes.arrayBuffer());
    }

    if (buf) {
      // Chuẩn hóa sang PNG bằng Sharp để OpenAI 100% chấp nhận
      const pngBuf = await sharp(buf).png().toBuffer();
      const blob = new Blob([pngBuf], { type: "image/png" });
      imageBlobs.push({ blob, filename: `input_image_${i + 1}.png` });
      console.log(`   ✅ Nạp thành công ảnh ${i + 1} [${desc}]: ${pngBuf.length} bytes PNG`);
    } else {
      console.warn(`   ⚠️ CẢNH BÁO: Không thể nạp ảnh ${i + 1} (dữ liệu không hợp lệ):`, typeof src === "string" ? src.slice(0, 50) : src);
    }
  }

  console.log(`🖼️ Tổng số ảnh hợp lệ gửi sang OpenAI: ${imageBlobs.length}/${rawSources.length}`);


  // 2. Nếu không có ảnh đầu vào -> Gọi Text-to-Image Generations
  if (imageBlobs.length === 0) {
    const targetModel = model || "gpt-image-2";
    console.log(`ℹ️ Không có ảnh đầu vào -> Chuyển sang Text-to-Image Generation (Model: ${targetModel})...`);

    const genPayload = {
      model: targetModel,
      prompt: prompt
    };

    if (size) {
      genPayload.size = size;
    } else if (targetModel.includes("dall-e-3") || targetModel.includes("gpt-image")) {
      genPayload.size = "1792x1024";
    }

    if (quality) {
      genPayload.quality = quality;
    } else if (targetModel.includes("dall-e-3")) {
      genPayload.quality = "hd";
    }

    const genRes = await fetch("https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`
      },
      body: JSON.stringify(genPayload)
    });


    const genData = await genRes.json();
    if (genData.error) {
      console.error(`❌ OpenAI API Error:`, genData.error);
      const err = new Error(genData.error.message || JSON.stringify(genData.error));
      err.status = genRes.status || 400;
      err.details = genData.error;
      throw err;
    }

    // Nếu trả về URL, tải về và chuyển sang b64_json để đồng bộ với pipeline
    if (genData.data?.[0]?.url && !genData.data?.[0]?.b64_json) {
      try {
        console.log(`⬇️ Đang tải ảnh HD từ OpenAI URL...`);
        const imgRes = await fetch(genData.data[0].url);
        if (imgRes.ok) {
          const buf = Buffer.from(await imgRes.arrayBuffer());
          genData.data[0].b64_json = buf.toString("base64");
        }
      } catch (dlErr) {
        console.warn(`⚠️ Không thể tải ảnh từ URL OpenAI về base64:`, dlErr.message);
      }
    }

    console.log(`🎉 Tạo ảnh Panorama HD thành công!`);
    return genData;
  }


  console.log(`✅ Đã chuẩn hóa ${imageBlobs.length} ảnh sang định dạng PNG! Đang gọi OpenAI Image Edit API...`);

  // Xử lý Mask RGBA nếu có
  let maskBlob = null;
  if (mask) {
    let maskBuf = null;
    let maskDesc = "";
    if (Buffer.isBuffer(mask)) {
      maskBuf = mask;
      maskDesc = "Buffer";
    } else if (typeof mask === "string" && mask.startsWith("data:image")) {
      const b64 = mask.replace(/^data:image\/\w+;base64,/, "");
      maskBuf = Buffer.from(b64, "base64");
      maskDesc = "Data URI Base64";
    } else if (typeof mask === "string" && (mask.length > 500 || mask.startsWith("iVBORw0KGgo"))) {
      maskBuf = Buffer.from(mask.replace(/\s+/g, ""), "base64");
      maskDesc = "Pure Base64";
    } else if (typeof mask === "string" && (mask.startsWith("http://") || mask.startsWith("https://"))) {
      maskDesc = `URL: ${mask.slice(0, 50)}...`;
      const fetched = await fetch(mask);
      if (fetched.ok) maskBuf = Buffer.from(await fetched.arrayBuffer());
    } else if (typeof mask === "string" && (mask.endsWith(".png") || mask.endsWith(".jpg"))) {
      const localPath = path.join(process.cwd(), "tmp", mask);
      if (fs.existsSync(localPath)) {
        maskBuf = await fs.promises.readFile(localPath);
        maskDesc = `Local tmp file (${mask})`;
      }
    }

    if (maskBuf) {
      const pngMaskBuf = await sharp(maskBuf).png({ colorType: "rgba" }).toBuffer();
      maskBlob = new Blob([pngMaskBuf], { type: "image/png" });
      console.log(`   🎭 Nạp thành công Mask [${maskDesc}]: ${pngMaskBuf.length} bytes RGBA`);
    } else {
      console.warn(`   ⚠️ CẢNH BÁO: Không thể nạp Mask từ input:`, typeof mask === "string" ? mask.slice(0, 50) : mask);
    }
  }

  // 3. Tạo FormData gửi sang OpenAI Image Edits API (nếu có ảnh đầu vào)
  const formData = new FormData();
  formData.append("model", model);
  formData.append("prompt", prompt);

  if (maskBlob) {
    formData.append("mask", maskBlob, "mask.png");
  }

  for (let i = 0; i < imageBlobs.length; i++) {
    formData.append("image[]", imageBlobs[i].blob, imageBlobs[i].filename);
  }

  const openAiRes = await fetch("https://api.openai.com/v1/images/edits", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`
    },
    body: formData
  });

  const openAiData = await openAiRes.json();

  if (openAiData.error) {
    console.error(`❌ OpenAI API Error:`, openAiData.error);
    const err = new Error(openAiData.error.message || JSON.stringify(openAiData.error));
    err.status = openAiRes.status || 400;
    err.details = openAiData.error;
    throw err;
  }

  console.log(`🎉 Tạo ảnh thành công!`);
  return openAiData;
}


