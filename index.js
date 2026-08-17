import "dotenv/config";
import express from "express";
import puppeteer from "puppeteer";
import { exec } from "child_process";
import util from "util";
import fs from "fs";
import path from "path";

const execPromise = util.promisify(exec);
const app = express();
const PORT = process.env.PORT || 3001;

app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));
app.use("/assets", express.static("assets"));

// ============================================================
// Helper: Chèn logo/watermark vào video bằng FFmpeg
// ============================================================
async function applyWatermark(inputBuffer, logoPath, position = "tiled", logoWidth = 160, opacity = 0.25) {
  const tempDir = path.join(process.cwd(), "tmp");
  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

  const tempInput = path.join(tempDir, `input_${Date.now()}.mp4`);
  const tempOutput = path.join(tempDir, `output_${Date.now()}.mp4`);

  // Ghi file tạm
  await fs.promises.writeFile(tempInput, inputBuffer);

  let filter = "";
  const posLower = String(position).toLowerCase().trim();

  if (posLower === "tiled" || posLower === "repeat" || posLower === "full" || posLower === "pattern") {
    // Chế độ Watermark phủ rải rác mờ mờ toàn bộ màn hình (Tiled Pattern Watermark)
    filter = `[1:v]format=rgba,colorchannelmixer=aa=${opacity},scale=w=${logoWidth}:h=-1,tile=layout=6x6[wm];[0:v][wm]overlay=0:0`;
  } else {
    // Chế độ Watermark đặt ở 1 góc cố định
    let overlayPos = "W-w-25:25"; // top_right (mặc định)
    if (posLower === "bottom_right") overlayPos = "W-w-25:H-h-25";
    if (posLower === "top_left") overlayPos = "25:25";
    if (posLower === "bottom_left") overlayPos = "25:H-h-25";
    if (posLower === "center") overlayPos = "(W-w)/2:(H-h)/2";

    filter = `[1:v]format=rgba,colorchannelmixer=aa=${opacity},scale=w=${logoWidth}:h=-1[wm];[0:v][wm]overlay=${overlayPos}`;
  }

  const cmd = `ffmpeg -y -i "${tempInput}" -i "${logoPath}" -filter_complex "${filter}" -c:a copy -preset fast "${tempOutput}"`;

  try {
    console.log(`🎬 [WATERMARK] Đang đóng dấu (${posLower}) | Độ mờ: ${opacity * 100}% | Logo rộng: ${logoWidth}px...`);
    await execPromise(cmd);
    const outputBuffer = await fs.promises.readFile(tempOutput);

    // Dọn dẹp file tạm
    if (fs.existsSync(tempInput)) fs.unlinkSync(tempInput);
    if (fs.existsSync(tempOutput)) fs.unlinkSync(tempOutput);

    console.log(`✅ [WATERMARK] Đã hoàn tất đóng dấu video!`);
    return outputBuffer;
  } catch (err) {
    if (fs.existsSync(tempInput)) fs.unlinkSync(tempInput);
    if (fs.existsSync(tempOutput)) fs.unlinkSync(tempOutput);
    throw new Error(`FFmpeg Watermark Error: ${err.message}`);
  }
}

// ============================================================
// POST /render-html & /render-template
// Render mã HTML/CSS từ Gemini thành ảnh PNG 1200x1200px
// ============================================================
const TEMPLATES_DIR = path.join(process.cwd(), "templates");
const LOGO_URL = "http://172.28.160.1:3001/assets/logo.png";

const templateCache = {};
function loadTemplate(contentType) {
  if (templateCache[contentType]) return templateCache[contentType];
  const filePath = path.join(TEMPLATES_DIR, `${contentType}.html`);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Không tìm thấy template cho content_type="${contentType}" tại ${filePath}`);
  }
  const html = fs.readFileSync(filePath, "utf8");
  templateCache[contentType] = html;
  return html;
}

function fillRepeatBlock(html, markerName, items, fillItemFn) {
  const startTag = `<!--REPEAT_START:${markerName}-->`;
  const endTag = `<!--REPEAT_END:${markerName}-->`;
  const startIdx = html.indexOf(startTag);
  const endIdx = html.indexOf(endTag);
  if (startIdx === -1 || endIdx === -1) return html;

  const filledBlocks = (items || []).map(fillItemFn).join("\n");
  return html.substring(0, startIdx) + filledBlocks + html.substring(endIdx + endTag.length);
}

function fillScalars(html, fields) {
  let out = html;
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue;
    const re = new RegExp(`__${key}__`, "g");
    out = out.replace(re, String(value));
  }
  return out;
}

function buildHtmlFromTemplate(payload) {
  const {
    content_type,
    canvas_width = 1200,
    canvas_height = 1200,
    headline = "",
    subtext = "",
    raw_image_1_url = "",
    raw_image_2_url = "",
    rich_content = {},
  } = payload;

  let html = loadTemplate(content_type);

  if (content_type === "list" || content_type === "checklist") {
    html = fillRepeatBlock(html, "list_item", rich_content.list_items, (text) =>
      `      <div class="list-item"><div class="icon">🔸</div><span>${text}</span></div>`
    );
  }

  if (content_type === "icon_grid") {
    html = fillRepeatBlock(html, "grid_item", rich_content.grid_items, (g) =>
      `      <div class="grid-item"><div class="icon">${g.icon}</div><span class="label">${g.label}</span></div>`
    );
  }

  html = fillScalars(html, {
    CANVAS_W: canvas_width,
    CANVAS_H: canvas_height,
    HEADLINE: headline,
    SUBTEXT: subtext,
    PARAGRAPH_TEXT: rich_content.paragraph_text,
    LOGO_URL: LOGO_URL,
    IMG_1: raw_image_1_url,
    IMG_2: raw_image_2_url,
  });

  return html;
}

async function renderHtmlToPngBuffer(html, width, height) {
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-gpu"],
    });
    const page = await browser.newPage();
    await page.setViewport({ width: parseInt(width), height: parseInt(height) });
    try {
      await page.setContent(html, { waitUntil: "networkidle0", timeout: 15000 });
    } catch (e) {
      console.warn("⚠️ setContent timeout/lỗi (có thể do font mạng chậm):", e.message);
    }
    await page.addStyleTag({
      content: `html, body {
        margin: 0 !important;
        padding: 0 !important;
        width: ${parseInt(width)}px !important;
        height: ${parseInt(height)}px !important;
        overflow: hidden !important;
      }`,
    });
    const buffer = await page.screenshot({ type: "png" });
    await browser.close();
    return buffer;
  } catch (err) {
    if (browser) await browser.close();
    throw err;
  }
}

app.post("/render-html", async (req, res) => {
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

app.post("/render-template", async (req, res) => {
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

app.post("/render-template/preview-html", (req, res) => {
  try {
    const html = buildHtmlFromTemplate(req.body);
    res.setHeader("Content-Type", "text/html");
    return res.send(html);
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

// Helper download từ Google Drive
async function downloadFromGoogleDrive(url) {
  let fileId = "";
  const idMatch = url.match(/id=([a-zA-Z0-9_-]+)/) || url.match(/\/d\/([a-zA-Z0-9_-]+)/);
  if (idMatch) fileId = idMatch[1];

  let targetUrl = url;
  if (fileId && !url.includes("confirm=")) {
    targetUrl = `https://drive.usercontent.google.com/download?id=${fileId}&export=download&confirm=t`;
  }

  const firstRes = await fetch(targetUrl, {
    redirect: "follow",
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
    }
  });
  if (!firstRes.ok) throw new Error(`Drive HTTP ${firstRes.status}`);

  const contentType = firstRes.headers.get("content-type") || "";

  if (contentType.includes("text/html")) {
    console.log(`⚠️ Drive trả HTML (virus-scan warning) → đang bóc link confirm...`);
    const html = await firstRes.text();
    const hrefMatch = html.match(/href="([^"]*confirm=[^"]*)"/);
    let confirmedUrl = "";

    if (hrefMatch) {
      let extractedPath = hrefMatch[1].replace(/&amp;/g, "&");
      confirmedUrl = extractedPath.startsWith("http")
        ? extractedPath
        : `https://drive.google.com${extractedPath}`;
    } else if (fileId) {
      confirmedUrl = `https://drive.usercontent.google.com/download?id=${fileId}&export=download&confirm=t`;
    }

    if (confirmedUrl) {
      console.log(`✅ Link confirm: ${confirmedUrl.slice(0, 80)}... → đang download lại...`);
      const confirmedRes = await fetch(confirmedUrl, {
        redirect: "follow",
        headers: { "User-Agent": "Mozilla/5.0" }
      });
      if (!confirmedRes.ok) throw new Error(`Drive confirmed HTTP ${confirmedRes.status}`);
      return confirmedRes;
    }
  }

  return firstRes;
}

// ============================================================
// POST /watermark-video
// Đóng dấu logo watermark vào video từ Google Drive và trả về file video
// ============================================================
app.post("/watermark-video", async (req, res) => {
  const { drive_url, position = "tiled", logo_width = 160, opacity = 0.25, custom_logo } = req.body;

  if (!drive_url) {
    return res.status(400).json({ success: false, message: "Thiếu tham số drive_url" });
  }

  try {
    console.log(`\n⬇️ Tải video từ Drive...`);
    const driveRes = await downloadFromGoogleDrive(drive_url);
    let videoBuffer = Buffer.from(await driveRes.arrayBuffer());

    let logoPath = custom_logo || path.join(process.cwd(), "assets", "logo-watermark.png");
    if (!fs.existsSync(logoPath)) {
      logoPath = path.join(process.cwd(), "assets", "logo.png");
    }

    videoBuffer = await applyWatermark(videoBuffer, logoPath, position, parseInt(logo_width), parseFloat(opacity));

    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Disposition", 'attachment; filename="watermarked_video.mp4"');
    return res.send(videoBuffer);
  } catch (error) {
    console.error("❌ Lỗi gắn watermark video:", error.message);
    return res.status(500).json({ success: false, message: error.message });
  }
});

// ============================================================
// POST /upload-video
// Proxy upload video từ Google Drive lên Facebook (có hỗ trợ gắn Watermark)
//
// Body JSON:
// {
//   "drive_url"          : "https://drive.google.com/...",
//   "access_token"       : "EAAxxxxxxxxx",
//   "description"        : "Caption bài đăng",
//   "page_id"            : "me",
//   "watermark"          : true | false,
//   "watermark_position" : "tiled" | "top_right" | "bottom_right" | "top_left" | "bottom_left" | "center",
//   "logo_width"         : 160,
//   "opacity"            : 0.25
// }
// ============================================================
app.post("/upload-video", async (req, res) => {
  const {
    drive_url,
    access_token,
    description,
    page_id,
    watermark = false,
    watermark_position = "tiled",
    logo_width = 160,
    opacity = 0.25,
    custom_logo = null
  } = req.body;

  // --- Validate ---
  if (!drive_url || !access_token) {
    return res.status(400).json({
      success: false,
      message: "Thiếu tham số bắt buộc: drive_url, access_token"
    });
  }

  const target = page_id || "me";
  const FB_API = `https://graph-video.facebook.com/v19.0/${target}/videos`;

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

    const fileSize = videoBuffer.length;

    // ── BƯỚC 2: START - Khởi tạo upload session ─────────────
    console.log(`\n🚀 Phase 1: Start upload session...`);
    const startRes = await fetch(FB_API, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        upload_phase: "start",
        file_size: fileSize.toString(),
        access_token
      }).toString()
    });

    const startData = await startRes.json();
    if (startData.error) throw new Error(`Start failed: ${JSON.stringify(startData.error)}`);

    const { upload_session_id, video_id } = startData;
    let startOffset = parseInt(startData.start_offset);
    let endOffset = parseInt(startData.end_offset);
    const chunkSize = endOffset - startOffset;

    console.log(`✅ Session: ${upload_session_id} | Video ID: ${video_id}`);
    console.log(`📦 Chunk size: ${(chunkSize / 1024).toFixed(0)} KB`);

    // ── BƯỚC 3: TRANSFER - Upload từng chunk ─────────────────
    const totalChunks = Math.ceil(fileSize / chunkSize);
    console.log(`\n⬆️ Phase 2: Transfer ${totalChunks} chunks...`);

    let chunkIndex = 0;
    while (startOffset < fileSize) {
      chunkIndex++;
      const chunk = videoBuffer.slice(startOffset, endOffset);
      const boundary = `COABot${Date.now()}${chunkIndex}`;
      const CRLF = "\r\n";

      const prefixParts = [
        `--${boundary}${CRLF}`,
        `Content-Disposition: form-data; name="access_token"${CRLF}${CRLF}`,
        `${access_token}${CRLF}`,
        `--${boundary}${CRLF}`,
        `Content-Disposition: form-data; name="upload_phase"${CRLF}${CRLF}`,
        `transfer${CRLF}`,
        `--${boundary}${CRLF}`,
        `Content-Disposition: form-data; name="upload_session_id"${CRLF}${CRLF}`,
        `${upload_session_id}${CRLF}`,
        `--${boundary}${CRLF}`,
        `Content-Disposition: form-data; name="start_offset"${CRLF}${CRLF}`,
        `${startOffset}${CRLF}`,
        `--${boundary}${CRLF}`,
        `Content-Disposition: form-data; name="video_file_chunk"; filename="chunk.mp4"${CRLF}`,
        `Content-Type: video/mp4${CRLF}${CRLF}`
      ].join("");

      const prefix = Buffer.from(prefixParts, "utf-8");
      const suffix = Buffer.from(`${CRLF}--${boundary}--${CRLF}`, "utf-8");
      const body = Buffer.concat([prefix, chunk, suffix]);

      const transferRes = await fetch(FB_API, {
        method: "POST",
        headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
        body
      });

      const transferData = await transferRes.json();
      if (transferData.error) {
        throw new Error(`Chunk ${chunkIndex} failed: ${JSON.stringify(transferData.error)}`);
      }

      const progress = ((chunkIndex / totalChunks) * 100).toFixed(0);
      process.stdout.write(`\r ⬆️ Chunk ${chunkIndex}/${totalChunks} (${progress}%) offset: ${startOffset} `);

      startOffset = parseInt(transferData.start_offset);
      endOffset = parseInt(transferData.end_offset);
    }

    console.log(`\n✅ Tất cả ${chunkIndex} chunks đã upload xong!`);

    // ── BƯỚC 4: FINISH - Finalize và publish ─────────────────
    console.log(`\n🏁 Phase 3: Finish & publish...`);
    const finishRes = await fetch(FB_API, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        upload_phase: "finish",
        upload_session_id,
        access_token,
        description: description || ""
      }).toString()
    });

    const finishData = await finishRes.json();
    if (finishData.error) throw new Error(`Finish failed: ${JSON.stringify(finishData.error)}`);

    console.log(`\n🎉 UPLOAD THÀNH CÔNG! Video ID: ${video_id}`);
    console.log(`${"=".repeat(60)}\n`);

    return res.status(200).json({
      success: true,
      video_id,
      watermarked: watermark,
      upload_session_id,
      total_chunks: chunkIndex,
      file_size_mb: (fileSize / 1024 / 1024).toFixed(1),
      fb_response: finishData
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

// Health check
app.get("/health", (_, res) => res.json({ status: "ok", time: new Date().toISOString() }));

app.listen(PORT, "0.0.0.0", () => {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`🚀 Content Automation Server đang chạy!`);
  console.log(`🌐 http://localhost:${PORT}`);
  console.log(`📌 Endpoint 1: POST http://localhost:${PORT}/upload-video`);
  console.log(`📌 Endpoint 2: POST http://localhost:${PORT}/watermark-video`);
  console.log(`${"=".repeat(60)}\n`);
});
