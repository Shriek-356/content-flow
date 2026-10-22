import { SheetsService } from "../services/sheets.service.js";
import { BufferService } from "../services/buffer.service.js";

/**
 * Tạo URL trực tiếp tới tab bài viết trong kênh Buffer (Drafts/Sent/Queue)
 */
export function getBufferDirectUrl(channelId, status, platform) {
  let chId = channelId;
  if (!chId) {
    const p = (platform || "").toLowerCase();
    if (p.includes("tiktok")) chId = process.env.BUFFER_TIKTOK_CHANNEL_ID || "6a9127f8ccaf649a6730ed06";
    else if (p.includes("group")) chId = process.env.BUFFER_FB_GROUP_CHANNEL_ID || "6a924ceaccaf649a6739cf0f";
    else chId = process.env.BUFFER_FB_PAGE_CHANNEL_ID || "6a923468ccaf649a673949ef";
  }

  const s = (status || "").toLowerCase();
  let tab = "drafts";
  if (s.includes("queue") || s.includes("sched") || s.includes("inbox") || s.includes("sending")) {
    tab = "queue";
  }

  return `https://publish.buffer.com/channels/${chId}/schedule?tab=${tab}`;
}

/**
 * Lấy toàn bộ bài đăng đã xuất bản TRỰC TIẾP từ Google Sheet 'Publish Content'
 * Tuyệt đối không đọc từ file JSON cục bộ
 */
export async function getPosts() {
  try {
    return await SheetsService.fetchPublishedPosts();
  } catch (err) {
    console.error("❌ Lỗi lấy bài từ Google Sheet 'Publish Content':", err.message);
    return [];
  }
}

/**
 * Ghi nhận hoặc đồng bộ bài đăng trực tiếp vào Google Sheet 'Publish Content'
 * và Buffer Tracker (hoàn toàn realtime, không lưu file JSON cục bộ)
 */
export async function recordPost(postData) {
  try {
    const id = postData.post_id || postData.id || `post_${Date.now()}`;
    const status = (postData.status || "DRAFT_IN_BUFFER").toLowerCase();
    const isSent = status.includes("sent") || status.includes("publish") || status.includes("posted") || Boolean(postData.live_post_url || postData.external_url);

    let channelName = postData.channel_name || "Facebook";
    const plat = (postData.platform || "").toLowerCase();
    if (plat.includes("tiktok") || (postData.external_url && postData.external_url.includes("tiktok"))) {
      channelName = "TikTok";
    } else if (plat.includes("group") || channelName.toLowerCase().includes("group")) {
      channelName = "Facebook Group";
    }

    const mediaUrl = postData.video_url || postData.metadata?.video_url || (Array.isArray(postData.assets) ? postData.assets.map(a => a.source || a.url).join("\n") : "");

    // 1. Nếu bài đã xuất bản hoặc có link live -> Ghi trực tiếp vào tab 'Publish Content' của Google Sheet
    if (isSent) {
      await SheetsService.recordPublishedPost({
        buffer_post_id: id,
        live_post_url: postData.live_post_url || postData.external_url || "",
        channel: channelName,
        title: postData.title || (postData.caption ? postData.caption.slice(0, 80) : "Bài viết đã đăng"),
        caption: postData.caption || postData.fullMessage || postData.text || "",
        published_at: postData.sent_at || postData.created_at || new Date().toISOString(),
        status: "sent",
        source_row: postData.source_row || postData.row_number || null,
        media_urls: mediaUrl
      });
    } else if (status.includes("sched") || status.includes("queue") || postData.due_at) {
      // 2. Bài trong hàng đợi -> Lưu vào tracked queue của BufferService để tự động đồng bộ khi đến hạn
      try {
        BufferService.trackQueuePost({
          id,
          due_at: postData.due_at || null,
          channelService: plat,
          channel_id: postData.channel_id || null,
          title: postData.title || (postData.caption ? postData.caption.slice(0, 80) : "Bài viết"),
          caption: postData.caption || postData.text || "",
          status: "scheduled"
        });
      } catch (_) {}
    }

    const directUrl = getBufferDirectUrl(postData.channel_id, postData.status, plat);
    return {
      id,
      post_id: id,
      platform: plat,
      title: postData.title || (postData.caption ? postData.caption.slice(0, 80) : "Bài viết"),
      caption: postData.caption || "",
      status: postData.status,
      buffer_url: directUrl,
      created_at: postData.created_at || new Date().toISOString(),
      updated_at: new Date().toISOString(),
      ...postData
    };
  } catch (err) {
    console.error("❌ Lỗi ghi nhận bài đăng realtime:", err.message);
    return null;
  }
}

/**
 * Đồng bộ bài viết hàng đợi với Buffer API thật và tự động ghi nhận bài sent sang Google Sheet
 */
export async function syncBufferActivePosts(livePosts = []) {
  try {
    if (livePosts && Array.isArray(livePosts) && livePosts.length > 0) {
      await BufferService.syncDueQueuePosts({ force: true });
    }
    return await SheetsService.fetchPublishedPosts();
  } catch (err) {
    console.error("❌ Lỗi đồng bộ live posts Buffer:", err.message);
    return [];
  }
}

/**
 * Tính toán thống kê theo kênh và trạng thái từ Google Sheet và Buffer API
 */
export async function getStats() {
  try {
    const [published, live] = await Promise.all([
      SheetsService.fetchPublishedPosts().catch(() => []),
      BufferService.getLivePosts().catch(() => [])
    ]);

    const activeLive = live.filter(p => {
      const s = (p.status || "").toLowerCase();
      return !s.includes("sent") && !s.includes("posted");
    });

    const all = [...published, ...activeLive];

    const by_platform = {
      tiktok: 0,
      facebook_page: 0,
      facebook_group: 0,
      other: 0
    };

    const by_status = {
      draft: 0,
      published: 0,
      notification_pending: 0,
      error: 0
    };

    all.forEach((p) => {
      const plat = (p.platform || "other").toLowerCase();
      if (by_platform[plat] !== undefined) by_platform[plat]++;
      else by_platform.other++;

      const st = (p.status || "").toUpperCase();
      if (st.includes("DRAFT")) by_status.draft++;
      else if (st.includes("PUBLISH") || st.includes("SENT") || st.includes("POSTED")) by_status.published++;
      else if (st.includes("NOTIFICATION")) by_status.notification_pending++;
      else if (st.includes("ERROR") || st.includes("FAIL")) by_status.error++;
      else by_status.draft++;
    });

    return {
      total: all.length,
      by_platform,
      by_status
    };
  } catch (err) {
    return {
      total: 0,
      by_platform: { tiktok: 0, facebook_page: 0, facebook_group: 0, other: 0 },
      by_status: { draft: 0, published: 0, notification_pending: 0, error: 0 }
    };
  }
}

/**
 * Xóa một bài đăng đã xuất bản khỏi Google Sheet 'Publish Content'
 */
export async function removePost(id) {
  try {
    await SheetsService.deletePublishedPost(id);
    return true;
  } catch (err) {
    console.error("❌ Lỗi xóa post khỏi Google Sheet 'Publish Content':", err.message);
    return false;
  }
}

/**
 * Tự động dò tìm dòng tương ứng trên Google Sheet dựa trên nội dung caption/title/options
 */
export async function findMatchingSheetRow(text = "", channel = "") {
  try {
    const allRows = await SheetsService.fetchSheetRows();
    if (!text || !text.trim()) return null;

    const cleanTarget = text.replace(/[\s\n\r\t]+/g, " ").trim().toLowerCase();
    const chTarget = (channel || "").toLowerCase();

    const matched = allRows.find(r => {
      if (chTarget) {
        const rowCh = (r.channel || "").toLowerCase();
        if (chTarget.includes("tiktok") && !rowCh.includes("tiktok")) return false;
        if (chTarget.includes("facebook") && !rowCh.includes("facebook")) return false;
      }

      const opt1 = (r.option_1 || "").replace(/[\s\n\r\t]+/g, " ").trim().toLowerCase();
      const opt2 = (r.option_2 || "").replace(/[\s\n\r\t]+/g, " ").trim().toLowerCase();
      const opt3 = (r.option_3 || "").replace(/[\s\n\r\t]+/g, " ").trim().toLowerCase();
      const hook = (r.hook || "").replace(/[\s\n\r\t]+/g, " ").trim().toLowerCase();

      const sample1 = opt1.slice(0, 35);
      const sample2 = opt2.slice(0, 35);
      const sample3 = opt3.slice(0, 35);
      const sampleH = hook.slice(0, 25);

      return (
        (sample1 && (cleanTarget.includes(sample1) || sample1.includes(cleanTarget.slice(0, 35)))) ||
        (sample2 && (cleanTarget.includes(sample2) || sample2.includes(cleanTarget.slice(0, 35)))) ||
        (sample3 && (cleanTarget.includes(sample3) || sample3.includes(cleanTarget.slice(0, 35)))) ||
        (sampleH && sampleH !== "chưa có" && (cleanTarget.includes(sampleH) || sampleH.includes(cleanTarget.slice(0, 25))))
      );
    });

    return matched || null;
  } catch (err) {
    console.warn("Lỗi tìm dòng Sheet khớp bài viết:", err.message);
    return null;
  }
}
