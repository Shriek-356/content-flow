/**
 * Facebook Video Upload Service (Chunked / Resumable upload session)
 */
export async function uploadVideoToFacebook({
  videoBuffer,
  access_token,
  description = "",
  page_id = "me"
}) {
  const target = page_id || "me";
  const FB_API = `https://graph-video.facebook.com/v19.0/${target}/videos`;
  const fileSize = videoBuffer.length;

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

  // ── TRANSFER - Upload từng chunk ─────────────────
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

  // ── FINISH - Finalize và publish ─────────────────
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
  return {
    video_id,
    upload_session_id,
    total_chunks: chunkIndex,
    file_size_mb: (fileSize / 1024 / 1024).toFixed(1),
    fb_response: finishData
  };
}
