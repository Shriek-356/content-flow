import puppeteer from "puppeteer";
import fs from "fs";
import path from "path";

const TEMPLATES_DIR = path.join(process.cwd(), "templates");
const LOGO_URL = process.env.LOGO_URL || "http://172.28.160.1:3001/assets/logo.png";

const templateCache = {};

export function loadTemplate(contentType) {
  if (templateCache[contentType]) return templateCache[contentType];
  const filePath = path.join(TEMPLATES_DIR, `${contentType}.html`);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Không tìm thấy template cho content_type="${contentType}" tại ${filePath}`);
  }
  const html = fs.readFileSync(filePath, "utf8");
  templateCache[contentType] = html;
  return html;
}

export function fillRepeatBlock(html, markerName, items, fillItemFn) {
  const startTag = `<!--REPEAT_START:${markerName}-->`;
  const endTag = `<!--REPEAT_END:${markerName}-->`;
  const startIdx = html.indexOf(startTag);
  const endIdx = html.indexOf(endTag);
  if (startIdx === -1 || endIdx === -1) return html;

  const filledBlocks = (items || []).map(fillItemFn).join("\n");
  return html.substring(0, startIdx) + filledBlocks + html.substring(endIdx + endTag.length);
}

export function fillScalars(html, fields) {
  let out = html;
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue;
    const re = new RegExp(`__${key}__`, "g");
    out = out.replace(re, String(value));
  }
  return out;
}

export function buildHtmlFromTemplate(payload) {
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

export async function renderHtmlToPngBuffer(html, width = 1200, height = 1200) {
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
