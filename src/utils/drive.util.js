/**
 * Utility: Tải file từ Google Drive (tự động xử lý redirect và trang cảnh báo quét virus với file lớn)
 */
export async function downloadFromGoogleDrive(url) {
  if (!url || typeof url !== "string") {
    throw new Error("Tham số URL tải từ Google Drive không hợp lệ hoặc bị trống");
  }

  let fileId = "";
  const idMatch = url.match(/id=([a-zA-Z0-9_-]{10,})/i) || url.match(/\/d\/([a-zA-Z0-9_-]{10,})/i);
  if (idMatch) fileId = idMatch[1];

  if (!fileId && !url.startsWith("http")) {
    // Nếu truyền thẳng ID thuần
    if (/^[a-zA-Z0-9_-]{10,}$/.test(url.trim())) {
      fileId = url.trim();
    }
  }

  if (!fileId) {
    throw new Error(`Không tìm thấy Google Drive File ID hợp lệ trong link: "${url}". Hãy kiểm tra lại node trước trong n8n xem $json.id đã có dữ liệu chưa.`);
  }

  let targetUrl = `https://drive.usercontent.google.com/download?id=${fileId}&export=download&confirm=t`;

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
