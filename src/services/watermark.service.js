import sharp from "sharp";
import ffmpegPath from "ffmpeg-static";
import { exec, spawn } from "child_process";
import util from "util";
import fs from "fs";
import path from "path";

const execPromise = util.promisify(exec);

/**
 * Tạo PNG pattern diagonal bằng Sharp
 * Xếp logo so le dạng kim cương thoáng, tự động cắt viền để không bị xếp chồng
 */
export async function buildDiagonalPattern({
  logoPath,
  canvasW,
  canvasH,
  logoW = 380,
  opacity = 0.12,
  gapX = 180,
  gapY = 220,
}) {
  const meta = await sharp(logoPath).metadata();
  const logoH = Math.round(meta.height / meta.width * logoW);
  const stepX = logoW + gapX;
  const stepY = logoH + gapY;
  const shiftPerRow = Math.round(stepX / 2);
  const alphaVal = Math.round(255 * opacity);

  const { data, info } = await sharp(logoPath)
    .resize(logoW)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const adjusted = Buffer.from(data);
  for (let i = 3; i < adjusted.length; i += 4) {
    adjusted[i] = Math.round(adjusted[i] * alphaVal / 255);
  }

  const logoPngBuf = await sharp(adjusted, {
    raw: { width: info.width, height: info.height, channels: 4 }
  }).png().toBuffer();

  const compositeOps = [];
  const rowStart = -1;
  const rowEnd = Math.ceil(canvasH / stepY) + 1;

  for (let row = rowStart; row <= rowEnd; row++) {
    const y = row * stepY;
    const rowOffset = (row % 2 !== 0) ? -shiftPerRow : 0;

    for (let col = -1; col <= Math.ceil(canvasW / stepX) + 1; col++) {
      const x = col * stepX + rowOffset;

      if (x + logoW > 0 && x < canvasW && y + logoH > 0 && y < canvasH) {
        let extractLeft = 0;
        let extractTop = 0;
        let extractWidth = logoW;
        let extractHeight = logoH;
        let destLeft = x;
        let destTop = y;

        if (x < 0) {
          extractLeft = -x;
          extractWidth = logoW + x;
          destLeft = 0;
        }
        if (x + logoW > canvasW) {
          extractWidth = canvasW - x - extractLeft;
        }
        if (y < 0) {
          extractTop = -y;
          extractHeight = logoH + y;
          destTop = 0;
        }
        if (y + logoH > canvasH) {
          extractHeight = canvasH - y - extractTop;
        }

        if (extractWidth > 0 && extractHeight > 0) {
          const croppedLogo = await sharp(logoPngBuf)
            .extract({ left: extractLeft, top: extractTop, width: extractWidth, height: extractHeight })
            .png()
            .toBuffer();

          compositeOps.push({ input: croppedLogo, left: destLeft, top: destTop });
        }
      }
    }
  }

  const patternBuf = await sharp({
    create: { width: canvasW, height: canvasH, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } }
  })
  .composite(compositeOps)
  .png()
  .toBuffer();

  return patternBuf;
}

/**
 * Chạy FFmpeg bằng spawn an toàn, streaming log tránh tràn buffer bộ nhớ
 */
export function runFFmpegProcess(args) {
  const ffmpegBin = ffmpegPath || "ffmpeg";
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegBin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    proc.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`FFmpeg exited with code ${code}\nStderr: ${stderr.slice(-1500)}`));
    });
    proc.on("error", (err) => reject(err));
  });
}

/**
 * Chèn logo / watermark vào video (Diagonal tiled hoặc Fixed Corner)
 */
export async function applyWatermark(inputBuffer, logoPath, position = "diagonal", logoWidth = 380, opacity = 0.12) {
  const tempDir = path.join(process.cwd(), "tmp");
  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

  const ts = Date.now();
  const tempInput   = path.join(tempDir, `input_${ts}.mp4`);
  const tempOutput  = path.join(tempDir, `output_${ts}.mp4`);
  const tempPattern = path.join(tempDir, `wm_pattern_${ts}.png`);

  await fs.promises.writeFile(tempInput, inputBuffer);

  const posLower = String(position).toLowerCase().trim();

  try {
    // 1. Nhận diện kích thước gốc của video để xác định tỷ lệ
    let srcW = 1080, srcH = 1920;
    try {
      const probeCmd = `"${ffmpegPath || "ffmpeg"}" -i "${tempInput}"`;
      const res = await execPromise(probeCmd).catch(e => ({ stderr: (e.stderr || e.message || "").toString() }));
      const match = (res.stderr || "").match(/Stream #\d+:\d+.*Video:.*?, (\d{2,5})x(\d{2,5})/i);
      if (match) {
        srcW = parseInt(match[1], 10);
        srcH = parseInt(match[2], 10);
      }
    } catch (_) { /* fallback 1080x1920 */ }

    // 2. Chuẩn hóa về 1080p
    let targetW = 1080, targetH = 1920;
    if (srcW > srcH) {
      targetW = 1920; targetH = 1080; // Video ngang (16:9)
    } else if (srcW === srcH) {
      targetW = 1080; targetH = 1080; // Video vuông (1:1)
    }

    console.log(`🎬 [WATERMARK] Gốc: ${srcW}x${srcH} → Chuẩn hóa: ${targetW}x${targetH} | Logo: ${logoWidth}px | Mờ: ${opacity * 100}%`);

    if (
      posLower === "diagonal" ||
      posLower === "tiled"    ||
      posLower === "repeat"   ||
      posLower === "full"     ||
      posLower === "pattern"
    ) {
      // ── CHẾ ĐỘ DIAGONAL ──
      const patternBuf = await buildDiagonalPattern({
        logoPath,
        canvasW: targetW,
        canvasH: targetH,
        logoW: logoWidth,
        opacity,
      });

      await fs.promises.writeFile(tempPattern, patternBuf);

      const scaleAndPad = `scale=w=${targetW}:h=${targetH}:force_original_aspect_ratio=decrease,pad=${targetW}:${targetH}:(ow-iw)/2:(oh-ih)/2`;
      const filter = `[0:v]${scaleAndPad}[scaled];[scaled][1:v]overlay=0:0:shortest=1[outv]`;

      await runFFmpegProcess([
        "-y",
        "-threads", "4",
        "-i", tempInput,
        "-loop", "1",
        "-i", tempPattern,
        "-filter_complex", filter,
        "-map", "[outv]",
        "-map", "0:a?",
        "-c:v", "libx264",
        "-pix_fmt", "yuv420p",
        "-c:a", "copy",
        "-preset", "veryfast",
        "-movflags", "+faststart",
        tempOutput
      ]);

      const outputBuffer = await fs.promises.readFile(tempOutput);
      console.log(`✅ [WATERMARK] Hoàn tất diagonal watermark!`);
      return outputBuffer;

    } else {
      // ── CHẾ ĐỘ GÓC CỐ ĐỊNH ──
      let overlayPos = "W-w-25:25"; // top_right (mặc định)
      if (posLower === "bottom_right") overlayPos = "W-w-25:H-h-25";
      if (posLower === "top_left")     overlayPos = "25:25";
      if (posLower === "bottom_left")  overlayPos = "25:H-h-25";
      if (posLower === "center")       overlayPos = "(W-w)/2:(H-h)/2";

      const scaleAndPad = `scale=w=${targetW}:h=${targetH}:force_original_aspect_ratio=decrease,pad=${targetW}:${targetH}:(ow-iw)/2:(oh-ih)/2`;
      const filter = `[0:v]${scaleAndPad}[scaled];[1:v]format=rgba,colorchannelmixer=aa=${opacity},scale=w=${logoWidth}:h=-1[wm];[scaled][wm]overlay=${overlayPos}:shortest=1[outv]`;

      console.log(`🎬 [WATERMARK] Góc ${posLower} | Logo: ${logoWidth}px | Mờ: ${opacity * 100}%`);
      await runFFmpegProcess([
        "-y",
        "-threads", "4",
        "-i", tempInput,
        "-loop", "1",
        "-i", logoPath,
        "-filter_complex", filter,
        "-map", "[outv]",
        "-map", "0:a?",
        "-c:v", "libx264",
        "-pix_fmt", "yuv420p",
        "-c:a", "copy",
        "-preset", "veryfast",
        "-movflags", "+faststart",
        tempOutput
      ]);

      const outputBuffer = await fs.promises.readFile(tempOutput);
      console.log(`✅ [WATERMARK] Hoàn tất!`);
      return outputBuffer;
    }
  } catch (err) {
    throw new Error(`FFmpeg Watermark Error: ${err.message}`);
  } finally {
    for (const f of [tempInput, tempOutput, tempPattern]) {
      try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch {}
    }
  }
}
