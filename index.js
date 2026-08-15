import "dotenv/config";
import express from "express";
import puppeteer from "puppeteer";


const app = express();
const PORT = process.env.PORT || 3001;

app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));
app.use("/assets", express.static("assets"));
// ============================================================
// POST /render-html
// Render mã HTML/CSS từ Gemini thành ảnh PNG 1200x1200px
// ============================================================
app.post("/render-html", async (req, res) => {
    const { html, width = 1200, height = 1200 } = req.body;
    if (!html) {
        return res.status(400).json({ success: false, message: "Thiếu tham số html" });
    }

    let browser;
    try {
        browser = await puppeteer.launch({
            headless: true,
            args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-gpu"]
        });
        const page = await browser.newPage();
        await page.setViewport({ width: parseInt(width), height: parseInt(height) });
        try {
            await page.setContent(html, { waitUntil: "networkidle0", timeout: 15000 });
        } catch (e) {
            console.warn("⚠️ setContent timeout/lỗi (có thể do font mạng chậm):", e.message);
        }

        // MỚI — ép cứng kích thước html/body khớp đúng viewport, phòng khi HTML
        // của AI quên khai báo hoặc khai báo sai kích thước
        await page.addStyleTag({
            content: `html, body {
                margin: 0 !important;
                padding: 0 !important;
                width: ${parseInt(width)}px !important;
                height: ${parseInt(height)}px !important;
                overflow: hidden !important;
            }`
        });

        const imageBuffer = await page.screenshot({ type: "png" });
        await browser.close();

        res.setHeader("Content-Type", "image/png");
        return res.send(imageBuffer);
    } catch (error) {
        if (browser) await browser.close();
        console.error("❌ Lỗi render HTML sang ảnh PNG:", error);
        return res.status(500).json({ success: false, message: error.message });
    }
});

// ============================================================
// POST /upload-video
// Proxy upload video từ Google Drive lên Facebook
// sử dụng Resumable Upload API (3 phases: start → transfer → finish)
//
// Body JSON:
// {
//   "drive_url"    : "https://drive.google.com/uc?export=download&id=...",
//   "access_token" : "EAAxxxxxxxxx",
//   "description"  : "Caption bài đăng",
//   "page_id"      : "me"   (hoặc Page ID cụ thể)
// }
// ============================================================
app.post("/upload-video", async (req, res) => {
    const { drive_url, access_token, description, page_id } = req.body;

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

    try {
        // ── BƯỚC 1: Tải video từ Google Drive ───────────────────
        // Google Drive trả HTML confirmation page cho file > 25MB
        // → Cần parse confirm token rồi download lại
        console.log(`\n⬇️  Đang tải video từ Google Drive...`);

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

            // Nếu trả về HTML → là trang xác nhận virus scan của Google
            if (contentType.includes("text/html")) {
                console.log(`⚠️  Drive trả HTML (virus-scan warning) → đang bóc link confirm...`);
                const html = await firstRes.text();

                // Bóc link href từ nút "Download anyway"
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
                        headers: { "User-Agent": "Mozilla/5.0" },
                        encoding: null
                    });
                    if (!confirmedRes.ok) throw new Error(`Drive confirmed HTTP ${confirmedRes.status}`);
                    return confirmedRes;
                }
            }

            return firstRes;
        }

        const driveRes = await downloadFromGoogleDrive(drive_url);
        const videoBuffer = Buffer.from(await driveRes.arrayBuffer());
        const fileSize = videoBuffer.length;

        if (fileSize < 1024) {
            // Nhỏ hơn 1KB → không phải video thật
            throw new Error(`File tải về quá nhỏ (${fileSize} bytes) - Drive URL có thể sai hoặc file không public`);
        }

        console.log(`✅ Tải xong: ${(fileSize / 1024 / 1024).toFixed(1)} MB`);

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
        console.log(`\n⬆️  Phase 2: Transfer ${totalChunks} chunks...`);

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
            process.stdout.write(`\r   ⬆️  Chunk ${chunkIndex}/${totalChunks} (${progress}%) offset: ${startOffset}   `);

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
    console.log(`📌 Endpoint: POST http://localhost:${PORT}/upload-video`);
    console.log(`${"=".repeat(60)}\n`);
});
