import fs from "fs";
import path from "path";
import { logger } from "../utils/logger.util.js";
import { BufferService } from "./buffer.service.js";

// =====================================================================
// CẤU HÌNH GOOGLE SHEETS TỪ BIẾN MÔI TRƯỜNG (.ENV)
// =====================================================================
export const getSheetConfig = () => {
  const sheetId = process.env.GOOGLE_SHEET_ID || "1KYfVGeFlAJu-DTN-oHka4ES_iD5Aw_fveZRSt-yeI5E";
  const gid = process.env.GOOGLE_SHEET_GID || "2121812891";
  const sheetName = process.env.GOOGLE_SHEET_NAME || "Content Selector";
  const publishSheetName = process.env.GOOGLE_PUBLISH_SHEET_NAME || "Publish Content";
  const credentialsPath = process.env.GOOGLE_CREDENTIALS_PATH || path.join(process.cwd(), "credentials.json");
  const dataStartRow = parseInt(process.env.GOOGLE_SHEET_DATA_START_ROW || "5", 10);
  const sheetUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/edit#gid=${gid}`;
  const gvizUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:json&gid=${gid}`;

  return {
    sheetId,
    gid,
    sheetName,
    publishSheetName,
    credentialsPath,
    dataStartRow,
    sheetUrl,
    gvizUrl
  };
};

// =====================================================================
// GIỜ SHEET = GIỜ VN (UTC+7). Parse tường minh để server/n8n/browser hiểu giống nhau
// (server VN parse local đúng, nhưng container n8n chạy UTC sẽ lệch 7h nếu parse trần).
// Trả về timestamp ms, hoặc null nếu không parse được (để caller dùng default).
// =====================================================================
export const parseSheetTimeVN = (s) => {
  if (!s) return null;
  const str = String(s).trim();
  if (!str) return null;
  // Đã có zone (Z / +07:00): parse trực tiếp
  if (/([Zz]|[+-]\d{2}:?\d{2})$/.test(str)) {
    const t = new Date(str).getTime();
    return isNaN(t) ? null : t;
  }
  // Giờ Sheet thường thiếu số 0 ("2026-09-10 7:00", thậm chí "2026-9-5 7:00")
  // vì Sheets tự rút gọn hiển thị -> pad tay rồi neo +07:00
  const m = str.match(/^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (m) {
    const pad = (n) => String(n).padStart(2, "0");
    const t = Date.parse(`${m[1]}-${pad(m[2])}-${pad(m[3])}T${pad(m[4])}:${m[5]}:${m[6] || "00"}+07:00`);
    return isNaN(t) ? null : t;
  }
  return null;
};

// =====================================================================
// GOOGLE SHEETS API CLIENT (dùng Service Account)
// =====================================================================
async function getGoogleSheetsClient() {
  const { credentialsPath } = getSheetConfig();
  if (!fs.existsSync(credentialsPath)) {
    throw new Error(
      `❌ Chưa có Google Service Account credentials!\n` +
      `   Vui lòng:\n` +
      `   1. Tạo Service Account tại https://console.cloud.google.com\n` +
      `   2. Enable "Google Sheets API"\n` +
      `   3. Download file JSON → đặt tại: ${credentialsPath}\n` +
      `   4. Share Google Sheet với email service account (Editor)\n` +
      `   5. Thêm vào .env: GOOGLE_CREDENTIALS_PATH=./credentials.json`
    );
  }

  try {
    const { google } = await import("googleapis");
    const auth = new google.auth.GoogleAuth({
      keyFile: credentialsPath,
      scopes: ["https://www.googleapis.com/auth/spreadsheets"]
    });
    const client = await auth.getClient();
    const sheets = google.sheets({ version: "v4", auth: client });
    return sheets;
  } catch (err) {
    throw new Error(`Lỗi khởi tạo Google Sheets API: ${err.message}`);
  }
}


export class SheetsService {
  /**
   * Đọc toàn bộ danh sách bài viết từ Google Sheet (Ưu tiên Google Sheets API, fallback GVIZ)
   */
  static async fetchSheetRows() {
    const { sheetId, sheetName, credentialsPath, dataStartRow, gvizUrl } = getSheetConfig();
    const dataStartIndex = Math.max(0, dataStartRow - 1);

    // 1. Đọc qua Google Sheets API chính thống (khi có credentials.json)
    if (fs.existsSync(credentialsPath)) {
      try {
        const sheets = await getGoogleSheetsClient();
        const res = await sheets.spreadsheets.values.get({
          spreadsheetId: sheetId,
          range: `'${sheetName}'!A1:AS200`
        });
        const rows = res.data.values || [];
        const result = [];

        let lastGoal = "Quảng bá sản phẩm";
        let lastUsp = "";
        let lastChannel = "Facebook";
        let lastInsight = "";
        let lastDrive = "";

        // Dữ liệu bắt đầu từ row index tương ứng với dataStartRow
        for (let i = dataStartIndex; i < rows.length; i++) {
          const c = rows[i] || [];
          const rowNum = i + 1;

          const opt1 = c[22] ? String(c[22]).trim() : "";
          const opt2 = c[23] ? String(c[23]).trim() : "";
          const opt3 = c[24] ? String(c[24]).trim() : "";
          const contentId = c[37] ? String(c[37]).trim() : "";

          // Cập nhật forward-fill khi gặp dòng có dữ liệu định hướng
          if (c[0] && String(c[0]).trim()) lastGoal = String(c[0]).trim();
          if (c[1] && String(c[1]).trim()) lastUsp = String(c[1]).trim();
          if (c[3] && String(c[3]).trim()) lastChannel = String(c[3]).trim();
          if (c[4] && String(c[4]).trim()) lastInsight = String(c[4]).trim();
          if (c[27] && String(c[27]).trim()) lastDrive = String(c[27]).trim();

          // Bỏ qua dòng trống hoàn toàn (không có option nào, không có hook/usp và không có content_id)
          if (!opt1 && !opt2 && !opt3 && !c[1] && !c[2] && !contentId) continue;

          const rowData = {
            row_number: rowNum,
            goal: c[0] ? String(c[0]).trim() : lastGoal,
            usp: c[1] ? String(c[1]).trim() : lastUsp,
            hook: c[2] ? String(c[2]).trim() : "",
            channel: c[3] ? String(c[3]).trim() : lastChannel,
            insight: c[4] ? String(c[4]).trim() : lastInsight,
            business_goal: c[5] ? String(c[5]).trim() : "",
            output_goal: c[6] ? String(c[6]).trim() : "Bài viết",
            content_format: c[7] ? String(c[7]).trim() : "Text trơn",
            content_length: c[8] ? String(c[8]).trim() : "300 từ",
            version_count: c[9] ? String(c[9]).trim() : "3",
            funnel_cold: c[10] ? String(c[10]).trim() : "",
            funnel_warm: c[11] ? String(c[11]).trim() : "",
            funnel_hot: c[12] ? String(c[12]).trim() : "",
            key_message: c[13] ? String(c[13]).trim() : "",
            sub_message: c[14] ? String(c[14]).trim() : "",
            formula: c[15] ? String(c[15]).trim() : "",
            tone: c[16] ? String(c[16]).trim() : "",
            cta: c[17] ? String(c[17]).trim() : "",
            talk_write_ratio: c[18] ? String(c[18]).trim() : "",
            qual_quant_ratio: c[19] ? String(c[19]).trim() : "",
            evidence: c[20] ? String(c[20]).trim() : "",
            custom_prompt: c[21] ? String(c[21]).trim() : "",
            option_1: opt1,
            option_2: opt2,
            option_3: opt3,
            approved_option: (c[25] && String(c[25]).trim()) ? String(c[25]).trim() : "Option 1",
            status: c[26] ? String(c[26]).trim() : "waiting_review",
            drive_folder: c[27] ? String(c[27]).trim() : lastDrive,
            media_to_post: c[28] ? String(c[28]).trim() : (c[27] ? String(c[27]).trim() : lastDrive),
            photo_count: c[29] ? parseInt(c[29]) || 0 : 0,
            image_count: c[29] ? String(c[29]).trim() : "2",
            image_size_standard: c[30] ? String(c[30]).trim() : "",
            typography_heading: c[31] ? String(c[31]).trim() : "",
            typography_subtext: c[32] ? String(c[32]).trim() : "",
            image_rule: c[33] ? String(c[33]).trim() : "",
            image_design_rule: c[34] ? String(c[34]).trim() : "",
            background_rule: c[35] ? String(c[35]).trim() : "",
            footer_badge_rule: c[36] ? String(c[36]).trim() : "",
            scheduled_time: c[42] ? String(c[42]).trim() : "",
            anh_demo: c[31] ? String(c[31]).trim() : "",
            content_id: contentId,
            preset_id: c[38] ? String(c[38]).trim() : "",
            created_at: c[39] ? String(c[39]).trim() : "",
            updated_at: c[40] ? String(c[40]).trim() : "",
            last_error: c[41] ? String(c[41]).trim() : ""
          };

          result.push(rowData);
        }

        return result;
      } catch (apiErr) {
        logger.log(`⚠️ [SHEETS API READ] ${apiErr.message} -> Thử fallback GVIZ...`, "warn");
      }
    }

    // 2. Fallback đọc qua GVIZ public URL
    try {
      const res = await fetch(gvizUrl, { signal: AbortSignal.timeout(8000) });
      const text = await res.text();
      const jsonStr = text.substring(text.indexOf("{"), text.lastIndexOf("}") + 1);
      const data = JSON.parse(jsonStr);

      const rows = data.table.rows || [];
      const result = [];

      for (let i = dataStartIndex; i < rows.length; i++) {
        const c = rows[i]?.c || [];
        const rowNum = i + 1;

        const opt1 = c[22]?.v ? String(c[22].v).trim() : "";
        const opt2 = c[23]?.v ? String(c[23].v).trim() : "";
        const opt3 = c[24]?.v ? String(c[24].v).trim() : "";
        const contentId = c[37]?.v ? String(c[37].v).trim() : "";

        if (!opt1 && !opt2 && !opt3 && !c[1]?.v && !c[4]?.v && !contentId) continue;

        const rowData = {
          row_number: rowNum,
          goal: c[0]?.v ? String(c[0].v).trim() : "Quảng bá sản phẩm",
          usp: c[1]?.v ? String(c[1].v).trim() : "",
          hook: c[2]?.v ? String(c[2].v).trim() : "",
          channel: c[3]?.v ? String(c[3].v).trim() : "Facebook",
          insight: c[4]?.v ? String(c[4].v).trim() : "",
          business_goal: c[5]?.v ? String(c[5].v).trim() : "",
          output_goal: c[6]?.v ? String(c[6].v).trim() : "Bài viết",
          content_format: c[7]?.v ? String(c[7].v).trim() : "Text trơn",
          content_length: c[8]?.v ? String(c[8].v).trim() : "300 từ",
          version_count: c[9]?.v ? String(c[9].v).trim() : "3",
          funnel_cold: c[10]?.v ? String(c[10].v).trim() : "",
          funnel_warm: c[11]?.v ? String(c[11].v).trim() : "",
          funnel_hot: c[12]?.v ? String(c[12].v).trim() : "",
          key_message: c[13]?.v ? String(c[13].v).trim() : "",
          sub_message: c[14]?.v ? String(c[14].v).trim() : "",
          formula: c[15]?.v ? String(c[15].v).trim() : "",
          tone: c[16]?.v ? String(c[16].v).trim() : "",
          cta: c[17]?.v ? String(c[17].v).trim() : "",
          talk_write_ratio: c[18]?.v ? String(c[18].v).trim() : "",
          qual_quant_ratio: c[19]?.v ? String(c[19].v).trim() : "",
          evidence: c[20]?.v ? String(c[20].v).trim() : "",
          custom_prompt: c[21]?.v ? String(c[21].v).trim() : "",
          option_1: opt1,
          option_2: opt2,
          option_3: opt3,
          approved_option: (c[25]?.v && String(c[25].v).trim()) ? String(c[25].v).trim() : "Option 1",
          status: c[26]?.v ? String(c[26].v).trim() : "waiting_review",
          drive_folder: c[27]?.v ? String(c[27].v).trim() : "",
          media_to_post: c[28]?.v ? String(c[28].v).trim() : "",
          photo_count: c[29]?.v ? parseInt(c[29].v) || 0 : 0,
          image_count: c[29]?.v ? String(c[29].v).trim() : "2",
          image_size_standard: c[30]?.v ? String(c[30].v).trim() : "",
          typography_heading: c[31]?.v ? String(c[31].v).trim() : "",
          typography_subtext: c[32]?.v ? String(c[32].v).trim() : "",
          image_rule: c[33]?.v ? String(c[33].v).trim() : "",
          image_design_rule: c[34]?.v ? String(c[34].v).trim() : "",
          background_rule: c[35]?.v ? String(c[35].v).trim() : "",
          footer_badge_rule: c[36]?.v ? String(c[36].v).trim() : "",
          scheduled_time: c[42]?.v ? String(c[42].v).trim() : "",
          anh_demo: c[31]?.v ? String(c[31].v).trim() : "",
          content_id: contentId,
          preset_id: c[38]?.v ? String(c[38].v).trim() : "",
          created_at: c[39]?.v ? String(c[39].v).trim() : "",
          updated_at: c[40]?.v ? String(c[40].v).trim() : "",
          last_error: c[41]?.v ? String(c[41].v).trim() : ""
        };

        result.push(rowData);
      }

      return result;
    } catch (err) {
      logger.log(`❌ Lỗi đọc Google Sheet: ${err.message}`, "error");
      throw err;
    }
  }

  /**
   * Đọc danh sách Content Presets từ tab 'Content Presets'
   */
  static async fetchPresets() {
    const { sheetId, credentialsPath } = getSheetConfig();
    const fallbackPresets = [
      {
        preset_id: "ECOLAR_GA_AI_CAP",
        preset_name: "Gà Ai Cập Vằn Ecolar",
        channel: "TikTok",
        goal: "Quảng bá sản phẩm/dịch vụ",
        usp: "Gà Ai Cập giống thuần chủng, đẻ 250-300 trứng/năm, thịt săn chắc ít mỡ, sức đề kháng cao, dễ nuôi cho hộ gia đình và trang trại nhỏ",
        hook: "",
        insight: "Chân Dung Khách Hàng Mục Tiêu — Gà Ai Cập Vằn\n\n1. Hồ sơ đại diện — Anh T (38 tuổi, ven đô, chuồng trại sẵn có)\n2. Bối cảnh: Muốn tự nuôi lấy trứng sạch hoặc tăng đàn nhỏ\n3. Nỗi đau: Sợ con giống yếu, giá cao, chết trong vận chuyển, tỷ lệ trống nhiều\n4. Mong muốn: Đàn gà khỏe mạnh, đồng đều, đã qua úm, hỗ trợ kỹ thuật rõ ràng\n5. Rào cản: Giá và niềm tin vào nhà cung cấp",
        business_goal: "Tăng nhận diện thương hiệu",
        output_goal: "Bài viết",
        content_format: "Text trơn",
        content_length: "300 từ",
        version_count: "3",
        funnel_cold: "Phá bỏ lầm tưởng",
        funnel_warm: "So sánh & Đánh giá chất lượng giống",
        funnel_hot: "Cam kết bảo hành & Ưu đãi giao tận nơi",
        key_message: "Rẻ hơn vài chục nghìn một con thì lúc mua thấy tiết kiệm thật. Nhưng nếu đổi lại là đàn gà chưa được phòng bệnh đầy đủ, chỉ một lần phát bệnh cũng đủ khiến tiền thuốc và hao hụt vượt xa khoản mình tiết kiệm ban đầu.",
        sub_message: "Ecolar cam kết giống thuần chủng đã qua kiểm dịch và tiêm phòng đầy đủ.",
        formula: "AIDA, PAS, 4P",
        tone: "Chuyên gia",
        cta: "IB ngay",
        talk_write_ratio: "50% Nói - 50% Viết",
        qual_quant_ratio: "80% Định tính - 20% Định lượng",
        evidence: "Tỷ lệ sống >95%, đẻ 250-300 trứng/năm, bảo hành 1 đổi 1 khi vận chuyển",
        custom_prompt: "Tập trung ngôn từ mộc mạc, gần gũi với bà con nhà nông, dẫn chứng thực tế",
        image_count: "2",
        image_size_standard: `TIÊU CHUẨN KÍCH THƯỚC ẢNH:

1 ảnh
- STYLE_1: 1 ảnh 1:1 (1200x1200px)

2 ảnh
- STYLE_2: 2 ảnh 1:1 (1200x1200px mỗi ảnh)

3 ảnh
- STYLE_3: 1 ảnh chính 3:2 (1200x600px) + 2 ảnh phụ 1:1 (1200x1200px mỗi ảnh)
  → Preview mục tiêu: 1 ảnh chính ngang phía trên + 2 ảnh phụ phía dưới.

4 ảnh
- STYLE_4: 4 ảnh 1:1 (1200x1200px mỗi ảnh)

- STYLE_5: 1 ảnh chính 2:3 (800x1200px) + 3 ảnh phụ 1:1 (1200x1200px mỗi ảnh)
  → Preview mục tiêu: 1 ảnh chính dọc bên trái + 3 ảnh phụ xếp bên phải.

- STYLE_6: 1 ảnh chính 3:2 (1200x800px) + 3 ảnh phụ 1:1 (1200x1200px mỗi ảnh)
  → Preview mục tiêu: 1 ảnh chính ngang phía trên + 3 ảnh phụ phía dưới.

LƯU Ý:
- Không dùng kích thước ô preview Facebook làm kích thước ảnh gốc.
- Nội dung quan trọng phải nằm trong safe zone trung tâm để hạn chế bị crop.`,
        typography_heading: `- Vai trò: Headline chỉ làm nhiệm vụ THU HÚT/HOOK — không giải thích, không liệt kê chi tiết (phần đó thuộc về Subtext).
- Headline chính (hook): 24px - weight black - #ffffff - freestyle typo, độ dài: 1-2 câu ngắn, tối đa 2 dòng hiển thị — dài hơn phải scale cỡ chữ xuống theo quy định (24px → 16-18px)
- Có thể thêm headline phụ 12px làm nhãn dẫn dắt - weight black - color #231f20 - đặt trên shape rounded rectangle #bfd730 - shape tự co giãn theo độ dài text
- Văn phong: được phép dùng câu hỏi tu từ, cảm thán, số liệu gây tò mò (VD: "Vì sao...", "⁉️", "!?") — khác với Subtext (không dùng câu hỏi tu từ).
- Vị trí: luôn ở phần trên cùng bố cục, phía trên mọi ảnh/lưới ảnh.
- Font chữ: Nunito_Sans`,
        typography_subtext: `- Vai trò: GIẢI THÍCH/bổ trợ cho Headline — không thu hút, không dùng câu hỏi tu từ (phần đó thuộc về Headline)
- Độ dài:  1-2 dòng ngắn/card, ~35-45 ký tự/dòng — dài hơn thì rút gọn ý, không giảm cỡ chữ để nhồi thêm, 1 khối subtext chỉ truyền tải đúng 1 ý.
- Định dạng: 6px - semi bold - #231f20
- Văn phong: câu ngắn, trực tiếp, mang tính khẳng định/thông tin
(Các key message sẽ highlight weight - black; color font key message: #056823) (tự động tóm tắt ý chính các thông điệp Paragraph cần đưa vào)
- Ngắt dòng: không ngắt giữa cụm từ có nghĩa; line-height tối thiểu 130% cỡ chữ.
- Key message: chỉ highlight 1 cụm/số liệu quan trọng nhất — weight black, color #056823 — ưu tiên số liệu cụ thể hơn tính từ chung chung.
- Tính nhất quán: cùng 1 bài, số dòng và cỡ chữ subtext phải đồng nhất giữa các card/slide - không co giãn tuỳ tiện theo độ dài nội dung từng card.
- Font chữ: Nunito_Sans`,
        image_rule: `- Nguyên tắc chọn ảnh: Ưu tiên tuyệt đối ảnh chụp thực tế là chủ thể chính, ảnh phải đúng trọng tâm nội dung theo brief.
- Dùng ảnh chụp thực tế cho mọi trường hợp: gà, chuồng trại, môi trường nuôi, thao tác chăm sóc, sản phẩm (trứng)...
- Ví dụ đúng: "gà bị stress" → chọn ảnh gà đứng tách đàn, lông xù; "chuồng quá nóng" → chọn ảnh chuồng có ánh nắng gắt.
- Ví dụ sai: Dùng ảnh gà chụp góc đẹp chung chung không thể hiện đúng vấn đề đang nói.
- Lưu ý ảnh AI-generated: Chỉ dùng ảnh AI khi không có ảnh chụp thật phù hợp. Bắt buộc kiểm tra các lỗi AI hay gặp trên gà trước khi bốc chọn: số ngón chân (đúng 4 ngón/chân), mắt (cân đối, không lệch/mờ), mỏ (liền mạch, không gãy khúc), cánh/lông (đúng 2 cánh, không lặp pattern giả), chân (đúng 2 chân, tỉ lệ hợp lý), mào/tích (tự nhiên, không đối xứng giả) và bối cảnh không méo mó.`,
        image_design_rule: `- Bố cục hình ảnh: - Tổng khu vực dành cho toàn bộ ảnh gà thật nên chiếm khoảng 1/3 bố cục slide; nếu có nhiều ảnh, chia sẻ cùng vùng visual này thay vì mỗi ảnh chiếm 1/3. Ảnh chính được đặt trong khung hình bo tròn (circle mask) với viền trắng mờ/glow bao quanh, hòa vào nền xanh bằng hiệu ứng chuyển sắc mềm.
- Layout chừa các khoảng trống an toàn (safe margin) để giao diện dễ thở, không chen chúc quá nhiều nội dung.
- Quy tắc ICON: Chỉ dùng làm yếu tố PHỤ bổ trợ khi cần (không bắt buộc). Chỉ thêm icon khi nội dung có điểm KHÁI NIỆM/PHÂN LOẠI mà ảnh chụp không tự diễn đạt rõ được. Icon đặt bổ sung trong khung tròn nhỏ, KHÔNG chiếm vị trí ảnh chính — luôn đi kèm ảnh thật, không thay thế.`,
        background_rule: `- Màu nền: Gradient #056823 → #bfd730 (xanh đậm → xanh non) — dùng xuyên suốt mọi ảnh, không đổi màu/tông theo chủ đề từng bài.
- Tương phản: đảm bảo chữ trắng (#ffffff) trên nền luôn đủ tương phản để đọc rõ — nếu đặt chữ ở vùng gradient quá sáng (gần lime), cần thêm drop shadow hoặc chuyển màu chữ tối (#231f20) cho phần đó.
- Tính nhất quán: toàn bộ ảnh trong carousel dùng chung 1 tông gradient để đồng bộ khi vuốt qua`,
        footer_badge_rule: `- Hình dạng: Pill bo tròn hai đầu hoàn toàn (fully rounded), tỉ lệ ngang dài — không bo góc vuông, không dùng hình chữ nhật thường.

- Cấu trúc trong badge (từ trái sang phải):
1. Icon tròn viền trắng mỏng, nền cùng màu badge (#056823), bên trong là ống nghe điện thoại màu trắng kèm 2-3 sóng tín hiệu nhỏ phía trên bên phải ống nghe (thể hiện cuộc gọi đang đổ chuông)
2. Số điện thoại "0868 515 668" — font Nunito Sans, weight black, color #ffffff, size 12px

- Màu nền badge: #056823 cố định — không đổi theo tông nền/ảnh phía sau.

- Vị trí: góc dưới của khung ảnh (không che pill tiêu đề hoặc nội dung chính) — cố định vị trí xuyên suốt mọi bài để người xem quen mắt, dễ tìm.

- Kích thước: đủ nhỏ để không lấn át nội dung chính, nhưng số điện thoại phải đọc được rõ trên di động. 

- Tính nhất quán: vị trí, kích thước, màu sắc badge phải giống hệt nhau ở mọi slide trong cùng 1 carousel — không xê dịch hoặc đổi size giữa các slide.`,
        brand_name: "Ecolar",
        product_name: "Gà Ai Cập Vằn"
      }
    ];

    if (!fs.existsSync(credentialsPath)) {
      return fallbackPresets;
    }

    try {
      const sheets = await getGoogleSheetsClient();
      const res = await sheets.spreadsheets.values.get({
        spreadsheetId: sheetId,
        range: `'Content Presets'!A1:AF30`
      });
      const rows = res.data.values || [];
      const presets = [];

      // Dữ liệu bắt đầu từ hàng 4 (hàng 1: tên cột, hàng 2: nhóm, hàng 3: bắt buộc)
      for (let i = 3; i < rows.length; i++) {
        const c = rows[i] || [];
        const presetId = c[0] ? String(c[0]).trim() : "";
        if (!presetId) continue;

        const rawCols = [];
        for (let colIdx = 2; colIdx <= 31; colIdx++) {
          rawCols.push(c[colIdx] !== undefined ? String(c[colIdx]).trim() : "");
        }

        presets.push({
          preset_id: presetId,
          preset_name: c[1] ? String(c[1]).trim() : presetId,
          goal: c[2] ? String(c[2]).trim() : "Quảng bá sản phẩm/dịch vụ",
          usp: c[3] ? String(c[3]).trim() : "",
          hook: c[4] ? String(c[4]).trim() : "",
          channel: c[5] ? String(c[5]).trim() : "Facebook",
          insight: c[6] ? String(c[6]).trim() : "",
          business_goal: c[7] ? String(c[7]).trim() : "Tăng nhận diện thương hiệu",
          output_goal: c[8] ? String(c[8]).trim() : "Bài viết",
          content_format: c[9] ? String(c[9]).trim() : "Text trơn",
          content_length: c[10] ? String(c[10]).trim() : "300 từ",
          version_count: c[11] ? String(c[11]).trim() : "3",
          funnel_cold: c[12] ? String(c[12]).trim() : "",
          funnel_warm: c[13] ? String(c[13]).trim() : "",
          funnel_hot: c[14] ? String(c[14]).trim() : "",
          key_message: c[15] ? String(c[15]).trim() : "",
          sub_message: c[16] ? String(c[16]).trim() : "",
          formula: c[17] ? String(c[17]).trim() : "AIDA, PAS, 4P",
          tone: c[18] ? String(c[18]).trim() : "Chuyên gia",
          cta: c[19] ? String(c[19]).trim() : "IB ngay",
          talk_write_ratio: c[20] ? String(c[20]).trim() : "50% Nói - 50% Viết",
          qual_quant_ratio: c[21] ? String(c[21]).trim() : "80% Định tính - 20% Định lượng",
          evidence: c[22] ? String(c[22]).trim() : "",
          custom_prompt: c[23] ? String(c[23]).trim() : "",
          image_count: c[24] ? String(c[24]).trim() : "2",
          image_size_standard: c[25] ? String(c[25]).trim() : "",
          typography_heading: c[26] ? String(c[26]).trim() : "",
          typography_subtext: c[27] ? String(c[27]).trim() : "",
          image_rule: c[28] ? String(c[28]).trim() : "",
          image_design_rule: c[29] ? String(c[29]).trim() : "",
          background_rule: c[30] ? String(c[30]).trim() : "",
          footer_badge_rule: c[31] ? String(c[31]).trim() : "",
          raw_cols: rawCols,
          brand_name: "Ecolar",
          product_name: c[1] ? String(c[1]).trim() : "Gà Ai Cập"
        });
      }

      return presets.length > 0 ? presets : fallbackPresets;
    } catch (err) {
      logger.log(`⚠️ Lỗi đọc Content Presets: ${err.message}`, "warn");
      return fallbackPresets;
    }
  }

  /**
   * Lấy chi tiết đầy đủ của một dòng cụ thể (hỗ trợ cả số dòng lẫn content_id)
   */
  static async getRowDetail(rowIdentifier) {
    const allRows = await this.fetchSheetRows();
    const idStr = String(rowIdentifier || "").trim().toLowerCase();
    const row = allRows.find(r => 
      String(r.row_number) === idStr || 
      (r.content_id && r.content_id.toLowerCase() === idStr)
    );
    if (!row) {
      throw new Error(`Không tìm thấy bài viết "${rowIdentifier}" trên Google Sheet!`);
    }
    return row;
  }

  /**
   * Tạo bài viết mới dạng bản nháp (Draft) trực tiếp lên Google Sheet
   * Kế thừa trọn vẹn 22 trường định hướng từ Preset và ghi đè các trường mentor chỉnh sửa
   */
  static async createDraftRow(data = {}) {
    const { sheetId, sheetName } = getSheetConfig();
    const sheets = await getGoogleSheetsClient();

    // 1. Lấy thông tin preset
    const presets = await this.fetchPresets();
    const targetPresetId = data.preset_id || "ECOLAR_GA_AI_CAP";
    const preset = presets.find(p => p.preset_id === targetPresetId) || presets[0];

    // 2. Sinh content_id chuẩn: EC-YYYYMMDD-HHMMxxx
    const now = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const dateStr = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
    const timeStr = `${pad(now.getHours())}${pad(now.getMinutes())}${Math.floor(Math.random() * 900 + 100)}`;
    const content_id = `EC-${dateStr}-${timeStr}`;
    const isoNow = now.toISOString();

    // 3. Chuẩn bị mảng 46 cột tương ứng Content Selector (A -> AS)
    const newRow = new Array(46).fill("");

    // Kế thừa 22 cột từ Preset gốc (Col 2 -> Col 23 của Preset tương ứng Col 0 -> Col 21 của Content Selector)
    if (preset.raw_cols && Array.isArray(preset.raw_cols)) {
      for (let i = 0; i < 22; i++) {
        newRow[i] = preset.raw_cols[i] || "";
      }
    } else {
      newRow[0] = preset.goal || "";
      newRow[1] = preset.usp || "";
      newRow[2] = preset.hook || "";
      newRow[3] = preset.channel || "Facebook";
      newRow[4] = preset.insight || "";
      newRow[5] = preset.business_goal || "";
      newRow[6] = preset.output_goal || "Bài viết";
      newRow[7] = preset.content_format || "Text trơn";
      newRow[8] = preset.content_length || "300 từ";
      newRow[9] = preset.version_count || "3";
      newRow[10] = preset.funnel_cold || "";
      newRow[11] = preset.funnel_warm || "";
      newRow[12] = preset.funnel_hot || "";
      newRow[13] = preset.key_message || "";
      newRow[14] = preset.sub_message || "";
      newRow[15] = preset.formula || "AIDA, PAS, 4P";
      newRow[16] = preset.tone || "Chuyên gia";
      newRow[17] = preset.cta || "IB ngay";
      newRow[18] = preset.talk_write_ratio || "50% Nói - 50% Viết";
      newRow[19] = preset.qual_quant_ratio || "80% Định tính - 20% Định lượng";
      newRow[20] = preset.evidence || "";
      newRow[21] = preset.custom_prompt || "";
    }

    // Ghi đè các trường mentor đã chỉnh sửa riêng (nếu có):
    if (data.goal !== undefined && String(data.goal).trim() !== "") newRow[0] = String(data.goal).trim();
    if (data.usp !== undefined && String(data.usp).trim() !== "") newRow[1] = String(data.usp).trim();
    if (data.hook !== undefined) newRow[2] = String(data.hook).trim();
    if (data.channel !== undefined && String(data.channel).trim() !== "") newRow[3] = String(data.channel).trim();
    if (data.insight !== undefined && String(data.insight).trim() !== "") newRow[4] = String(data.insight).trim();
    if (data.business_goal !== undefined && String(data.business_goal).trim() !== "") newRow[5] = String(data.business_goal).trim();
    if (data.output_goal !== undefined && String(data.output_goal).trim() !== "") newRow[6] = String(data.output_goal).trim();
    if (data.content_format !== undefined && String(data.content_format).trim() !== "") newRow[7] = String(data.content_format).trim();
    if (data.content_length !== undefined && String(data.content_length).trim() !== "") newRow[8] = String(data.content_length).trim();
    if (data.version_count !== undefined && String(data.version_count).trim() !== "") newRow[9] = String(data.version_count).trim();
    if (data.funnel_cold !== undefined && String(data.funnel_cold).trim() !== "") newRow[10] = String(data.funnel_cold).trim();
    if (data.funnel_warm !== undefined && String(data.funnel_warm).trim() !== "") newRow[11] = String(data.funnel_warm).trim();
    if (data.funnel_hot !== undefined && String(data.funnel_hot).trim() !== "") newRow[12] = String(data.funnel_hot).trim();
    if (data.key_message !== undefined && String(data.key_message).trim() !== "") newRow[13] = String(data.key_message).trim();
    if (data.sub_message !== undefined && String(data.sub_message).trim() !== "") newRow[14] = String(data.sub_message).trim();
    if (data.formula !== undefined && String(data.formula).trim() !== "") newRow[15] = String(data.formula).trim();
    if (data.tone !== undefined && String(data.tone).trim() !== "") newRow[16] = String(data.tone).trim();
    if (data.cta !== undefined && String(data.cta).trim() !== "") newRow[17] = String(data.cta).trim();
    if (data.talk_write_ratio !== undefined && String(data.talk_write_ratio).trim() !== "") newRow[18] = String(data.talk_write_ratio).trim();
    if (data.qual_quant_ratio !== undefined && String(data.qual_quant_ratio).trim() !== "") newRow[19] = String(data.qual_quant_ratio).trim();
    if (data.evidence !== undefined && String(data.evidence).trim() !== "") newRow[20] = String(data.evidence).trim();
    if (data.custom_prompt !== undefined && String(data.custom_prompt).trim() !== "") newRow[21] = String(data.custom_prompt).trim();

    // Cột AD..AK (29..36): 8 trường hình ảnh & thiết kế từ Preset
    newRow[29] = (data.image_count !== undefined && String(data.image_count).trim() !== "")
      ? String(data.image_count).trim()
      : (data.photo_count !== undefined && String(data.photo_count).trim() !== "" ? String(data.photo_count).trim() : (preset.image_count || "2"));
    newRow[30] = (data.image_size_standard !== undefined && String(data.image_size_standard).trim() !== "")
      ? String(data.image_size_standard).trim()
      : (preset.image_size_standard || "");
    newRow[31] = (data.typography_heading !== undefined && String(data.typography_heading).trim() !== "")
      ? String(data.typography_heading).trim()
      : (preset.typography_heading || "");
    newRow[32] = (data.typography_subtext !== undefined && String(data.typography_subtext).trim() !== "")
      ? String(data.typography_subtext).trim()
      : (preset.typography_subtext || "");
    newRow[33] = (data.image_rule !== undefined && String(data.image_rule).trim() !== "")
      ? String(data.image_rule).trim()
      : (preset.image_rule || "");
    newRow[34] = (data.image_design_rule !== undefined && String(data.image_design_rule).trim() !== "")
      ? String(data.image_design_rule).trim()
      : (preset.image_design_rule || "");
    newRow[35] = (data.background_rule !== undefined && String(data.background_rule).trim() !== "")
      ? String(data.background_rule).trim()
      : (preset.background_rule || "");
    newRow[36] = (data.footer_badge_rule !== undefined && String(data.footer_badge_rule).trim() !== "")
      ? String(data.footer_badge_rule).trim()
      : (preset.footer_badge_rule || "");

    // Cột W, X, Y (22, 23, 24): 3 phương án content
    if (data.option_1 !== undefined && String(data.option_1).trim() !== "") newRow[22] = String(data.option_1).trim();
    if (data.option_2 !== undefined && String(data.option_2).trim() !== "") newRow[23] = String(data.option_2).trim();
    if (data.option_3 !== undefined && String(data.option_3).trim() !== "") newRow[24] = String(data.option_3).trim();

    // Cột AB, AC (27, 28): Kho Drive và Media đăng
    if (data.drive_folder !== undefined && String(data.drive_folder).trim() !== "") newRow[27] = String(data.drive_folder).trim();
    if (data.media_to_post !== undefined && String(data.media_to_post).trim() !== "") newRow[28] = String(data.media_to_post).trim();

    // Các cột điều khiển hệ thống
    // AQ: Thời Gian Đăng — nhận cả scheduled_time (chuẩn) lẫn planned_date (form tạo mới),
    // để giờ user chọn được ghi thẳng lên Sheet thay vì chỉ hiện trên giao diện.
    const schedInput = [data.scheduled_time, data.planned_date].find(
      (v) => v !== undefined && String(v).trim() !== ""
    );
    if (schedInput) {
      newRow[42] = String(schedInput).trim();
    }
    if (data.buffer_post_id !== undefined && String(data.buffer_post_id).trim() !== "") {
      newRow[43] = String(data.buffer_post_id).trim(); // AR: buffer_post_id
    }
    if (data.live_post_url !== undefined && String(data.live_post_url).trim() !== "") {
      newRow[44] = String(data.live_post_url).trim(); // AS: live_post_url
    }
    newRow[25] = data.approved_option || "Option 1"; // Z: approved_option (Mặc định Option 1)
    newRow[26] = data.status || "draft";           // AA: status
    newRow[37] = content_id;        // AL: content_id
    newRow[38] = preset.preset_id || targetPresetId; // AM: preset_id
    newRow[39] = isoNow;            // AN: created_at
    newRow[40] = isoNow;            // AO: updated_at
    newRow[41] = "";                // AP: last_error

    // 4. Ghi dòng mới tại vị trí xác định (KHÔNG dùng append):
    // append wedges giá trị sai cột (vd AQ38:AS38) khi vùng dữ liệu Sheet bị phân mảnh,
    // khiến parse row_number thất bại (row 0 -> webhook tạo nhầm Bai_Viet_Row_0).
    const gridRes = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: `'${sheetName}'!A1:AS1000`
    });
    const grid = gridRes.data.values || [];
    let rowNumber = 5; // không bao giờ ghi đè 4 dòng header
    for (let i = grid.length - 1; i >= 0; i--) {
      if ((grid[i] || []).some((v) => String(v ?? "").trim() !== "")) {
        rowNumber = i + 2;
        break;
      }
    }

    await sheets.spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: `'${sheetName}'!A${rowNumber}:AS${rowNumber}`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [newRow.slice(0, 45)] }
    });

    logger.log(`✅ [SHEETS SERVICE] Tạo bản nháp thành công: ${content_id} (Dòng #${rowNumber})`, "success");

    return {
      success: true,
      content_id,
      row_number: rowNumber,
      status: newRow[26] || "draft",
      preset_id: targetPresetId,
      channel: data.channel || preset.channel || "Facebook",
      goal: data.goal || preset.goal || "Quảng bá sản phẩm/dịch vụ",
      hook: data.hook || "",
      option_1: newRow[22] || "",
      option_2: newRow[23] || "",
      option_3: newRow[24] || "",
      approved_option: newRow[25] || "Option 1",
      scheduled_time: newRow[42] || "",
      drive_folder: newRow[27] || "",
      media_to_post: newRow[28] || "",
      buffer_post_id: newRow[43] || "",
      live_post_url: newRow[44] || "",
      image_count: newRow[29],
      image_size_standard: newRow[30],
      typography_heading: newRow[31],
      typography_subtext: newRow[32],
      image_rule: newRow[33],
      image_design_rule: newRow[34],
      background_rule: newRow[35],
      footer_badge_rule: newRow[36]
    };
  }

  /**
   * Xóa bản ghi bài viết khỏi Google Sheet (dùng deleteDimension)
   * @param {string|number} rowIdentifier - Số dòng hoặc content_id
   */
  static async deleteRow(rowIdentifier) {
    const { sheetId, gid } = getSheetConfig();
    const sheets = await getGoogleSheetsClient();

    let targetRowNum = parseInt(rowIdentifier, 10);
    if (isNaN(targetRowNum)) {
      const row = await this.getRowDetail(rowIdentifier);
      targetRowNum = row.row_number;
    }

    if (!targetRowNum || targetRowNum < 1) {
      throw new Error(`Số dòng không hợp lệ: ${rowIdentifier}`);
    }

    const numericGid = parseInt(gid, 10) || 1045940223;

    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: sheetId,
      resource: {
        requests: [
          {
            deleteDimension: {
              range: {
                sheetId: numericGid,
                dimension: "ROWS",
                startIndex: targetRowNum - 1,
                endIndex: targetRowNum
              }
            }
          }
        ]
      }
    });


    logger.log(`🗑️ [GOOGLE SHEET API] Đã xóa thành công Dòng #${targetRowNum} khỏi Google Sheet`, "success");
    return { success: true, row_number: targetRowNum };
  }

  /**
   * Ghi thực sự lên Google Sheet (dùng Sheets API) + lưu override local
   * @param {number} rowNumber - Số dòng trên Sheet (1-indexed, row 5 = index 4 = rowNumber 5)
   * @param {object} updates - { approved_option, status, ... }
   */
  static async updateRow(rowNumber, updates) {
    const { sheetId, sheetName } = getSheetConfig();

    // Chuẩn hóa alias: form tạo mới gửi planned_date -> map sang scheduled_time (cột AQ)
    if (updates.scheduled_time === undefined && updates.planned_date !== undefined) {
      updates.scheduled_time = updates.planned_date;
    }

    logger.log(
      `📝 [LƯU DỮ LIỆU REALTIME] Dòng ${rowNumber}: ` +
      `${updates.channel ? `Kênh: ${updates.channel} | ` : ""}` +
      `${updates.status ? `Trạng thái: ${updates.status} | ` : ""}` +
      `${updates.scheduled_time ? `Giờ đăng: ${updates.scheduled_time} | ` : ""}` +
      `${updates.approved_option ? `Duyệt: ${updates.approved_option}` : "Cập nhật thông tin"}`,
      "info"
    );

    // 2. Ghi lên Google Sheet API thực sự
    const writeResult = { local: true, api: false };
    try {
      const sheets = await getGoogleSheetsClient();
      const dataToWrite = [];

      // A1 Mapping theo đúng cấu trúc 22 cột định hướng của Sheet
      if (updates.goal !== undefined) dataToWrite.push({ range: `${sheetName}!A${rowNumber}`, values: [[updates.goal]] });
      if (updates.usp !== undefined) dataToWrite.push({ range: `${sheetName}!B${rowNumber}`, values: [[updates.usp]] });
      if (updates.hook !== undefined) dataToWrite.push({ range: `${sheetName}!C${rowNumber}`, values: [[updates.hook]] });
      if (updates.channel !== undefined) dataToWrite.push({ range: `${sheetName}!D${rowNumber}`, values: [[updates.channel]] });
      if (updates.insight !== undefined) dataToWrite.push({ range: `${sheetName}!E${rowNumber}`, values: [[updates.insight]] });
      if (updates.business_goal !== undefined) dataToWrite.push({ range: `${sheetName}!F${rowNumber}`, values: [[updates.business_goal]] });
      if (updates.output_goal !== undefined) dataToWrite.push({ range: `${sheetName}!G${rowNumber}`, values: [[updates.output_goal]] });
      if (updates.content_format !== undefined) dataToWrite.push({ range: `${sheetName}!H${rowNumber}`, values: [[updates.content_format]] });
      if (updates.content_length !== undefined) dataToWrite.push({ range: `${sheetName}!I${rowNumber}`, values: [[updates.content_length]] });
      if (updates.version_count !== undefined) dataToWrite.push({ range: `${sheetName}!J${rowNumber}`, values: [[updates.version_count]] });
      if (updates.funnel_cold !== undefined) dataToWrite.push({ range: `${sheetName}!K${rowNumber}`, values: [[updates.funnel_cold]] });
      if (updates.funnel_warm !== undefined) dataToWrite.push({ range: `${sheetName}!L${rowNumber}`, values: [[updates.funnel_warm]] });
      if (updates.funnel_hot !== undefined) dataToWrite.push({ range: `${sheetName}!M${rowNumber}`, values: [[updates.funnel_hot]] });
      if (updates.key_message !== undefined) dataToWrite.push({ range: `${sheetName}!N${rowNumber}`, values: [[updates.key_message]] });
      if (updates.sub_message !== undefined) dataToWrite.push({ range: `${sheetName}!O${rowNumber}`, values: [[updates.sub_message]] });
      if (updates.formula !== undefined) dataToWrite.push({ range: `${sheetName}!P${rowNumber}`, values: [[updates.formula]] });
      if (updates.tone !== undefined) dataToWrite.push({ range: `${sheetName}!Q${rowNumber}`, values: [[updates.tone]] });
      if (updates.cta !== undefined) dataToWrite.push({ range: `${sheetName}!R${rowNumber}`, values: [[updates.cta]] });
      if (updates.talk_write_ratio !== undefined) dataToWrite.push({ range: `${sheetName}!S${rowNumber}`, values: [[updates.talk_write_ratio]] });
      if (updates.qual_quant_ratio !== undefined) dataToWrite.push({ range: `${sheetName}!T${rowNumber}`, values: [[updates.qual_quant_ratio]] });
      if (updates.evidence !== undefined) dataToWrite.push({ range: `${sheetName}!U${rowNumber}`, values: [[updates.evidence]] });
      if (updates.custom_prompt !== undefined) dataToWrite.push({ range: `${sheetName}!V${rowNumber}`, values: [[updates.custom_prompt]] });
      if (updates.option_1 !== undefined) dataToWrite.push({ range: `${sheetName}!W${rowNumber}`, values: [[updates.option_1]] });
      if (updates.option_2 !== undefined) dataToWrite.push({ range: `${sheetName}!X${rowNumber}`, values: [[updates.option_2]] });
      if (updates.option_3 !== undefined) dataToWrite.push({ range: `${sheetName}!Y${rowNumber}`, values: [[updates.option_3]] });
      if (updates.approved_option !== undefined) dataToWrite.push({ range: `${sheetName}!Z${rowNumber}`, values: [[updates.approved_option]] });
      if (updates.status !== undefined) dataToWrite.push({ range: `${sheetName}!AA${rowNumber}`, values: [[updates.status]] });
      if (updates.drive_folder !== undefined) dataToWrite.push({ range: `${sheetName}!AB${rowNumber}`, values: [[updates.drive_folder]] });
      if (updates.media_to_post !== undefined) dataToWrite.push({ range: `${sheetName}!AC${rowNumber}`, values: [[updates.media_to_post]] });
      
      // 8 Cột Hình ảnh & Thiết kế đồ họa (AD..AK tương ứng Col 29..36)
      if (updates.image_count !== undefined) dataToWrite.push({ range: `${sheetName}!AD${rowNumber}`, values: [[updates.image_count]] });
      else if (updates.photo_count !== undefined) dataToWrite.push({ range: `${sheetName}!AD${rowNumber}`, values: [[updates.photo_count]] });
      if (updates.image_size_standard !== undefined) dataToWrite.push({ range: `${sheetName}!AE${rowNumber}`, values: [[updates.image_size_standard]] });
      if (updates.typography_heading !== undefined) dataToWrite.push({ range: `${sheetName}!AF${rowNumber}`, values: [[updates.typography_heading]] });
      if (updates.typography_subtext !== undefined) dataToWrite.push({ range: `${sheetName}!AG${rowNumber}`, values: [[updates.typography_subtext]] });
      if (updates.image_rule !== undefined) dataToWrite.push({ range: `${sheetName}!AH${rowNumber}`, values: [[updates.image_rule]] });
      if (updates.image_design_rule !== undefined) dataToWrite.push({ range: `${sheetName}!AI${rowNumber}`, values: [[updates.image_design_rule]] });
      if (updates.background_rule !== undefined) dataToWrite.push({ range: `${sheetName}!AJ${rowNumber}`, values: [[updates.background_rule]] });
      if (updates.footer_badge_rule !== undefined) dataToWrite.push({ range: `${sheetName}!AK${rowNumber}`, values: [[updates.footer_badge_rule]] });

      if (updates.scheduled_time !== undefined) dataToWrite.push({ range: `${sheetName}!AQ${rowNumber}`, values: [[updates.scheduled_time]] });
      if (updates.content_id !== undefined) dataToWrite.push({ range: `${sheetName}!AL${rowNumber}`, values: [[updates.content_id]] });
      if (updates.preset_id !== undefined) dataToWrite.push({ range: `${sheetName}!AM${rowNumber}`, values: [[updates.preset_id]] });
      if (updates.last_error !== undefined) dataToWrite.push({ range: `${sheetName}!AP${rowNumber}`, values: [[updates.last_error]] });
      // Luôn tự cập nhật updated_at
      dataToWrite.push({ range: `${sheetName}!AO${rowNumber}`, values: [[new Date().toISOString()]] });

      if (dataToWrite.length > 0) {
        await sheets.spreadsheets.values.batchUpdate({
          spreadsheetId: sheetId,
          resource: {
            valueInputOption: "USER_ENTERED",
            data: dataToWrite
          }
        });
        writeResult.api = true;
        const colList = dataToWrite.map(d => d.range.split("!")[1]).join(", ");
        logger.log(`💾 [GOOGLE SHEET API] Đồng bộ realtime thành công ${dataToWrite.length} ô lên Google Sheet Dòng #${rowNumber} (${colList})`, "success");
      }
    } catch (err) {
      writeResult.api_error = err.message.split("\n")[0];
      logger.log(`⚠️ [SHEET API] Lỗi ghi Google Sheet: ${err.message.split("\n")[0]}`, "warn");
    }

    return { ...updates, _write: writeResult };
  }

  /**
   * Hẹn giờ đăng hàng loạt: ghi cột AQ (+AO) cho nhiều dòng trong 1 batchUpdate duy nhất.
   * @param {Array<{row_number:number, scheduled_time:string}>} items
   */
  static async scheduleBatch(items = []) {
    const { sheetId, sheetName } = getSheetConfig();
    const clean = (Array.isArray(items) ? items : [])
      .map((it) => ({
        row_number: parseInt(it?.row_number, 10),
        scheduled_time: it?.scheduled_time ? String(it.scheduled_time).trim() : ""
      }))
      .filter((it) => Number.isInteger(it.row_number) && it.row_number > 0 && it.scheduled_time);

    if (clean.length === 0) {
      throw new Error("Danh sách hẹn giờ trống hoặc không hợp lệ!");
    }
    if (clean.length > 100) {
      throw new Error("Tối đa 100 dòng mỗi lần hẹn giờ hàng loạt!");
    }

    const sheets = await getGoogleSheetsClient();
    const nowIso = new Date().toISOString();
    const data = [];
    for (const it of clean) {
      data.push({ range: `${sheetName}!AQ${it.row_number}`, values: [[it.scheduled_time]] });
      data.push({ range: `${sheetName}!AO${it.row_number}`, values: [[nowIso]] });
    }

    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: sheetId,
      resource: { valueInputOption: "USER_ENTERED", data }
    });

    logger.log(`🕒 [GOOGLE SHEET API] Đã hẹn giờ đăng cho ${clean.length} dòng (cột AQ) trong 1 batch`, "success");
    return { success: true, count: clean.length, items: clean };
  }

  /**
   * Duyệt hàng loạt: chốt Option (cột Z) + trạng thái (cột AA) cho nhiều dòng trong 1 batchUpdate.
   * approved_option có thể null (giữ nguyên) — khi đó chỉ đổi status.
   * @param {Array<{row_number:number, approved_option?:string|null, status?:string|null}>} items
   */
  static async approveBatch(items = []) {
    const { sheetId, sheetName } = getSheetConfig();
    const clean = (Array.isArray(items) ? items : [])
      .map((it) => ({
        row_number: parseInt(it?.row_number, 10),
        approved_option: it?.approved_option ? String(it.approved_option).trim() : null,
        status: it?.status ? String(it.status).trim() : null
      }))
      .filter((it) => Number.isInteger(it.row_number) && it.row_number > 0 && (it.approved_option || it.status));

    if (clean.length === 0) {
      throw new Error("Danh sách duyệt trống hoặc không hợp lệ!");
    }
    if (clean.length > 100) {
      throw new Error("Tối đa 100 dòng mỗi lần duyệt hàng loạt!");
    }

    const sheets = await getGoogleSheetsClient();
    const nowIso = new Date().toISOString();
    const data = [];
    for (const it of clean) {
      if (it.approved_option) data.push({ range: `${sheetName}!Z${it.row_number}`, values: [[it.approved_option]] });
      if (it.status) data.push({ range: `${sheetName}!AA${it.row_number}`, values: [[it.status]] });
      data.push({ range: `${sheetName}!AO${it.row_number}`, values: [[nowIso]] });
    }

    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: sheetId,
      resource: { valueInputOption: "USER_ENTERED", data }
    });

    logger.log(`✅ [GOOGLE SHEET API] Đã duyệt ${clean.length} dòng (cột Z/AA) trong 1 batch`, "success");
    return { success: true, count: clean.length, items: clean };
  }

  /**
   * Đổi kênh hàng loạt: ghi cột D cho nhiều dòng trong 1 batchUpdate duy nhất.
   * @param {Array<{row_number:number, channel:string}>} items
   */
  static async channelBatch(items = []) {
    const { sheetId, sheetName } = getSheetConfig();
    const clean = (Array.isArray(items) ? items : [])
      .map((it) => ({
        row_number: parseInt(it?.row_number, 10),
        channel: it?.channel ? String(it.channel).trim() : ""
      }))
      .filter((it) => Number.isInteger(it.row_number) && it.row_number > 0 && it.channel);

    if (clean.length === 0) {
      throw new Error("Danh sách đổi kênh trống hoặc không hợp lệ!");
    }
    if (clean.length > 100) {
      throw new Error("Tối đa 100 dòng mỗi lần đổi kênh!");
    }

    const sheets = await getGoogleSheetsClient();
    const nowIso = new Date().toISOString();
    const data = [];
    for (const it of clean) {
      data.push({ range: `${sheetName}!D${it.row_number}`, values: [[it.channel]] });
      data.push({ range: `${sheetName}!AO${it.row_number}`, values: [[nowIso]] });
    }

    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: sheetId,
      resource: { valueInputOption: "USER_ENTERED", data }
    });

    logger.log(`✅ [GOOGLE SHEET API] Đã đổi kênh ${clean.length} dòng (cột D) trong 1 batch`, "success");
    return { success: true, count: clean.length, items: clean };
  }

  /**
   * Duyệt và bắn ngay bài viết từ Sheet sang Buffer
   */
  static async publishRowToBuffer({ rowNumber, optionChoice = "Option 1", saveToDraft = false, dueAt = null }) {
    const allRows = await this.fetchSheetRows();
    const row = allRows.find((r) => r.row_number === parseInt(rowNumber));

    if (!row) {
      throw new Error(`Không tìm thấy dòng ${rowNumber} trên Google Sheet!`);
    }

    let caption = "";
    if (optionChoice === "Option 1") caption = row.option_1;
    else if (optionChoice === "Option 2") caption = row.option_2;
    else if (optionChoice === "Option 3") caption = row.option_3;
    else caption = row.option_1 || row.option_2 || row.option_3;

    if (!caption) {
      throw new Error(`Nội dung ${optionChoice} của dòng ${rowNumber} đang bị trống!`);
    }

    // Thời gian đăng: ưu tiên tham số dueAt > scheduled_time trong Sheet
    const targetDueAt = dueAt || row.scheduled_time || null;

    // Giờ Sheet là giờ VN. Buffer từ chối giờ quá khứ nên chặn sớm với thông báo rõ ràng
    // (thay vì lỗi cryptic từ Buffer mà user không thấy).
    if (targetDueAt) {
      const t = parseSheetTimeVN(targetDueAt);
      if (t !== null && t <= Date.now()) {
        throw new Error(`Giờ đăng "${targetDueAt}" đã qua — vui lòng đặt giờ mới trong tương lai (cột AQ) rồi đăng lại!`);
      }
    }

    // Ưu tiên: media_to_post → anh_demo → drive_folder
    const mediaUrl = row.media_to_post || row.anh_demo || row.drive_folder;
    const channelLower = (row.channel || "facebook").toLowerCase();

    let targetChannel = "facebook_page";
    if (channelLower.includes("group") || channelLower.includes("nhóm")) {
      targetChannel = "facebook_group";
    } else if (channelLower.includes("tiktok")) {
      targetChannel = "tiktok";
    }

    logger.log(`\n${"=".repeat(60)}`, "info");
    logger.log(`🚀 [SHEET CMS] Bắt đầu duyệt & bắn Buffer — Dòng ${rowNumber}`, "info");
    logger.log(`📌 Kênh: ${targetChannel.toUpperCase()} | Lựa chọn: ${optionChoice} | Giờ đăng: ${targetDueAt || "Không hẹn giờ"}`, "info");

    // Cập nhật Sheet (write-back thực sự)
    await this.updateRow(rowNumber, {
      approved_option: optionChoice,
      status: "publish",
      ...(targetDueAt ? { scheduled_time: targetDueAt } : {})
    });

    // Gọi backend nội bộ để upload
    const host = "127.0.0.1:3001";
    let endpoint = "";
    let body = {};
    const isFolder = mediaUrl && (mediaUrl.includes("/folders/") || mediaUrl.includes("folders"));

    if (targetChannel === "tiktok") {
      endpoint = isFolder ? "/upload-tiktok-photo" : "/upload-tiktok-video";
      body = isFolder
        ? { image_urls: [mediaUrl], fullMessage: caption, save_to_draft: saveToDraft, due_at: targetDueAt, row_number: rowNumber }
        : { drive_url: mediaUrl, fullMessage: caption, watermark: true, save_to_draft: saveToDraft, due_at: targetDueAt, scheduling_type: "automatic", row_number: rowNumber };
    } else if (targetChannel === "facebook_page") {
      endpoint = isFolder ? "/upload-fb-page-photo" : "/upload-fb-page-video";
      body = isFolder
        ? { image_urls: [mediaUrl], fullMessage: caption, save_to_draft: saveToDraft, due_at: targetDueAt, row_number: rowNumber }
        : { drive_url: mediaUrl, fullMessage: caption, watermark: true, save_to_draft: saveToDraft, due_at: targetDueAt, row_number: rowNumber };
    } else {
      endpoint = isFolder ? "/upload-fb-group-photo" : "/upload-fb-group-video";
      body = isFolder
        ? { image_urls: [mediaUrl], fullMessage: caption, save_to_draft: saveToDraft, due_at: targetDueAt, row_number: rowNumber }
        : { drive_url: mediaUrl, fullMessage: caption, watermark: true, save_to_draft: saveToDraft, due_at: targetDueAt, row_number: rowNumber };
    }

    if (mediaUrl) {
      logger.log(`📡 Đang gọi ${endpoint} để xử lý media và đẩy Buffer...`, "info");
      const res = await fetch(`http://${host}${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      const data = await res.json();
      if (!data.success) {
        throw new Error(data.error || "Lỗi khi đẩy bài qua Buffer");
      }
      if (data.post_id) {
        try {
          await this.updateRow(rowNumber, {
            status: saveToDraft ? "draft" : "scheduled"
          });
        } catch (e) {
          logger.log(`⚠️ Lỗi cập nhật status dòng #${rowNumber}: ${e.message}`, "warn");
        }
      }
      logger.log(`🎉 [SHEET CMS] Hoàn tất! Post ID: ${data.post_id}`, "success");
      return { success: true, post_id: data.post_id, data };
    } else {
      logger.log(`⚠️ Bài không có Media URL, đã cập nhật trạng thái duyệt thành công trên Sheet.`, "warn");
      return { success: true, message: "Đã cập nhật trạng thái duyệt thành công!" };
    }
  }

  /**
   * Lấy danh sách thumbnail ảnh từ Google Drive Folder (public)
   */
  static extractDriveFileId(url) {
    if (!url) return null;
    const patterns = [
      /\/folders\/([a-zA-Z0-9_-]{10,})/,
      /[?&]id=([a-zA-Z0-9_-]{10,})/,
      /\/d\/([a-zA-Z0-9_-]{10,})/,
      /\/file\/d\/([a-zA-Z0-9_-]{10,})/
    ];
    for (const pattern of patterns) {
      const m = url.match(pattern);
      if (m) return m[1];
    }
    if (/^[a-zA-Z0-9_-]{10,}$/.test(url.trim())) return url.trim();
    return null;
  }

  static getDriveThumbnailUrl(fileId, size = "w400-h300-c") {
    return `https://drive.google.com/thumbnail?id=${fileId}&sz=${size}`;
  }

  /**
   * List files trong folder (dùng Google Drive API public listing qua GDrive share URL)
   * Không cần auth — chỉ hoạt động với folder được Share "Anyone with the link"
   */
  static async listFolderImages(folderUrl) {
    const folderId = this.extractDriveFileId(folderUrl);
    if (!folderId) throw new Error("Không tìm thấy Folder ID trong URL: " + folderUrl);

    // Sử dụng Google Drive folder listing API (public)
    const listUrl = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(`'${folderId}' in parents and mimeType contains 'image/'`)}&fields=files(id,name,mimeType,size)&key=${process.env.GOOGLE_API_KEY || ""}`;

    if (process.env.GOOGLE_API_KEY) {
      try {
        const res = await fetch(listUrl, { signal: AbortSignal.timeout(5000) });
        const data = await res.json();
        if (data.files) {
          return data.files
            .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
            .map(f => ({
              id: f.id,
              name: f.name,
              thumbnail: this.getDriveThumbnailUrl(f.id),
              view_url: `https://drive.google.com/file/d/${f.id}/view`
            }));
        }
      } catch (_) {}
    }

    // Fallback: trả về thumbnail của folder chính (vì không có API key hoặc bị rate limit)
    return [{
      id: folderId,
      name: "Folder ảnh",
      thumbnail: this.getDriveThumbnailUrl(folderId),
      view_url: folderUrl,
      is_folder: true
    }];
  }

  /**
   * Đọc danh sách bài viết đã xuất bản từ tab riêng biệt 'Publish Content'
   * Tách biệt hoàn toàn với phôi nội dung (Content Selector)
   */
  static async fetchPublishedPosts() {
    const { sheetId, publishSheetName, credentialsPath } = getSheetConfig();

    if (!fs.existsSync(credentialsPath)) {
      return [];
    }

    try {
      const sheets = await getGoogleSheetsClient();
      const res = await sheets.spreadsheets.values.get({
        spreadsheetId: sheetId,
        range: `'${publishSheetName}'!A2:I500`
      });
      const rows = res.data.values || [];
      const posts = [];

      for (let i = 0; i < rows.length; i++) {
        const c = rows[i] || [];
        const bufferPostId = c[0] ? String(c[0]).trim() : "";
        const liveUrl = c[1] ? String(c[1]).trim() : "";
        const channel = c[2] ? String(c[2]).trim() : "Facebook";
        const title = c[3] ? String(c[3]).trim() : "";
        const caption = c[4] ? String(c[4]).trim() : "";
        const publishedAt = c[5] ? String(c[5]).trim() : "";
        const sourceRow = c[6] ? String(c[6]).trim() : "";
        const status = c[7] ? String(c[7]).trim() : "sent";
        const mediaUrls = c[8] ? String(c[8]).trim() : "";

        if (!bufferPostId && !liveUrl && !caption) continue;

        const liveLower = liveUrl.toLowerCase();
        const channelLower = channel.toLowerCase();

        let platform = "facebook_page";
        let channelName = channel;
        let channelId = process.env.BUFFER_FB_PAGE_CHANNEL_ID || "";

        if (liveLower.includes("tiktok.com") || channelLower.includes("tiktok")) {
          platform = "tiktok";
          channelName = channel || "gaaicap2";
          channelId = process.env.BUFFER_TIKTOK_CHANNEL_ID || "";
        } else if (channelLower.includes("group") || channelLower.includes("nhóm")) {
          platform = "facebook_group";
          channelName = channel || "Facebook Group";
          channelId = process.env.BUFFER_FB_GROUP_CHANNEL_ID || "";
        } else {
          platform = "facebook_page";
          channelName = channel || "Haha hihi";
          channelId = process.env.BUFFER_FB_PAGE_CHANNEL_ID || "";
        }

        const id = bufferPostId || `publish_content_row_${i + 2}`;

        let assets = null;
        if (mediaUrls) {
          const splitUrls = mediaUrls.split(/\r?\n/).map(u => u.trim()).filter(Boolean);
          if (splitUrls.length > 0) {
            assets = splitUrls.map(u => ({
              source: u,
              thumbnail: u,
              url: u
            }));
          }
        }

        posts.push({
          id,
          post_id: id,
          buffer_post_id: bufferPostId,
          publish_row: i + 2,
          source_row: sourceRow ? parseInt(sourceRow, 10) : null,
          platform,
          channel_name: channelName,
          channel_id: channelId,
          type: (caption.length > 500 || title.includes("PHOTO")) ? "PHOTO_MODE" : "VIDEO",
          title: title || (caption ? caption.slice(0, 80) : "Bài viết đã đăng"),
          caption,
          status: "sent",
          created_at: publishedAt || new Date().toISOString(),
          updated_at: publishedAt || new Date().toISOString(),
          sent_at: publishedAt || new Date().toISOString(),
          live_post_url: liveUrl,
          external_url: liveUrl,
          buffer_url: liveUrl || (channelId ? `https://publish.buffer.com/channels/${channelId}/schedule?tab=drafts` : ""),
          media_urls: mediaUrls,
          assets: assets,
          source_origin: "publish_content_sheet"
        });
      }

      return posts;
    } catch (err) {
      logger.log(`⚠️ Lỗi đọc sheet '${publishSheetName}': ${err.message}`, "warn");
      return [];
    }
  }

  /**
   * Lưu hoặc cập nhật một bản ghi bài viết đã xuất bản vào tab 'Publish Content'
   * Đảm bảo phôi nội dung và bài viết đã đăng tách biệt hoàn toàn.
   */
  static async recordPublishedPost({
    buffer_post_id = "",
    live_post_url = "",
    channel = "Facebook",
    title = "",
    caption = "",
    published_at = null,
    source_row = null,
    status = "sent",
    media_urls = ""
  }) {
    const { sheetId, publishSheetName, credentialsPath } = getSheetConfig();

    if (!fs.existsSync(credentialsPath)) {
      logger.log(`⚠️ Không tìm thấy credentials.json, bỏ qua ghi sheet '${publishSheetName}'`, "warn");
      return { success: false, reason: "no_credentials" };
    }

    try {
      const sheets = await getGoogleSheetsClient();
      // 1. Đọc danh sách hiện có để kiểm tra trùng (tránh duplicate hàng)
      const res = await sheets.spreadsheets.values.get({
        spreadsheetId: sheetId,
        range: `'${publishSheetName}'!A2:I500`
      });
      const rows = res.data.values || [];

      const cleanBufferId = buffer_post_id ? String(buffer_post_id).trim() : "";
      const cleanLiveUrl = live_post_url ? String(live_post_url).trim() : "";
      const nowIso = published_at || new Date().toISOString();
      const cleanMediaUrls = Array.isArray(media_urls)
        ? media_urls.filter(Boolean).join("\n")
        : String(media_urls || "").trim();

      let targetRowIndex = -1; // 0-based relative to row 2
      for (let i = 0; i < rows.length; i++) {
        const rowBufId = rows[i][0] ? String(rows[i][0]).trim() : "";
        const rowLiveUrl = rows[i][1] ? String(rows[i][1]).trim() : "";

        if (cleanBufferId && rowBufId && cleanBufferId === rowBufId) {
          targetRowIndex = i;
          break;
        }
        if (cleanLiveUrl && rowLiveUrl && cleanLiveUrl === rowLiveUrl) {
          targetRowIndex = i;
          break;
        }
      }

      if (targetRowIndex >= 0) {
        // Cập nhật hàng đã có (deduplication)
        const sheetRowNum = targetRowIndex + 2;
        const existingRow = rows[targetRowIndex];
        const updatedRow = [
          cleanBufferId || existingRow[0] || "",
          cleanLiveUrl || existingRow[1] || "",
          channel || existingRow[2] || "Facebook",
          title || existingRow[3] || (caption ? caption.slice(0, 80) : ""),
          caption || existingRow[4] || "",
          existingRow[5] || nowIso,
          source_row !== null && source_row !== undefined ? String(source_row) : (existingRow[6] || ""),
          status || existingRow[7] || "sent",
          cleanMediaUrls || existingRow[8] || ""
        ];

        await sheets.spreadsheets.values.update({
          spreadsheetId: sheetId,
          range: `'${publishSheetName}'!A${sheetRowNum}:I${sheetRowNum}`,
          valueInputOption: "USER_ENTERED",
          requestBody: { values: [updatedRow] }
        });

        logger.log(`💾 [PUBLISH CONTENT] Đã cập nhật dòng #${sheetRowNum} trên '${publishSheetName}': ${cleanLiveUrl || cleanBufferId}`, "success");
        return { success: true, action: "updated", rowNumber: sheetRowNum };
      } else {
        // Thêm hàng mới
        const finalTitle = title || (caption ? caption.slice(0, 80) : "Bài viết đã đăng");
        const newRow = [
          cleanBufferId,
          cleanLiveUrl,
          channel || "Facebook",
          finalTitle,
          caption || "",
          nowIso,
          source_row !== null && source_row !== undefined ? String(source_row) : "",
          status || "sent",
          cleanMediaUrls
        ];

        const appendRes = await sheets.spreadsheets.values.append({
          spreadsheetId: sheetId,
          range: `'${publishSheetName}'!A2:I2`,
          valueInputOption: "USER_ENTERED",
          insertDataOption: "INSERT_ROWS",
          requestBody: { values: [newRow] }
        });

        logger.log(`🎉 [PUBLISH CONTENT] Đã ghi bài viết mới vào '${publishSheetName}': ${cleanLiveUrl || cleanBufferId}`, "success");
        return { success: true, action: "inserted", updates: appendRes.data.updates };
      }
    } catch (err) {
      logger.log(`❌ Lỗi ghi vào '${publishSheetName}': ${err.message}`, "error");
      return { success: false, error: err.message };
    }
  }

  /**
   * Xóa một bản ghi bài viết đã xuất bản khỏi tab 'Publish Content'
   * @param {string|number} identifier - publish_row (số dòng trên Sheet), buffer_post_id hoặc id
   */
  static async deletePublishedPost(identifier) {
    const { sheetId, publishSheetName, credentialsPath } = getSheetConfig();
    const fallbackPublishGid = parseInt(process.env.GOOGLE_PUBLISH_SHEET_GID || "743957638", 10);

    if (!fs.existsSync(credentialsPath)) {
      throw new Error(`Không tìm thấy credentials.json, không thể xóa khỏi Google Sheet '${publishSheetName}'`);
    }

    const sheets = await getGoogleSheetsClient();

    // 1. Đọc danh sách hiện tại của sheet 'Publish Content' để tìm dòng chính xác
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: `'${publishSheetName}'!A2:H500`
    });
    const rows = res.data.values || [];

    let targetRowIndex = -1; // 0-based relative to row 2
    const cleanId = String(identifier || "").trim();

    // Nếu identifier là số dòng trực tiếp (ví dụ publish_row = 3 -> targetRowIndex = 3 - 2 = 1)
    const num = parseInt(cleanId, 10);
    if (!isNaN(num) && num >= 2 && num <= rows.length + 1) {
      targetRowIndex = num - 2;
    } else {
      // Tìm theo buffer_post_id, live_post_url hoặc id
      for (let i = 0; i < rows.length; i++) {
        const rowBufId = rows[i][0] ? String(rows[i][0]).trim() : "";
        const rowLiveUrl = rows[i][1] ? String(rows[i][1]).trim() : "";
        const customId = `publish_content_row_${i + 2}`;

        if (cleanId === rowBufId || cleanId === customId || cleanId === rowLiveUrl) {
          targetRowIndex = i;
          break;
        }
      }
    }

    if (targetRowIndex < 0) {
      logger.log(`⚠️ Không tìm thấy bản ghi '${identifier}' trong sheet '${publishSheetName}' để xóa`, "warn");
      return { success: false, reason: "not_found" };
    }

    const sheetRowNum = targetRowIndex + 2; // 1-indexed row number trên Google Sheet

    // Lấy chính xác sheetId (gid số) của tab 'Publish Content'
    let targetGid = fallbackPublishGid;
    try {
      const meta = await sheets.spreadsheets.get({ spreadsheetId: sheetId });
      const foundSheet = (meta.data.sheets || []).find(s => s.properties?.title === publishSheetName);
      if (foundSheet && foundSheet.properties?.sheetId !== undefined) {
        targetGid = foundSheet.properties.sheetId;
      }
    } catch (_) {}

    // 2. Thực hiện xóa dòng thực tế qua Google Sheets API batchUpdate deleteDimension
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: sheetId,
      resource: {
        requests: [
          {
            deleteDimension: {
              range: {
                sheetId: targetGid,
                dimension: "ROWS",
                startIndex: sheetRowNum - 1, // 0-indexed startIndex
                endIndex: sheetRowNum       // endIndex is exclusive
              }
            }
          }
        ]
      }
    });

    logger.log(`🗑️ [PUBLISH CONTENT] Đã xóa thành công Dòng #${sheetRowNum} khỏi sheet '${publishSheetName}'`, "success");
    return { success: true, deletedRow: sheetRowNum, identifier };
  }
}

