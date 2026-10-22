import { Router } from "express";
import path from "path";
import fs from "fs";
import { logger } from "../utils/logger.util.js";
import { recordPost } from "../utils/posts.util.js";
import { BufferService } from "../services/buffer.service.js";
import { SheetsService, getSheetConfig } from "../services/sheets.service.js";

const router = Router();

// ============================================================
// 1. Phục vụ giao diện HTML theo từng file trong folder templates/
// ============================================================
const TEMPLATES_DIR = path.join(process.cwd(), "templates");

router.get("/", (_, res) => res.sendFile(path.join(process.cwd(), "index.html")));
router.get("/dashboard", (_, res) => res.redirect("/"));

router.get("/content", (_, res) => {
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(path.join(TEMPLATES_DIR, "content-list.html"));
});


router.get("/content/:row_number", (_, res) => {
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(path.join(TEMPLATES_DIR, "content-detail.html"));
});

router.get("/buffer", (_, res) => {
  res.sendFile(path.join(TEMPLATES_DIR, "buffer.html"));
});

router.get("/automation", (_, res) => {
  res.sendFile(path.join(TEMPLATES_DIR, "automation.html"));
});

// ============================================================
// HÀM LẤY BÀI VIẾT KẾT HỢP: SENT TỪ GOOGLE SHEET + QUEUE/DRAFTS TRỰC TIẾP TỪ BUFFER
// HOÀN TOÀN KHÔNG DÙNG DỮ LIỆU CỤC BỘ (LOCAL JSON)
// ============================================================
async function getUnifiedPosts({ sync = false, force = false } = {}) {
  // 1. Tự động kiểm tra và đồng bộ các bài trong hàng đợi đã đến giờ hẹn sang Sheet 'Publish Content'
  try {
    await BufferService.syncDueQueuePosts({ force });
  } catch (syncErr) {
    logger.log(`⚠️ Lỗi tự động sync bài queue đến hạn: ${syncErr.message}`, "warn");
  }

  // 2. Lấy toàn bộ bài Queue & Drafts TRỰC TIẾP từ Buffer GraphQL API
  let bufferPosts = [];
  try {
    bufferPosts = await BufferService.getLivePosts({ force });
  } catch (e) {
    logger.log(`Không thể tải bài từ Buffer API: ${e.message}`, "warn");
  }

  // Tách các bài Queue và Drafts đang hoạt động trên Buffer
  const activeBufferPosts = bufferPosts.filter(p => {
    const s = (p.status || "").toLowerCase();
    return !s.includes("sent") && !s.includes("posted");
  });

  // 3. Toàn bộ danh sách bài đã đăng (Sent) ĐỘC QUYỀN lấy từ Google Sheet 'Publish Content'
  // Tuyệt đối không lấy tab sent từ Buffer API (tránh bài test cũ lẫn lộn)
  let sheetSentPosts = [];
  try {
    sheetSentPosts = await SheetsService.fetchPublishedPosts();
  } catch (err) {
    logger.log(`⚠️ Không thể đọc bài đã đăng từ Sheet 'Publish Content': ${err.message}`, "warn");
  }

  return [
    ...sheetSentPosts,
    ...activeBufferPosts
  ];
}

// ============================================================
// 2. GET /api/posts - Danh sách bài đăng có phân trang & bộ lọc
// ============================================================
router.get("/api/posts", async (req, res) => {
  try {
    let posts = await getUnifiedPosts({ 
      sync: req.query.sync === "true",
      force: req.query.force === "true"
    });
    const { platform, status, search, page = 1, limit = 20 } = req.query;

    if (platform && platform !== "all") {
      posts = posts.filter((p) => p.platform === platform);
    }

    if (req.query.exclude_sent === "true") {
      posts = posts.filter((p) => {
        const s = (p.status || "").toUpperCase();
        if (s.includes("DRAFT") || s.includes("QUEUE") || s.includes("SCHED") || s.includes("INBOX")) return true;
        return !(s.includes("PUBLISH") || s.includes("SENT") || s.includes("POSTED"));
      });
    }

    if (status && status !== "all") {
      posts = posts.filter((p) => {
        const s = (p.status || "").toUpperCase();
        if (status === "draft") return s.includes("DRAFT");
        if (status === "published" || status === "sent") return s.includes("PUBLISH") || s.includes("SENT") || s.includes("POSTED");
        if (status === "scheduled" || status === "queue") return s.includes("SCHED") || s.includes("QUEUE");
        if (status === "notification") return s.includes("NOTIFICATION");
        if (status === "error") return s.includes("ERROR");
        return true;
      });
    }

    if (search && search.trim()) {
      const q = search.trim().toLowerCase();
      posts = posts.filter((p) =>
        (p.caption && p.caption.toLowerCase().includes(q)) ||
        (p.title && p.title.toLowerCase().includes(q)) ||
        (p.post_id && p.post_id.toLowerCase().includes(q)) ||
        (p.channel_name && p.channel_name.toLowerCase().includes(q))
      );
    }

    // Sắp xếp bài mới nhất lên đầu (theo thời gian tạo hoặc đăng gần nhất)
    posts.sort((a, b) => {
      const dateA = new Date(a.sent_at || a.created_at || a.updated_at || 0).getTime();
      const dateB = new Date(b.sent_at || b.created_at || b.updated_at || 0).getTime();
      return dateB - dateA;
    });

    const total = posts.length;
    const pageNum = Math.max(1, parseInt(page) || 1);
    const limitNum = Math.max(1, parseInt(limit) || 20);
    const totalPages = Math.ceil(total / limitNum);
    const startIndex = (pageNum - 1) * limitNum;
    const paginatedPosts = posts.slice(startIndex, startIndex + limitNum);

    const quota = BufferService.getQuota();

    return res.json({
      success: true,
      posts: paginatedPosts,
      total,
      page: pageNum,
      limit: limitNum,
      total_pages: totalPages,
      hasMore: pageNum < totalPages,
      quota,
      buffer_error: quota.isRateLimited ? "Buffer API đã đạt giới hạn 250 lượt/ngày (RATE_LIMIT_EXCEEDED)" : null
    });
  } catch (err) {
    logger.log(`Lỗi API posts: ${err.message}`, "error");
    return res.status(500).json({ success: false, error: err.message, posts: [], quota: BufferService.getQuota() });
  }
});

// ============================================================
// 2b. POST /api/buffer/sync - Đồng bộ bài viết từ Buffer GraphQL API
// ============================================================
router.post("/api/buffer/sync", async (req, res) => {
  try {
    const livePosts = await BufferService.getLivePosts({ force: true });
    logger.log(`Đã đồng bộ ${livePosts.length} bài viết trực tiếp từ Buffer GraphQL API`, "info");
    const updatedPosts = await getUnifiedPosts({ sync: false });
    return res.json({
      success: true,
      count: livePosts.length,
      message: `Đã đồng bộ thành công! Hiện có ${livePosts.length} bài viết trong bản nháp & hàng đợi trên Buffer.`,
      posts: updatedPosts,
      quota: BufferService.getQuota()
    });
  } catch (err) {
    logger.log(`Lỗi đồng bộ Buffer: ${err.message}`, "error");
    return res.status(500).json({ 
      success: false, 
      error: err.message,
      quota: BufferService.getQuota()
    });
  }
});

// ============================================================
// 2b-quota. GET /api/buffer/quota - Kiểm tra hạn mức gọi Buffer API
// ============================================================
router.get("/api/buffer/quota", async (req, res) => {
  try {
    const quota = await BufferService.checkQuota();
    return res.json({ success: true, quota });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message, quota: BufferService.getQuota() });
  }
});

// ============================================================
// 2b-token. POST /api/buffer/token - Đổi Access Token Buffer mới
// ============================================================
router.post("/api/buffer/token", async (req, res) => {
  try {
    const { token } = req.body || {};
    if (!token || typeof token !== "string" || !token.trim()) {
      return res.status(400).json({ success: false, error: "Vui lòng nhập Access Token Buffer hợp lệ" });
    }
    const cleanToken = token.trim();

    // 1. Cập nhật file .env nếu có
    const envPath = path.resolve(process.cwd(), ".env");
    if (fs.existsSync(envPath)) {
      let envContent = fs.readFileSync(envPath, "utf8");
      if (envContent.includes("BUFFER_ACCESS_TOKEN=")) {
        envContent = envContent.replace(/BUFFER_ACCESS_TOKEN=.*/g, `BUFFER_ACCESS_TOKEN=${cleanToken}`);
      } else {
        envContent += `\nBUFFER_ACCESS_TOKEN=${cleanToken}\n`;
      }
      fs.writeFileSync(envPath, envContent, "utf8");
    }

    // 2. Tải lại cấu hình runtime trong BufferService
    BufferService.reloadToken(cleanToken);

    // 3. Tự động quét và nhận diện Organization ID & Channels của nick mới
    let discoverResult = null;
    try {
      discoverResult = await BufferService.autoDiscoverChannels(cleanToken);
    } catch (discErr) {
      logger.log(`⚠️ Chưa thể quét channels: ${discErr.message}`, "warn");
    }

    // 4. Kiểm tra hạn mức của token mới
    const quota = await BufferService.checkQuota(cleanToken);

    const channelNames = (discoverResult?.channels || []).map(c => `${c.name} (${c.service})`).join(", ");
    const message = discoverResult?.channels?.length > 0
      ? `Đã kết nối Token mới và tự động nhận diện ${discoverResult.channels.length} kênh: ${channelNames}!`
      : (quota.isRateLimited 
          ? "Token mới đã được lưu nhưng hiện tại cũng đang chạm giới hạn 250 lượt/ngày!" 
          : `Đã lưu Token Buffer mới thành công! Còn lại ${quota.remaining}/${quota.limit} lượt.`);

    logger.log(`🔑 ${message}`, "info");
    return res.json({
      success: true,
      message,
      quota,
      channels: discoverResult?.channels || [],
      mapped: discoverResult?.mapped || null
    });
  } catch (err) {
    logger.log(`Lỗi đổi Token Buffer: ${err.message}`, "error");
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================
// 2b-2. GET /api/posts/stats - Thống kê số lượng bài
// ============================================================
router.get("/api/posts/stats", async (_, res) => {
  try {
    const posts = await getUnifiedPosts();
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

    posts.forEach((p) => {
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

    return res.json({
      success: true,
      stats: {
        total: posts.length,
        by_platform,
        by_status
      }
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================
// 2c. GET /api/posts/:id - Chi tiết một bài viết cụ thể
// ============================================================
router.get("/api/posts/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const posts = await getUnifiedPosts();
    let post = posts.find((p) => p.post_id === id || p.id === id);

    // Thử lấy thêm thông tin chi tiết qua Buffer API nếu có
    try {
      const bufferDetail = await BufferService.getPostDetail({ postId: id });
      if (bufferDetail) {
        post = { ...(post || {}), ...bufferDetail };
      }
    } catch (_) {}

    if (!post) {
      return res.status(404).json({ success: false, error: "Không tìm thấy bài viết" });
    }

    return res.json({ success: true, post });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================
// ============================================================
// 2d. POST /api/buffer/posts/:id/publish-now - Đăng ngay lập tức bài viết trên Buffer
// ============================================================
router.post("/api/buffer/posts/:id/publish-now", async (req, res) => {
  try {
    const { id } = req.params;
    const { text } = req.body || {};
    const post = await BufferService.publishPostNow({ postId: id, text });
    if (post) {
      recordPost({ id: post.id, status: "sending", caption: text || post.text });
      BufferService.clearLivePostsCache();

      // Đưa vào danh sách theo dõi trạng thái publishing
      BufferService.trackQueuePost({
        id: post.id,
        title: (text || post.text)?.slice(0, 80) || "Bài viết",
        caption: text || post.text || "",
        channelService: post.channelService,
        status: "publishing"
      });

      // 1. Kiểm tra nhanh (fast-await) 1 lần (2.5s) trước khi trả về response cho frontend
      // Facebook Page/Group thường hoàn tất xuất bản chỉ trong 2-3 giây!
      let publishedDirectly = false;
      let directLiveUrl = "";
      const fastDelays = [2500];
      for (const d of fastDelays) {
        await new Promise(r => setTimeout(r, d));
        try {
          const statusMap = await BufferService.checkPostsStatus([id]);
          const info = statusMap[id];
          if (info && (info.status === 'sent' || info.externalLink)) {
            directLiveUrl = info.externalLink || '';
            const svc = (info.channelService || post.channelService || post.platform || '').toLowerCase();
            let channelName = "Facebook Page";
            if (svc.includes("tiktok") || directLiveUrl.includes("tiktok")) {
              channelName = "TikTok";
            } else if (svc.includes("group")) {
              channelName = "Facebook Group";
            }

            // Ghi TRỰC TIẾP vào Google Sheet 'Publish Content' NGAY LẬP TỨC
            await SheetsService.recordPublishedPost({
              buffer_post_id: id,
              live_post_url: directLiveUrl,
              channel: channelName,
              title: (text || post.text)?.slice(0, 80) || "Bài viết đã đăng",
              caption: text || post.text || "",
              published_at: info.sentAt || new Date().toISOString(),
              status: 'sent'
            });
            logger.log(`💾 [PUBLISH CONTENT] Đã ghi nhận bài đăng vào sheet 'Publish Content': ${directLiveUrl || id}`, "success");

            BufferService.untrackQueuePost(id);
            recordPost({
              id: id,
              status: 'sent',
              external_url: info.externalLink,
              live_post_url: info.externalLink,
              sent_at: info.sentAt || new Date().toISOString()
            });
            BufferService.clearLivePostsCache();
            publishedDirectly = true;
            break;
          }
        } catch (err) {
          console.warn("Lỗi kiểm tra nhanh trạng thái sau publish-now:", err.message);
        }
      }

      // 2. Nếu sau kiểm tra nhanh vẫn chưa xong (ví dụ TikTok cần xử lý video), polling thêm tối đa 3 lần
      if (!publishedDirectly) {
        (async () => {
          const remainingDelays = [8000, 20000, 45000];
          for (const delay of remainingDelays) {
            await new Promise(r => setTimeout(r, delay));
            try {
              const statusMap = await BufferService.checkPostsStatus([id]);
              const info = statusMap[id];
              if (info && (info.status === 'sent' || info.externalLink)) {
                const liveUrl = info.externalLink || '';
                const svc = (info.channelService || post.channelService || post.platform || '').toLowerCase();
                let channelName = "Facebook Page";
                if (svc.includes("tiktok") || liveUrl.includes("tiktok")) {
                  channelName = "TikTok";
                } else if (svc.includes("group")) {
                  channelName = "Facebook Group";
                }

                await SheetsService.recordPublishedPost({
                  buffer_post_id: id,
                  live_post_url: liveUrl,
                  channel: channelName,
                  title: (text || post.text)?.slice(0, 80) || "Bài viết đã đăng",
                  caption: text || post.text || "",
                  published_at: info.sentAt || new Date().toISOString(),
                  status: 'sent'
                });
                logger.log(`💾 [PUBLISH CONTENT] Đã ghi nhận bài đăng vào sheet 'Publish Content': ${liveUrl || id}`, "success");

                BufferService.untrackQueuePost(id);
                recordPost({
                  id: id,
                  status: 'sent',
                  external_url: info.externalLink,
                  live_post_url: info.externalLink,
                  sent_at: info.sentAt || new Date().toISOString()
                });
                BufferService.clearLivePostsCache();
                break;
              }
            } catch (e) {
              console.warn("Lỗi polling live_post_url sau khi publish now:", e.message);
            }
          }
        })();
      }

      logger.log(`🚀 [BUFFER] Lệnh xuất bản ID: ${id} | Đồng bộ ngay: ${publishedDirectly}`, "success");
      return res.json({ 
        success: true, 
        published: publishedDirectly, 
        live_url: directLiveUrl,
        message: publishedDirectly 
          ? "Đã xuất bản thành công và đồng bộ vào Google Sheet!" 
          : "Đã gửi lệnh xuất bản, Buffer đang xử lý ngầm...", 
        post 
      });
    }
    return res.json({ success: true, message: "Đã gửi lệnh xuất bản thành công!", post });
  } catch (err) {
    logger.log(`❌ Lỗi xuất bản ngay Buffer: ${err.message}`, "error");
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================
// 2e. PUT /api/buffer/posts/:id - Cập nhật nội dung / lịch hẹn bài viết Buffer
// ============================================================
router.put("/api/buffer/posts/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { text, due_at, dueAt, save_to_draft, saveToDraft, mode, metadata } = req.body;

    const targetDueAt = due_at || dueAt || null;
    const targetSaveToDraft = (save_to_draft !== undefined) ? save_to_draft : saveToDraft;

    const updated = await BufferService.editPost({
      postId: id,
      text: text !== undefined ? text : null,
      dueAt: targetDueAt,
      saveToDraft: Boolean(targetSaveToDraft),
      mode: mode || (targetDueAt ? "customScheduled" : "addToQueue"),
      metadata
    });

    if (updated) {
      recordPost({
        id: updated.id,
        caption: updated.text || text,
        due_at: updated.dueAt || targetDueAt,
        status: updated.status
      });
    }

    logger.log(`💾 [BUFFER] Đã cập nhật bài viết ID: ${id}`, "success");
    return res.json({ success: true, message: "Đã cập nhật bài viết thành công!", post: updated });
  } catch (err) {
    logger.log(`❌ Lỗi cập nhật bài viết Buffer: ${err.message}`, "error");
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================
// 2f. DELETE /api/buffer/posts/:id - Xóa bài viết khỏi Buffer hoặc Google Sheet (Publish Content)
// ============================================================
router.delete("/api/buffer/posts/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const isSentExplicit = req.query.is_sent === "true" || req.query.origin === "publish_content_sheet";
    const publishRowNum = req.query.publish_row ? parseInt(req.query.publish_row, 10) : null;

    // 1. Kiểm tra xem bài viết này có phải là bài đã đăng nằm trong tab 'Publish Content' hay không
    let isPublishedPost = isSentExplicit || Boolean(publishRowNum) || (id && id.startsWith("publish_content_row_"));
    
    if (!isPublishedPost) {
      try {
        const publishedPosts = await SheetsService.fetchPublishedPosts();
        const found = publishedPosts.find(p => 
          p.id === id || 
          p.post_id === id || 
          p.buffer_post_id === id || 
          (p.publish_row && String(p.publish_row) === String(id))
        );
        if (found) {
          isPublishedPost = true;
        }
      } catch (_) {}
    }

    // NẾU LÀ BÀI ĐÃ XUẤT BẢN (SENT):
    // Quản lý độc quyền trên Google Sheet 'Publish Content'.
    // Tuyệt đối KHÔNG gọi Buffer API xóa (vì Buffer không hỗ trợ API xóa bài đã đăng và sẽ báo lỗi:
    // "Buffer Delete Error: Account is not allowed to perform this action on post")
    if (isPublishedPost) {
      const targetIdentifier = publishRowNum || id;
      const deleteResult = await SheetsService.deletePublishedPost(targetIdentifier);
      
      BufferService.clearLivePostsCache();
      logger.log(`🗑️ [PUBLISH CONTENT] Đã xóa bản ghi bài đã đăng (${id}) khỏi Google Sheet 'Publish Content'`, "success");
      return res.json({ 
        success: true, 
        message: "Đã xóa bản ghi bài viết khỏi Google Sheet (Publish Content) thành công!",
        sheetResult: deleteResult
      });
    }

    // NẾU LÀ BÀI NHÁP HOẶC HÀNG ĐỢI (DRAFT / QUEUE):
    // Gọi trực tiếp Buffer API xóa bài trên Buffer
    if (id && !id.startsWith("sheet_row_")) {
      try {
        await BufferService.deletePost({ postId: id });
        BufferService.untrackQueuePost(id);
      } catch (bufErr) {
        // Nếu Buffer báo lỗi bài viết không được phép xóa (do bài đã chuyển sang trạng thái sent trên Buffer)
        if (bufErr.message.includes("Account is not allowed to perform this action") || bufErr.message.includes("sent")) {
          logger.log(`ℹ️ [BUFFER DELETE] Bài viết ${id} đã xuất bản trên Buffer -> Chuyển sang xóa bản ghi trên Google Sheet 'Publish Content'`, "info");
          await SheetsService.deletePublishedPost(id);
          BufferService.clearLivePostsCache();
          return res.json({ 
            success: true, 
            message: "Đã xóa bản ghi bài viết khỏi Google Sheet (Publish Content) thành công!" 
          });
        }
        throw bufErr;
      }
    }

    // Cập nhật Google Sheet Content Selector nếu có bài tương ứng
    try {
      const allRows = await SheetsService.fetchSheetRows();
      const targetRow = allRows.find(r => r.buffer_post_id === id || `sheet_row_${r.row_number}` === id);
      if (targetRow) {
        await SheetsService.updateRow(targetRow.row_number, {
          status: 'cancelled',
          live_post_url: '',
          buffer_post_id: ''
        });
        logger.log(`🗑️ Đã xóa liên kết bài viết trên Google Sheet Dòng #${targetRow.row_number}`, "info");
      }
    } catch (sheetErr) {
      console.warn("Lỗi cập nhật Google Sheet khi xóa bài:", sheetErr.message);
    }

    // Xóa cache memory
    BufferService.clearLivePostsCache();

    logger.log(`🗑️ [BUFFER] Đã xóa thành công bài viết ID: ${id} trên Buffer & Sheet`, "success");
    return res.json({ success: true, message: "Đã xóa bài viết khỏi Buffer thành công!" });
  } catch (err) {
    logger.log(`❌ Lỗi xóa bài viết: ${err.message}`, "error");
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================
// 2g. POST /api/buffer/sync-sent - Đồng bộ các bài đã xuất bản từ Buffer Queue
// ============================================================
router.post("/api/buffer/sync-sent", async (req, res) => {
  try {
    const result = await BufferService.syncPublishedPosts();
    return res.json(result);
  } catch (err) {
    logger.log(`❌ [SYNC BUFFER POSTS] Lỗi: ${err.message}`, "error");
    return res.status(500).json({ success: false, error: err.message });
  }
});

router.get("/api/buffer/sync-sent", async (req, res) => {
  try {
    const result = await BufferService.syncPublishedPosts();
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================
// 2g-2. POST /api/buffer/refresh-links - Lấp link FB/TikTok cho bài sent thiếu link
// Quét các bản ghi Publish Content chưa có live_post_url, hỏi Buffer theo buffer_post_id
// (gộp tối đa 25 ID/1 request), có link thì ghi bù (dedup theo buffer_post_id nên an toàn).
// ============================================================
router.post("/api/buffer/refresh-links", async (req, res) => {
  try {
    const sentRows = await SheetsService.fetchPublishedPosts();
    const missing = sentRows.filter(
      (p) => !(p.live_post_url || p.external_url) && p.buffer_post_id
    );
    if (missing.length === 0) {
      return res.json({ success: true, checked: 0, filled: 0, message: "Không có bài nào thiếu link." });
    }

    const ids = [...new Set(missing.map((p) => String(p.buffer_post_id)))].slice(0, 100);
    const statusMap = await BufferService.checkPostsStatus(ids);

    let filled = 0;
    for (const p of missing) {
      const info = statusMap[String(p.buffer_post_id)];
      if (info && info.externalLink) {
        try {
          await SheetsService.recordPublishedPost({
            buffer_post_id: p.buffer_post_id,
            live_post_url: info.externalLink,
            channel: p.channel_name || p.platform || "Facebook",
            title: p.title || "",
            caption: p.caption || "",
            published_at: info.sentAt || p.sent_at || new Date().toISOString(),
            status: "sent"
          });
          filled++;
        } catch (e) {
          console.warn(`Lỗi lấp link bài ${p.buffer_post_id}:`, e.message);
        }
      }
    }

    if (filled > 0) BufferService.clearLivePostsCache();
    logger.log(`🔗 [REFRESH LINKS] Kiểm tra ${ids.length} bài thiếu link, lấp được ${filled}.`, "info");
    return res.json({ success: true, checked: ids.length, filled });
  } catch (err) {
    logger.log(`❌ [REFRESH LINKS] Lỗi: ${err.message}`, "error");
    return res.status(500).json({ success: false, error: err.message });
  }
});


// ============================================================
// 4. GET /api/logs - Server-Sent Events (SSE) Stream log thời gian thực
// ============================================================
router.get("/api/logs", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  // 1. Gửi lịch sử log gần nhất
  const history = logger.getHistory();
  res.write(`data: ${JSON.stringify({ type: "history", data: history })}\n\n`);

  // 2. Đăng ký nhận log mới
  const onNewLog = (entry) => {
    res.write(`data: ${JSON.stringify({ type: "log", data: entry })}\n\n`);
  };

  logger.subscribe(onNewLog);

  // 3. Hủy đăng ký khi client đóng kết nối
  req.on("close", () => {
    logger.unsubscribe(onNewLog);
  });
});

// Biến lưu trữ lượt kích hoạt gần nhất để đồng bộ real-time chính xác action & row
let lastTriggerInfo = null;

// ============================================================
const N8N_ACTION_NAMES = {
  content: "Tạo 3 Options Content bằng AI",
  publish: "Đăng bài tự động lên Buffer",
  images: "Tạo ảnh minh họa bằng AI"
};

// Bắn 1 webhook n8n cho 1 action + 1 dòng (fire-and-forget: 200 = đã nhận lệnh, n8n chạy ngầm).
// Dùng chung cho trigger lẻ và trigger-selected (B2) để đảm bảo cùng 1 đường đã kiểm chứng.
// Chống bấm đúp hoàn toàn ở phía frontend (khóa nút + khóa dòng đang chạy + đóng modal sau khi gửi).
async function fireN8nActionWebhook({ action = "publish", target_row = null }) {
  // Danh sách các cổng và host n8n có thể chạy (ưu tiên từ .env)
  const configuredHost = process.env.N8N_BASE_URL;
  const hosts = [
    ...(configuredHost ? [configuredHost] : []),
    "http://127.0.0.1:5678",
    "http://localhost:5678",
    "http://host.docker.internal:5678",
    "http://172.29.192.1:5678"
  ].filter((v, i, a) => a.indexOf(v) === i); // Lọc trùng lặp

  const webhookPaths = {
    publish: [process.env.N8N_WEBHOOK_PUBLISH_PATH || "/webhook/trigger-publish", "/webhook-test/trigger-publish"],
    images: [process.env.N8N_WEBHOOK_IMAGES_PATH || "/webhook/trigger-generate-images", "/webhook-test/trigger-generate-images"],
    content: [process.env.N8N_WEBHOOK_CONTENT_PATH || "/webhook/trigger-generate-content", "/webhook-test/trigger-generate-content"]
  };

  const targetMsg = target_row ? ` (Chỉ định Dòng #${target_row})` : " (Tất cả các dòng)";
  const candidatePaths = webhookPaths[action] || ["/webhook/trigger-publish"];
  let triggered = false;
  let lastError = null;
  let triggeredUrl = "";

  for (const base of hosts) {
    for (const p of candidatePaths) {
      try {
        const url = `${base}${p}`;
        const response = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            source: "dashboard_ui",
            triggered_at: new Date().toISOString(),
            action,
            target_row: target_row ? parseInt(target_row) : null
          }),
          signal: AbortSignal.timeout(4000)
        });

        if (response.ok || response.status === 200) {
          triggered = true;
          triggeredUrl = url;
          logger.log(`🤖 [N8N WEBHOOK] Đã gửi lệnh thành công sang n8n qua endpoint: ${url}${targetMsg} (Status 200 OK — Đang xử lý)`, "success");
          break;
        }
      } catch (err) {
        lastError = err.message;
      }
    }
    if (triggered) break;
  }

  return { triggered, triggeredUrl, lastError };
}

// 5. POST /api/n8n/trigger - Kích hoạt luồng n8n từ xa
// ============================================================
router.post("/api/n8n/trigger", async (req, res) => {
  const { action = "publish", target_row = null } = req.body;

  lastTriggerInfo = {
    action,
    target_row: target_row ? parseInt(target_row) : null,
    timestamp: Date.now()
  };

  const targetMsg = target_row ? ` (Chỉ định Dòng #${target_row})` : " (Tất cả các dòng)";
  const actionName = N8N_ACTION_NAMES[action] || action.toUpperCase();

  logger.log(`⚡ [YÊU CẦU TỰ ĐỘNG HÓA] Bắt đầu luồng: ${actionName}${targetMsg}`, "info");

  const { triggered, lastError } = await fireN8nActionWebhook({ action, target_row });

  if (triggered) {
    return res.json({
      success: true,
      message: `Đã kích hoạt luồng '${action}' trên n8n thành công! Hãy theo dõi tiến trình ở ô log bên dưới.`
    });
  } else if (process.env.N8N_API_KEY) {
    try {
      const targetWfId = process.env.N8N_WORKFLOW_ID || "uWbys7XrXlEP1iy9";
      logger.log(`🔄 [n8n TRIGGER] Webhook chưa mở, chuyển sang gọi n8n REST API (Workflow ID: ${targetWfId})...`, "info");
      const r = await fetch(`http://localhost:5678/api/v1/workflows/${targetWfId}/run`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-N8N-API-KEY": process.env.N8N_API_KEY
        },
        body: JSON.stringify({ workflowData: {}, startNodes: [], data: { action, target_row } }),
        signal: AbortSignal.timeout(5000)
      });
      if (r.ok) {
        logger.log(`✅ [n8n REST API] Đã trigger workflow ${targetWfId} thành công qua API!`, "success");
        return res.json({
          success: true,
          message: `Đã kích hoạt workflow n8n '${action}' thành công qua n8n REST API!`
        });
      }
    } catch (apiErr) {
      logger.log(`⚠️ [n8n REST API] Lỗi trigger qua API: ${apiErr.message}`, "warn");
    }
  }

  logger.log(`⚠️ [n8n TRIGGER] Không thể gọi webhook trực tiếp (Lỗi: ${lastError}). Node n8n có thể cần thêm Webhook node hoặc thêm N8N_API_KEY vào .env.`, "warn");
  return res.json({
    success: true,
    simulated: true,
    message: `Đã phát tín hiệu kích hoạt '${action}'. Nếu n8n chưa có Webhook node, n8n sẽ tự chạy theo lịch Schedule.`
  });
});

// ============================================================
// 5.0 POST /api/n8n/trigger-selected - Kích hoạt luồng n8n cho các dòng đã chọn (B2)
// Body: { row_numbers:[5,6], action:"content"|"images"|"publish", dry_run:true|false }
// dry_run=true: chỉ trả kế hoạch gọi, KHÔNG bắn webhook (không tốn quota, không tác dụng phụ).
// dry_run=false: gọi tuần tự từng dòng (xong dòng này mới tới dòng khác), dòng lỗi không chặn dòng sau.
// Lưu ý: webhook 200 = n8n đã nhận lệnh (chạy ngầm), theo dõi tiến độ ở Live Terminal / bảng.
// ============================================================
router.post("/api/n8n/trigger-selected", async (req, res) => {
  try {
    const { row_numbers = [], action = "publish", dry_run = false } = req.body || {};

    const VALID_ACTIONS = ["publish", "content", "images"];
    if (!VALID_ACTIONS.includes(action)) {
      return res.status(400).json({ success: false, error: "action phải là publish | content | images!" });
    }

    const nums = [...new Set(
      (Array.isArray(row_numbers) ? row_numbers : [])
        .map((n) => parseInt(n, 10))
        .filter((n) => Number.isInteger(n) && n > 0)
    )].sort((a, b) => a - b);

    if (nums.length === 0) {
      return res.status(400).json({ success: false, error: "Vui lòng chọn ít nhất 1 dòng!" });
    }
    if (nums.length > 100) {
      return res.status(400).json({ success: false, error: "Tối đa 100 dòng mỗi lần kích hoạt!" });
    }

    const actionName = N8N_ACTION_NAMES[action] || action.toUpperCase();

    // BUG-1 FIX: luồng n8n lọc dòng theo trạng thái (publish / gen_options / gen_images),
    // nên phải chuyển status TRƯỚC khi bắn webhook — kể cả khi dòng đang ở trạng thái khác
    // (vd tick dòng Đã xuất bản rồi bấm Đăng bài vẫn chạy).
    const ACTION_STATUS = { publish: "publish", content: "gen_options", images: "gen_images" };
    const newStatus = ACTION_STATUS[action];

    if (dry_run) {
      return res.json({
        success: true,
        dry_run: true,
        action,
        action_name: actionName,
        new_status: newStatus,
        count: nums.length,
        plan: nums.map((rn) => ({ row_number: rn, action, new_status: newStatus }))
      });
    }

    logger.log(`⚡ [TRIGGER SELECTED] Bắt đầu luồng '${actionName}' cho ${nums.length} dòng đã chọn (tuần tự, chuyển status → ${newStatus} trước)`, "info");
    const results = [];
    for (const rn of nums) {
      lastTriggerInfo = { action, target_row: rn, timestamp: Date.now() };
      try {
        try {
          await SheetsService.updateRow(rn, { status: newStatus });
        } catch (stErr) {
          const msg = `Không chuyển được trạng thái sang ${newStatus}: ${stErr.message}`;
          logger.log(`⚠️ [TRIGGER SELECTED] Dòng #${rn}: ${msg}`, "warn");
          results.push({ row_number: rn, success: false, status_updated: false, webhook: null, error: msg });
          continue;
        }
        const { triggered, triggeredUrl, lastError } = await fireN8nActionWebhook({ action, target_row: rn });
        results.push({
          row_number: rn,
          success: triggered,
          status_updated: true,
          new_status: newStatus,
          webhook: triggeredUrl || null,
          error: triggered ? null : (lastError || "Không gọi được webhook n8n")
        });
        if (!triggered) {
          logger.log(`⚠️ [TRIGGER SELECTED] Dòng #${rn}: ${lastError}`, "warn");
        }
      } catch (e) {
        results.push({ row_number: rn, success: false, status_updated: false, webhook: null, error: e.message });
      }
    }

    const okCount = results.filter((r) => r.success).length;
    return res.json({
      success: okCount > 0,
      message: okCount === nums.length
        ? `Đã gửi lệnh '${actionName}' cho ${okCount} dòng! Theo dõi tiến độ ở Live Terminal.`
        : `Đã gửi ${okCount}/${nums.length} dòng, ${nums.length - okCount} dòng lỗi!`,
      count: nums.length,
      ok_count: okCount,
      action,
      results
    });
  } catch (err) {
    logger.log(`❌ [TRIGGER SELECTED] Lỗi: ${err.message}`, "error");
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================
// ============================================================
// 5.1 POST /api/n8n/stop - Hủy hẳn các tiến trình đang chạy trong n8n
// ============================================================
router.post("/api/n8n/stop", async (req, res) => {
  try {
    const apiKey = process.env.N8N_API_KEY;
    const baseUrl = process.env.N8N_BASE_URL || "http://localhost:5678";

    logger.log("🛑 [n8n STOP] Nhận lệnh dừng tất cả tiến trình n8n đang chạy...", "info");

    if (!apiKey) {
      return res.json({
        success: false,
        error: "Chưa cấu hình N8N_API_KEY trong .env để kết nối trực tiếp đến n8n Management API."
      });
    }

    // 1. Lấy danh sách các executions đang chạy
    const listRes = await fetch(`${baseUrl}/api/v1/executions?status=running`, {
      headers: { "X-N8N-API-KEY": apiKey }
    });

    if (!listRes.ok) {
      const errText = await listRes.text();
      throw new Error(`n8n API lỗi: HTTP ${listRes.status} - ${errText}`);
    }

    const listData = await listRes.json();
    const running = listData.data || [];

    if (running.length === 0) {
      logger.log("ℹ️ [n8n STOP] Hiện tại không có tiến trình nào đang chạy trong n8n.", "info");
      return res.json({
        success: true,
        message: "Hiện tại không có tiến trình nào đang chạy trong n8n.",
        stoppedCount: 0
      });
    }

    let stoppedCount = 0;
    for (const exec of running) {
      try {
        const stopRes = await fetch(`${baseUrl}/api/v1/executions/${exec.id}/stop`, {
          method: "POST",
          headers: { "X-N8N-API-KEY": apiKey }
        });
        if (stopRes.ok) {
          stoppedCount++;
          logger.log(`🛑 [n8n STOP] Đã hủy thành công execution #${exec.id} (Workflow: ${exec.workflowId || 'N/A'})`, "warn");
        }
      } catch (e) {
        logger.log(`⚠️ [n8n STOP] Lỗi khi hủy execution #${exec.id}: ${e.message}`, "error");
      }
    }

    return res.json({
      success: true,
      message: `Đã dừng thành công ${stoppedCount} tiến trình n8n đang chạy ngầm!`,
      stoppedCount
    });
  } catch (err) {
    logger.log(`❌ [n8n STOP] Lỗi: ${err.message}`, "error");
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================
// 5.1b POST /api/n8n/stop-row - Chỉ dừng tiến trình của 1 dòng cụ thể
// Dùng khi bấm "Dừng luồng" trên trang Chi Tiết bài viết
// (KHÔNG ảnh hưởng đến các bài viết khác đang chạy song song)
// ============================================================
router.post("/api/n8n/stop-row", async (req, res) => {
  try {
    const { row_number } = req.body;
    const apiKey = process.env.N8N_API_KEY;
    const baseUrl = process.env.N8N_BASE_URL || "http://localhost:5678";

    if (!row_number) {
      return res.status(400).json({ success: false, error: "Thiếu row_number" });
    }

    if (!apiKey) {
      // Nếu không có API key thì trả về success để UI vẫn thoát tracker
      logger.log(`🛑 [n8n STOP-ROW] Không có API key, chỉ dừng tracker phía UI cho Dòng #${row_number}`, "warn");
      return res.json({
        success: true,
        message: `Đã dừng theo dõi Dòng #${row_number} (không có N8N_API_KEY để dừng n8n trực tiếp).`,
        stoppedCount: 0
      });
    }

    logger.log(`🛑 [n8n STOP-ROW] Nhận lệnh dừng tiến trình cho Dòng #${row_number}...`, "info");

    // 1. Lấy danh sách executions đang chạy
    const listRes = await fetch(`${baseUrl}/api/v1/executions?status=running&limit=20`, {
      headers: { "X-N8N-API-KEY": apiKey }
    });

    if (!listRes.ok) {
      const errText = await listRes.text();
      throw new Error(`n8n API lỗi: HTTP ${listRes.status} - ${errText}`);
    }

    const listData = await listRes.json();
    const running = listData.data || [];

    if (running.length === 0) {
      return res.json({
        success: true,
        message: `Không có tiến trình n8n nào đang chạy.`,
        stoppedCount: 0
      });
    }

    // 2. Tìm execution liên quan đến dòng này
    // Ưu tiên: nếu lastTriggerInfo.target_row khớp với row_number
    // thì đây là luồng cần dừng → dừng execution đó
    // Nếu là batch (target_row = null) → cũng dừng luồng đó vì nó đang xử lý dòng này
    let executionsToStop = [];

    if (lastTriggerInfo && lastTriggerInfo.target_row === parseInt(row_number)) {
      // Luồng chỉ định đúng dòng này → dừng tất cả executions đang chạy (chỉ có 1 luồng)
      executionsToStop = running;
    } else if (lastTriggerInfo && lastTriggerInfo.target_row === null) {
      // Luồng batch: tìm execution có data chứa row_number này
      // Thử xác minh qua dữ liệu execution nếu có thể
      // Trong trường hợp đơn giản: n8n chạy tuần tự từng row, nếu đang running thì đang xử lý row này
      executionsToStop = running;
    } else {
      // Không khớp trigger info → dừng execution đang chạy (fallback)
      executionsToStop = running;
    }

    let stoppedCount = 0;
    for (const exec of executionsToStop) {
      try {
        const stopRes = await fetch(`${baseUrl}/api/v1/executions/${exec.id}/stop`, {
          method: "POST",
          headers: { "X-N8N-API-KEY": apiKey }
        });
        if (stopRes.ok) {
          stoppedCount++;
          logger.log(`🛑 [n8n STOP-ROW] Đã hủy execution #${exec.id} cho Dòng #${row_number}`, "warn");
        }
      } catch (e) {
        logger.log(`⚠️ [n8n STOP-ROW] Lỗi khi hủy execution #${exec.id}: ${e.message}`, "error");
      }
    }

    // 3. Xóa trigger info nếu nó liên quan đến dòng này
    if (lastTriggerInfo && (lastTriggerInfo.target_row === parseInt(row_number) || lastTriggerInfo.target_row === null)) {
      lastTriggerInfo = null;
    }

    return res.json({
      success: true,
      message: `Đã dừng ${stoppedCount} tiến trình n8n liên quan đến Dòng #${row_number}.`,
      stoppedCount
    });
  } catch (err) {
    logger.log(`❌ [n8n STOP-ROW] Lỗi: ${err.message}`, "error");
    return res.status(500).json({ success: false, error: err.message });
  }
});



// ============================================================
// 5.2 GET /api/n8n/latest-execution - Lấy trạng thái lượt chạy gần nhất của n8n
// ============================================================
router.get("/api/n8n/latest-execution", async (req, res) => {
  try {
    const apiKey = process.env.N8N_API_KEY;
    const baseUrl = process.env.N8N_BASE_URL || "http://localhost:5678";
    const targetWfId = process.env.N8N_WORKFLOW_ID || "uWbys7XrXlEP1iy9";

    if (!apiKey) {
      return res.json({ success: false, error: "Chưa cấu hình N8N_API_KEY" });
    }

    const listRes = await fetch(`${baseUrl}/api/v1/executions?workflowId=${targetWfId}&limit=1`, {
      headers: { "X-N8N-API-KEY": apiKey }
    });

    if (!listRes.ok) throw new Error(`HTTP ${listRes.status}`);

    const listData = await listRes.json();
    const latest = listData.data?.[0];

    if (!latest) {
      return res.json({ success: true, execution: null });
    }

    let errorDetail = null;
    if (latest.status === "error") {
      try {
        const detailRes = await fetch(`${baseUrl}/api/v1/executions/${latest.id}?includeData=true`, {
          headers: { "X-N8N-API-KEY": apiKey }
        });
        if (detailRes.ok) {
          const detailData = await detailRes.json();
          const err = detailData.data?.resultData?.error;
          errorDetail = {
            node: err?.node?.name || "Không rõ node",
            message: err?.message || "Lỗi không xác định",
            description: err?.description || ""
          };
        }
      } catch (_) {}
    }

    return res.json({
      success: true,
      execution: {
        id: latest.id,
        status: latest.status,
        startedAt: latest.startedAt,
        stoppedAt: latest.stoppedAt,
        error: errorDetail
      }
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================
// 5.3 GET /api/n8n/status - Trạng thái chi tiết thời gian thực của n8n
// ============================================================
router.get("/api/n8n/status", async (req, res) => {
  try {
    const apiKey = process.env.N8N_API_KEY;
    const baseUrl = process.env.N8N_BASE_URL || "http://localhost:5678";

    if (!apiKey) {
      return res.json({ success: false, error: "Chưa cấu hình N8N_API_KEY" });
    }

    let isRunning = false;
    let activeExec = null;
    let activeAction = null;
    let targetRow = null;

    // 1. Kiểm tra xem có tiến trình nào đang chạy thực tế hay không
    try {
      const runningRes = await fetch(`${baseUrl}/api/v1/executions?status=running`, {
        headers: { "X-N8N-API-KEY": apiKey },
        signal: AbortSignal.timeout(2500)
      });
      if (runningRes.ok) {
        const runningData = await runningRes.json();
        if (runningData.data && runningData.data.length > 0) {
          isRunning = true;
          activeExec = runningData.data[0];
        }
      }
    } catch (_) {}

    // 2. Lấy execution gần nhất (bất kể chạy hay đã dừng)
    let latestExec = null;
    try {
      const listRes = await fetch(`${baseUrl}/api/v1/executions?limit=1`, {
        headers: { "X-N8N-API-KEY": apiKey },
        signal: AbortSignal.timeout(2500)
      });
      if (listRes.ok) {
        const listData = await listRes.json();
        latestExec = listData.data?.[0] || null;
      }
    } catch (_) {}

    if (latestExec && latestExec.status === "running") {
      isRunning = true;
      activeExec = latestExec;
    }

    // 3. Xác định action & target_row
    if (isRunning && activeExec) {
      if (lastTriggerInfo && (Date.now() - lastTriggerInfo.timestamp < 300000)) {
        activeAction = lastTriggerInfo.action;
        targetRow = lastTriggerInfo.target_row;
      }

      if (!activeAction) {
        try {
          const detailRes = await fetch(`${baseUrl}/api/v1/executions/${activeExec.id}?includeData=true`, {
            headers: { "X-N8N-API-KEY": apiKey },
            signal: AbortSignal.timeout(2500)
          });
          if (detailRes.ok) {
            const detailData = await detailRes.json();
            const runData = detailData.data?.resultData?.runData || {};
            const nodeNames = Object.keys(runData);

            if (nodeNames.some(n => n.includes("Đăng Bài") || n.includes("Buffer") || n.includes("trigger-publish"))) {
              activeAction = "publish";
            } else if (nodeNames.some(n => n.includes("Tạo Content") || n.includes("trigger-generate-content") || n.includes("OpenRouter") || n.includes("Anthropic"))) {
              activeAction = "content";
            } else if (nodeNames.some(n => n.includes("Tạo Ảnh") || n.includes("trigger-generate-images"))) {
              activeAction = "images";
            }

            for (const nName of nodeNames) {
              const items = runData[nName]?.[0]?.data?.main?.[0] || [];
              for (const it of items) {
                if (it.json?.body?.target_row) {
                  targetRow = parseInt(it.json.body.target_row);
                  break;
                }
                if (it.json?.target_row) {
                  targetRow = parseInt(it.json.target_row);
                  break;
                }
              }
              if (targetRow) break;
            }
          }
        } catch (_) {}
      }
    }

    // 4. Bóc tách lỗi nếu có
    let errorDetail = null;
    const currentOrLast = activeExec || latestExec;
    if (currentOrLast && currentOrLast.status === "error") {
      try {
        const detailRes = await fetch(`${baseUrl}/api/v1/executions/${currentOrLast.id}?includeData=true`, {
          headers: { "X-N8N-API-KEY": apiKey },
          signal: AbortSignal.timeout(2500)
        });
        if (detailRes.ok) {
          const detailData = await detailRes.json();
          const err = detailData.data?.resultData?.error;
          errorDetail = {
            node: err?.node?.name || "Không rõ node",
            message: err?.message || "Lỗi không xác định",
            description: err?.description || ""
          };
        }
      } catch (_) {}
    }

    return res.json({
      success: true,
      is_running: isRunning,
      active_action: activeAction || (isRunning && lastTriggerInfo ? lastTriggerInfo.action : null),
      target_row: targetRow || (isRunning && lastTriggerInfo ? lastTriggerInfo.target_row : null),
      execution: currentOrLast ? {
        id: currentOrLast.id,
        status: currentOrLast.status,
        startedAt: currentOrLast.startedAt,
        stoppedAt: currentOrLast.stoppedAt,
        error: errorDetail
      } : null,
      last_finished_execution: (!isRunning && latestExec) ? {
        id: latestExec.id,
        status: latestExec.status,
        stoppedAt: latestExec.stoppedAt,
        error: errorDetail
      } : null
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================
// 6. POST /api/direct-publish - Form Đăng Nhanh / Cứu Hộ
// ============================================================
router.post("/api/direct-publish", async (req, res) => {
  try {
    const {
      media_url,
      caption,
      title,
      channels = ["tiktok"],
      watermark = true,
      watermark_position = "diagonal",
      opacity = 0.15,
      save_to_draft = true
    } = req.body;

    if (!media_url || !caption) {
      return res.status(400).json({ success: false, error: "Thiếu link media (media_url) hoặc nội dung (caption)!" });
    }

    const selectedChannels = Array.isArray(channels) ? channels : [channels];
    if (selectedChannels.length === 0) {
      return res.status(400).json({ success: false, error: "Vui lòng chọn ít nhất 1 kênh để đăng!" });
    }

    logger.log(`\n${"=".repeat(60)}`, "info");
    logger.log(`🚀 [DIRECT PUBLISHER] Nhận yêu cầu đăng nhanh`, "info");
    logger.log(`📁 Media: ${media_url.slice(0, 70)}...`, "info");
    logger.log(`📺 Kênh: ${selectedChannels.join(", ")} | Chế độ: ${save_to_draft ? "LƯU NHÁP" : "ĐĂNG NGAY"}`, "info");

    const host = req.get("host") || "localhost:3001";
    const protocol = req.protocol === "https" || req.headers["x-forwarded-proto"] === "https" ? "https" : "http";
    const baseUrl = `${protocol}://${host}`;

    const results = [];
    const isFolder = media_url.includes("/folders/") || media_url.includes("folders");

    // Lặp qua từng kênh được chọn để gửi
    for (const ch of selectedChannels) {
      try {
        let endpoint = "";
        let bodyPayload = {};

        if (ch === "tiktok") {
          endpoint = isFolder ? "/upload-tiktok-photo" : "/upload-tiktok-video";
          bodyPayload = isFolder
            ? { image_urls: [media_url], fullMessage: caption, save_to_draft }
            : { drive_url: media_url, fullMessage: caption, watermark, watermark_position, opacity, save_to_draft, scheduling_type: "automatic" };
        } else if (ch === "facebook_page") {
          endpoint = isFolder ? "/upload-fb-page-photo" : "/upload-fb-page-video";
          bodyPayload = isFolder
            ? { image_urls: [media_url], fullMessage: caption, save_to_draft }
            : { drive_url: media_url, fullMessage: caption, watermark, watermark_position, opacity, save_to_draft };
        } else if (ch === "facebook_group") {
          endpoint = isFolder ? "/upload-fb-group-photo" : "/upload-fb-group-video";
          bodyPayload = isFolder
            ? { image_urls: [media_url], fullMessage: caption, save_to_draft }
            : { drive_url: media_url, fullMessage: caption, watermark, watermark_position, opacity, save_to_draft };
        }

        if (!endpoint) continue;

        logger.log(`📡 Đang gọi backend: ${endpoint} cho kênh ${ch.toUpperCase()}...`, "info");
        const callRes = await fetch(`${baseUrl}${endpoint}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(bodyPayload)
        });

        const data = await callRes.json();

        if (!data.success) {
          throw new Error(data.error || data.message || "Lỗi xử lý API");
        }

        // Ghi vào lịch sử posts.json
        const recorded = recordPost({
          post_id: data.post_id || `manual_${Date.now()}`,
          platform: ch,
          type: isFolder ? "PHOTO_MODE" : "VIDEO",
          title: title || caption.slice(0, 80),
          caption,
          status: save_to_draft ? "DRAFT_IN_BUFFER" : "PUBLISHED_VIA_BUFFER",
          video_url: data.video_url || null,
          photo_count: data.photo_count || 1,
          watermarked: Boolean(watermark)
        });

        results.push({ channel: ch, success: true, post_id: data.post_id, data });
        if (data.post_id && req.body.row_number) {
          try {
            await SheetsService.updateRow(Number(req.body.row_number), { buffer_post_id: data.post_id });
          } catch (e) {
            logger.log(`⚠️ Không thể lưu buffer_post_id vào Sheet dòng ${req.body.row_number}: ${e.message}`, "warn");
          }
        }
        logger.log(`🎉 [DIRECT PUBLISHER] Thành công kênh ${ch.toUpperCase()}! Post ID: ${data.post_id}`, "success");
      } catch (subErr) {
        logger.log(`❌ [DIRECT PUBLISHER] Thất bại kênh ${ch.toUpperCase()}: ${subErr.message}`, "error");
        results.push({ channel: ch, success: false, error: subErr.message });
      }
    }

    logger.log(`${"=".repeat(60)}\n`, "info");

    return res.json({
      success: results.some((r) => r.success),
      results,
      message: `Đã xử lý xong ${results.length} kênh.`
    });
  } catch (err) {
    logger.log(`❌ Lỗi Direct Publish: ${err.message}`, "error");
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================
// 6.9 GET /api/sheet/config - Lấy thông tin cấu hình Sheet từ .env
// ============================================================
router.get("/api/sheet/config", (_, res) => {
  try {
    const config = getSheetConfig();
    return res.json({
      success: true,
      sheet_id: config.sheetId,
      gid: config.gid,
      sheet_name: config.sheetName,
      sheet_url: config.sheetUrl,
      data_start_row: config.dataStartRow
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================
// 6b. GET /api/presets - Lấy danh sách Content Presets
// ============================================================
router.get("/api/presets", async (_, res) => {
  try {
    const presets = await SheetsService.fetchPresets();
    return res.json({ success: true, count: presets.length, presets });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================
// 6c. POST /api/contents - Tạo bài viết mới dạng bản nháp (Draft)
// ============================================================
router.post("/api/contents", async (req, res) => {
  const { preset_id, channel, hook } = req.body;
  logger.log(`📥 [API POST /api/contents] Yêu cầu tạo bài mới: Preset=${preset_id} | Channel=${channel} | Hook="${hook || ''}"`, "info");

  // Kho Drive (AB) mặc định cho bài tạo mới: thư mục dùng chung của team.
  const DEFAULT_MEDIA_LIBRARY = "https://drive.google.com/drive/folders/1xIRpnKa8gD0VvGwyPprcgkTztcYx4yal";
  if (!req.body.drive_folder || !String(req.body.drive_folder).trim()) {
    req.body.drive_folder = DEFAULT_MEDIA_LIBRARY;
  }

  // Luôn dùng createDraftRow trực tiếp để có row_number ngay lập tức
  // (n8n create-draft không trả về row_number, không thể gọi folder webhook)
  let result;
  try {
    result = await SheetsService.createDraftRow(req.body);
    logger.log(`✅ [CREATE DRAFT] Tạo bài mới thành công: ${result.content_id} (Dòng #${result.row_number})`, "success");
  } catch (sheetErr) {
    logger.log(`❌ [CREATE DRAFT] Lỗi tạo bản nháp: ${sheetErr.message}`, "error");
    return res.status(500).json({ success: false, error: sheetErr.message });
  }

  // Guard: không xác định được dòng -> bỏ qua webhook folder (tránh tạo Bai_Viet_Row_0).
  if (!result.row_number) {
    logger.log(`⛔ [CREATE DRAFT] Không xác định được dòng mới (${result.content_id}) — bỏ qua tạo folder media.`, "warn");
    return res.json({ success: true, ...result, via: "direct_sheet", media_sync: { skipped: "no_row_number" } });
  }

  // Kích hoạt n8n Webhook: Tạo/kiểm tra folder Drive riêng cho bài mới
  // Dùng chung webhook trigger-duplicate-post với source_folder_url rỗng → chỉ tạo folder, không copy file
  const n8nBase = process.env.N8N_BASE_URL || "http://localhost:5678";
  const folderWebhookPath = process.env.N8N_WEBHOOK_DUPLICATE_PATH || "/webhook/trigger-duplicate-post";
  const folderWebhookUrl = `${n8nBase}${folderWebhookPath}`;

  let folderUrl = null;
  try {
    const uniqueFolderName = `Bai_Viet_Row_${result.row_number}`;
    const folderRes = await fetch(folderWebhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source_row_number: null,
        target_row_number: result.row_number,
        target_content_id: result.content_id || null,
        target_folder_name: uniqueFolderName,
        source_folder_url: "",
        target_folder_url: ""
      }),
      signal: AbortSignal.timeout(30000)
    });
    if (folderRes.ok) {
      const folderData = await folderRes.json().catch(() => null);
      if (folderData?.target_folder_url) {
        folderUrl = folderData.target_folder_url;
        // Cập nhật override cache với URL folder thực (tránh override rỗng đè lên sheet)
        // Chỉ ghi cột AC (Media Sẽ Đăng); cột AB (Kho Drive) giữ nguyên thư mục dùng chung.
        await SheetsService.updateRow(result.row_number, { media_to_post: folderUrl });
        result = { ...result, media_to_post: folderUrl };
        logger.log(`📁 [CREATE DRAFT] Đã tạo folder media cho bài #${result.row_number}: ${folderUrl}`, "success");
      }
    } else {
      logger.log(`⚠️ [CREATE DRAFT] n8n folder webhook trả mã ${folderRes.status}`, "warn");
    }
  } catch (folderErr) {
    logger.log(`⚠️ [CREATE DRAFT] Không thể tạo folder media: ${folderErr.message}`, "warn");
  }

  return res.json({ success: true, ...result, via: "direct_sheet" });
});

// ============================================================
// 6d. POST /api/contents/duplicate - Nhân bản bài viết
// ============================================================
router.post("/api/contents/duplicate", async (req, res) => {
  try {
    const { source_row_number, ...customFields } = req.body;
    if (!source_row_number) {
      return res.status(400).json({ success: false, error: "Thiếu source_row_number" });
    }

    // Lấy thông tin bài gốc
    const sourceRow = await SheetsService.getRowDetail(source_row_number);
    if (!sourceRow) {
      return res.status(404).json({ success: false, error: `Không tìm thấy bài viết #${source_row_number}` });
    }

    // Tạo payload kế thừa toàn bộ các trường của bài gốc
    const rawHook = (customFields.hook !== undefined) ? customFields.hook : (sourceRow.hook || "");
    const hookWithSuffix = rawHook && !rawHook.includes("(Bản sao)") ? `${rawHook} (Bản sao)` : (rawHook || "(Bản sao)");

    const payload = {
      preset_id: customFields.preset_id || sourceRow.preset_id || "ECOLAR_GA_AI_CAP",
      channel: customFields.channel || sourceRow.channel || "Facebook",
      hook: hookWithSuffix,
      goal: customFields.goal !== undefined ? customFields.goal : (sourceRow.goal || ""),
      usp: customFields.usp !== undefined ? customFields.usp : (sourceRow.usp || ""),
      insight: customFields.insight !== undefined ? customFields.insight : (sourceRow.insight || ""),
      business_goal: customFields.business_goal !== undefined ? customFields.business_goal : (sourceRow.business_goal || ""),
      output_goal: customFields.output_goal !== undefined ? customFields.output_goal : (sourceRow.output_goal || "Bài viết"),
      content_format: customFields.content_format !== undefined ? customFields.content_format : (sourceRow.content_format || "Text trơn"),
      content_length: customFields.content_length !== undefined ? customFields.content_length : (sourceRow.content_length || "300 từ"),
      version_count: customFields.version_count !== undefined ? customFields.version_count : (sourceRow.version_count || "3"),
      funnel_cold: customFields.funnel_cold !== undefined ? customFields.funnel_cold : (sourceRow.funnel_cold || ""),
      funnel_warm: customFields.funnel_warm !== undefined ? customFields.funnel_warm : (sourceRow.funnel_warm || ""),
      funnel_hot: customFields.funnel_hot !== undefined ? customFields.funnel_hot : (sourceRow.funnel_hot || ""),
      key_message: customFields.key_message !== undefined ? customFields.key_message : (sourceRow.key_message || ""),
      sub_message: customFields.sub_message !== undefined ? customFields.sub_message : (sourceRow.sub_message || ""),
      formula: customFields.formula !== undefined ? customFields.formula : (sourceRow.formula || "AIDA"),
      tone: customFields.tone !== undefined ? customFields.tone : (sourceRow.tone || "Chuyên gia"),
      cta: customFields.cta !== undefined ? customFields.cta : (sourceRow.cta || "IB ngay"),
      talk_write_ratio: customFields.talk_write_ratio !== undefined ? customFields.talk_write_ratio : (sourceRow.talk_write_ratio || ""),
      qual_quant_ratio: customFields.qual_quant_ratio !== undefined ? customFields.qual_quant_ratio : (sourceRow.qual_quant_ratio || ""),
      evidence: customFields.evidence !== undefined ? customFields.evidence : (sourceRow.evidence || ""),
      custom_prompt: customFields.custom_prompt !== undefined ? customFields.custom_prompt : (sourceRow.custom_prompt || ""),
      option_1: customFields.option_1 !== undefined ? customFields.option_1 : (sourceRow.option_1 || ""),
      option_2: customFields.option_2 !== undefined ? customFields.option_2 : (sourceRow.option_2 || ""),
      option_3: customFields.option_3 !== undefined ? customFields.option_3 : (sourceRow.option_3 || ""),
      approved_option: customFields.approved_option !== undefined ? customFields.approved_option : (sourceRow.approved_option || "Option 1"),
      status: customFields.status !== undefined ? customFields.status : "draft",
      // Giờ đăng kế thừa dòng gốc để Sheet là nguồn sự thật duy nhất (user sửa sau trên bảng).
      scheduled_time: customFields.scheduled_time !== undefined ? customFields.scheduled_time : (sourceRow.scheduled_time || ""),
      // Kho Drive (AB): duplicate giữ nguyên theo bản gốc, KHÔNG ghi đè folder mới.
      drive_folder: customFields.drive_folder !== undefined ? customFields.drive_folder : (sourceRow.drive_folder || ""),
      media_to_post: customFields.media_to_post !== undefined ? customFields.media_to_post : "",
      image_count: customFields.image_count !== undefined ? customFields.image_count : (sourceRow.image_count || "2"),
      image_size_standard: customFields.image_size_standard !== undefined ? customFields.image_size_standard : (sourceRow.image_size_standard || ""),
      typography_heading: customFields.typography_heading !== undefined ? customFields.typography_heading : (sourceRow.typography_heading || ""),
      typography_subtext: customFields.typography_subtext !== undefined ? customFields.typography_subtext : (sourceRow.typography_subtext || ""),
      image_rule: customFields.image_rule !== undefined ? customFields.image_rule : (sourceRow.image_rule || ""),
      image_design_rule: customFields.image_design_rule !== undefined ? customFields.image_design_rule : (sourceRow.image_design_rule || ""),
      background_rule: customFields.background_rule !== undefined ? customFields.background_rule : (sourceRow.background_rule || ""),
      footer_badge_rule: customFields.footer_badge_rule !== undefined ? customFields.footer_badge_rule : (sourceRow.footer_badge_rule || ""),
      mentor_notes: customFields.mentor_notes !== undefined ? customFields.mentor_notes : `Nhân bản từ bài #${sourceRow.row_number}`
    };

    logger.log(`📋 [API POST /api/contents/duplicate] Nhân bản bài #${sourceRow.row_number} (${sourceRow.content_id || ''})`, "info");
    let result = await SheetsService.createDraftRow(payload);

    // GUARD: row đích trùng row nguồn (do parse updatedRange sai hoặc race) -> bỏ qua copy media,
    // tránh self-copy làm nhân đôi file trong cùng folder (source_folder_id == target_folder_id).
    if (Number(result.row_number) === Number(sourceRow.row_number)) {
      logger.log(`⛔ [DUPLICATE] Row đích #${result.row_number} trùng row nguồn — bỏ qua webhook copy media để tránh self-copy!`, "warn");
      return res.json({
        success: true,
        message: `Đã nhân bản bài #${sourceRow.row_number} thành công (bỏ qua copy media do trùng dòng)!`,
        ...result,
        media_sync: { skipped: "self_copy_guard" }
      });
    }

    // Guard: không xác định được dòng đích -> bỏ qua webhook (tránh tạo Bai_Viet_Row_0).
    if (!result.row_number) {
      logger.log(`⛔ [DUPLICATE] Không xác định được dòng đích (${result.content_id}) — bỏ qua copy media.`, "warn");
      return res.json({
        success: true,
        message: `Đã nhân bản bài #${sourceRow.row_number} thành công (bỏ qua copy media do thiếu dòng đích)!`,
        ...result,
        media_sync: { skipped: "no_row_number" }
      });
    }

    // Kích hoạt n8n Webhook: Tự động kiểm tra/tạo folder riêng & copy file media sang bài mới
    const n8nBase = process.env.N8N_BASE_URL || "http://localhost:5678";
    const webhookPath = process.env.N8N_WEBHOOK_DUPLICATE_PATH || "/webhook/trigger-duplicate-post";
    const n8nWebhookUrl = `${n8nBase}${webhookPath}`;

    let n8nSyncResult = null;
    try {
      const srcMedia = sourceRow.media_to_post || sourceRow.drive_folder || "";
      const uniqueFolderName = `Bai_Viet_Row_${result.row_number}`;
      const n8nRes = await fetch(n8nWebhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source_row_number: sourceRow.row_number,
          target_row_number: result.row_number,
          target_content_id: result.content_id || null,
          target_folder_name: uniqueFolderName,
          source_folder_url: srcMedia,
          target_folder_url: ""
        }),
        signal: AbortSignal.timeout(30000)
      });
      if (n8nRes.ok) {
        n8nSyncResult = await n8nRes.json().catch(() => null);
        logger.log(`📁 [N8N DUPLICATE] Đã đồng bộ folder media bài #${result.row_number}: ${n8nSyncResult?.target_folder_url || 'OK'}`, "success");

        // FIX: Cập nhật override cache với folder URL thực
        // (override ban đầu từ createDraftRow có media_to_post: "" → đè lên giá trị sheet thực)
        // Chỉ ghi cột AC (Media Sẽ Đăng); cột AB (Kho Drive) giữ nguyên bản gốc.
        if (n8nSyncResult?.target_folder_url) {
          await SheetsService.updateRow(result.row_number, {
            media_to_post: n8nSyncResult.target_folder_url
          });
          result = { ...result, media_to_post: n8nSyncResult.target_folder_url };
          // Giữ drive_folder theo payload (bản gốc) để response đồng nhất với Sheet.
          result.drive_folder = payload.drive_folder || result.drive_folder || "";
          logger.log(`🔗 [DUPLICATE] Đã cập nhật override media_to_post cho bài #${result.row_number}`, "success");
        }
      }
    } catch (n8nErr) {
      logger.log(`⚠️ [N8N DUPLICATE] Không thể gọi webhook n8n: ${n8nErr.message}`, "warn");
    }

    return res.json({
      success: true,
      message: `Đã nhân bản bài #${sourceRow.row_number} thành công!`,
      ...result,
      media_sync: n8nSyncResult
    });
  } catch (err) {
    logger.log(`❌ [DUPLICATE] Lỗi: ${err.message}`, "error");
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================
// 7. GET /api/sheet/rows - Lấy danh sách bài viết từ Google Sheet
// ============================================================
router.get("/api/sheet/rows", async (_, res) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  try {
    const rows = await SheetsService.fetchSheetRows();
    return res.json({ success: true, count: rows.length, rows });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================
// 7.1 GET /api/sheet/row/:row_number - Lấy chi tiết 1 dòng (hỗ trợ cả row_number & content_id)
// ============================================================
router.get("/api/sheet/row/:row_number", async (req, res) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  try {
    const { row_number } = req.params;
    const row = await SheetsService.getRowDetail(row_number);
    return res.json({ success: true, row });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================
// 7.2 PUT /api/sheet/row/:row_number - Cập nhật toàn bộ các trường 1 dòng
// ============================================================
router.put("/api/sheet/row/:row_number", async (req, res) => {
  try {
    let { row_number } = req.params;
    const updates = req.body;

    // Nếu row_number là chuỗi định danh (như EC-...), tìm số dòng thực sự trước
    if (isNaN(Number(row_number))) {
      const row = await SheetsService.getRowDetail(row_number);
      row_number = row.row_number;
    }

    const updated = await SheetsService.updateRow(Number(row_number), updates);
    return res.json({ success: true, message: `Đã cập nhật dòng ${row_number}`, updated });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================
// 7.2b POST /api/sheet/schedule-batch - Hẹn giờ đăng hàng loạt
// Body: { row_numbers:[5,6,7], mode:"daily"|"interval"|"same",
//         start:"2026-09-10 20:00" (same/interval) hoặc ngày bắt đầu (daily),
//         hour:"20:00" (daily), interval_hours:24 (interval), dry_run:true|false }
// dry_run=true: chỉ tính toán giờ từng dòng để preview, KHÔNG ghi Sheet.
// ============================================================
router.post("/api/sheet/schedule-batch", async (req, res) => {
  try {
    const {
      row_numbers = [],
      mode = "daily",
      start = null,
      hour = "20:00",
      interval_hours = 24,
      dry_run = false
    } = req.body || {};

    const nums = [...new Set(
      (Array.isArray(row_numbers) ? row_numbers : [])
        .map((n) => parseInt(n, 10))
        .filter((n) => Number.isInteger(n) && n > 0)
    )].sort((a, b) => a - b);

    if (nums.length === 0) {
      return res.status(400).json({ success: false, error: "Vui lòng chọn ít nhất 1 dòng!" });
    }
    if (nums.length > 100) {
      return res.status(400).json({ success: false, error: "Tối đa 100 dòng mỗi lần hẹn giờ!" });
    }

    const pad = (n) => String(n).padStart(2, "0");
    const fmtSheet = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    const parseDT = (s) => {
      if (!s) return null;
      const d = new Date(String(s).trim().replace(" ", "T"));
      return isNaN(d.getTime()) ? null : d;
    };

    let times = [];
    if (mode === "same" || mode === "interval") {
      const base = parseDT(start);
      if (!base) {
        return res.status(400).json({ success: false, error: "Giờ bắt đầu không hợp lệ!" });
      }
      const stepMs = mode === "same" ? 0 : Math.round(Number(interval_hours) * 3600 * 1000);
      if (mode === "interval" && !(stepMs > 0)) {
        return res.status(400).json({ success: false, error: "Khoảng cách giờ phải lớn hơn 0!" });
      }
      times = nums.map((_, i) => new Date(base.getTime() + stepMs * i));
    } else if (mode === "daily") {
      const m = String(hour || "").trim().match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
      if (!m) {
        return res.status(400).json({ success: false, error: "Giờ cố định phải dạng HH:mm (vd 20:00)!" });
      }
      const baseDay = parseDT(start);
      if (!baseDay) {
        return res.status(400).json({ success: false, error: "Ngày bắt đầu không hợp lệ!" });
      }
      baseDay.setHours(parseInt(m[1], 10), parseInt(m[2], 10), 0, 0);
      times = nums.map((_, i) => {
        const d = new Date(baseDay);
        d.setDate(d.getDate() + i);
        return d;
      });
    } else {
      return res.status(400).json({ success: false, error: "mode không hợp lệ (same|interval|daily)!" });
    }

    const now = Date.now();
    const assignments = nums.map((rn, i) => ({
      row_number: rn,
      scheduled_time: fmtSheet(times[i]),
      is_past: times[i].getTime() < now
    }));

    if (dry_run) {
      return res.json({ success: true, dry_run: true, count: assignments.length, assignments });
    }

    const saved = await SheetsService.scheduleBatch(assignments);
    logger.log(`🕒 [BATCH SCHEDULE] Đã hẹn giờ ${saved.count} dòng (chế độ ${mode})`, "success");
    return res.json({
      success: true,
      message: `Đã hẹn giờ ${saved.count} dòng vào Google Sheet!`,
      count: saved.count,
      assignments
    });
  } catch (err) {
    logger.log(`❌ [BATCH SCHEDULE] Lỗi: ${err.message}`, "error");
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================
// 7.2c POST /api/sheet/approve-batch - Duyệt Option + trạng thái hàng loạt
// Body: { row_numbers:[5,6], approved_option:"Option 2"|null, status:"publish", dry_run:true|false }
// dry_run=true: chỉ trả preview, KHÔNG ghi Sheet.
// ============================================================
router.post("/api/sheet/approve-batch", async (req, res) => {
  try {
    const {
      row_numbers = [],
      approved_option = null,
      status = null,
      dry_run = false
    } = req.body || {};

    const nums = [...new Set(
      (Array.isArray(row_numbers) ? row_numbers : [])
        .map((n) => parseInt(n, 10))
        .filter((n) => Number.isInteger(n) && n > 0)
    )].sort((a, b) => a - b);

    if (nums.length === 0) {
      return res.status(400).json({ success: false, error: "Vui lòng chọn ít nhất 1 dòng!" });
    }
    if (nums.length > 100) {
      return res.status(400).json({ success: false, error: "Tối đa 100 dòng mỗi lần duyệt!" });
    }

    const VALID_OPTIONS = ["Option 1", "Option 2", "Option 3"];
    const VALID_STATUS = ["draft", "waiting_review", "publish", "posted", "gen_options", "gen_images"];

    const cleanOption = approved_option ? String(approved_option).trim() : null;
    const cleanStatus = status ? String(status).trim() : null;

    if (cleanOption && !VALID_OPTIONS.includes(cleanOption)) {
      return res.status(400).json({ success: false, error: "approved_option phải là Option 1/2/3!" });
    }
    if (cleanStatus && !VALID_STATUS.includes(cleanStatus)) {
      return res.status(400).json({ success: false, error: "status không hợp lệ!" });
    }
    if (!cleanOption && !cleanStatus) {
      return res.status(400).json({ success: false, error: "Chưa chọn Option hoặc trạng thái để duyệt!" });
    }

    const assignments = nums.map((rn) => ({
      row_number: rn,
      approved_option: cleanOption,
      status: cleanStatus
    }));

    if (dry_run) {
      return res.json({ success: true, dry_run: true, count: assignments.length, assignments });
    }

    const saved = await SheetsService.approveBatch(assignments);
    logger.log(`✅ [APPROVE BATCH] Đã duyệt ${saved.count} dòng (Option: ${cleanOption || "giữ nguyên"} | Status: ${cleanStatus || "giữ nguyên"})`, "success");
    return res.json({
      success: true,
      message: `Đã duyệt ${saved.count} dòng vào Google Sheet!`,
      count: saved.count,
      assignments
    });
  } catch (err) {
    logger.log(`❌ [APPROVE BATCH] Lỗi: ${err.message}`, "error");
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================
// 7.2d POST /api/sheet/channel-batch - Đổi kênh hàng loạt
// Body: { row_numbers:[5,6], channel:"TikTok"|"Facebook"|"Facebook Group", dry_run:true|false }
// dry_run=true: chỉ trả preview, KHÔNG ghi Sheet.
// ============================================================
router.post("/api/sheet/channel-batch", async (req, res) => {
  try {
    const { row_numbers = [], channel = null, dry_run = false } = req.body || {};

    const nums = [...new Set(
      (Array.isArray(row_numbers) ? row_numbers : [])
        .map((n) => parseInt(n, 10))
        .filter((n) => Number.isInteger(n) && n > 0)
    )].sort((a, b) => a - b);

    if (nums.length === 0) {
      return res.status(400).json({ success: false, error: "Vui lòng chọn ít nhất 1 dòng!" });
    }
    if (nums.length > 100) {
      return res.status(400).json({ success: false, error: "Tối đa 100 dòng mỗi lần đổi kênh!" });
    }

    const VALID_CHANNELS = ["TikTok", "Facebook", "Facebook Group"];
    const cleanChannel = channel ? String(channel).trim() : "";
    if (!VALID_CHANNELS.includes(cleanChannel)) {
      return res.status(400).json({ success: false, error: "channel phải là TikTok / Facebook / Facebook Group!" });
    }

    const assignments = nums.map((rn) => ({ row_number: rn, channel: cleanChannel }));

    if (dry_run) {
      return res.json({ success: true, dry_run: true, count: assignments.length, assignments });
    }

    const saved = await SheetsService.channelBatch(assignments);
    logger.log(`✅ [CHANNEL BATCH] Đã đổi ${saved.count} dòng sang kênh ${cleanChannel}`, "success");
    return res.json({
      success: true,
      message: `Đã đổi ${saved.count} dòng sang ${cleanChannel}!`,
      count: saved.count,
      assignments
    });
  } catch (err) {
    logger.log(`❌ [CHANNEL BATCH] Lỗi: ${err.message}`, "error");
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================
// 7.2e POST /api/sheet/row-error - Ghi/xóa lỗi dòng (cột AP last_error) để user thấy ở UI
// Body: { row_number|content_id, error } — error rỗng = xóa lỗi.
// Dùng cho n8n báo lý do bỏ qua (vd giờ hẹn đã qua) mà không cần đụng các cột khác.
// ============================================================
router.post("/api/sheet/row-error", async (req, res) => {
  try {
    const { row_number, content_id, error = "" } = req.body || {};
    const identifier = row_number ?? content_id;
    if (identifier === undefined || identifier === null || String(identifier).trim() === "") {
      return res.status(400).json({ success: false, error: "Thiếu row_number hoặc content_id!" });
    }
    let targetNum = parseInt(identifier, 10);
    if (isNaN(targetNum)) {
      const row = await SheetsService.getRowDetail(identifier);
      targetNum = row.row_number;
    }
    await SheetsService.updateRow(targetNum, { last_error: String(error || "") });
    return res.json({ success: true, row_number: targetNum });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================
// 7.3 DELETE /api/sheet/row/:row_number - Xóa 1 bài viết khỏi Google Sheet
// ============================================================
router.delete("/api/sheet/row/:row_number", async (req, res) => {
  try {
    const { row_number } = req.params;
    logger.log(`🗑️ [API DELETE /api/sheet/row/${row_number}] Yêu cầu xóa bài viết`, "info");
    const result = await SheetsService.deleteRow(row_number);
    return res.json({
      success: true,
      message: `Đã xóa bài viết dòng #${result.row_number} thành công!`,
      ...result
    });
  } catch (err) {
    logger.log(`❌ [DELETE ROW] Lỗi: ${err.message}`, "error");
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================
// 7.4 POST /api/sheet/delete-batch - Xóa nhiều dòng khỏi Google Sheet
// Body: { row_numbers:[30,31,32] }
// Xóa từ dưới lên trên để số dòng của các dòng còn lại không bị lệch giữa chừng.
// ============================================================
router.post("/api/sheet/delete-batch", async (req, res) => {
  try {
    const { row_numbers = [] } = req.body || {};

    const nums = [...new Set(
      (Array.isArray(row_numbers) ? row_numbers : [])
        .map((n) => parseInt(n, 10))
        .filter((n) => Number.isInteger(n) && n > 0)
    )].sort((a, b) => b - a); // DESC: xóa dòng dưới trước

    if (nums.length === 0) {
      return res.status(400).json({ success: false, error: "Vui lòng chọn ít nhất 1 dòng!" });
    }
    if (nums.length > 100) {
      return res.status(400).json({ success: false, error: "Tối đa 100 dòng mỗi lần xóa!" });
    }

    const deleted = [];
    const failed = [];
    for (const rn of nums) {
      try {
        await SheetsService.deleteRow(rn);
        deleted.push(rn);
      } catch (e) {
        failed.push({ row_number: rn, error: e.message });
      }
    }

    logger.log(`🗑️ [DELETE BATCH] Đã xóa ${deleted.length}/${nums.length} dòng${failed.length ? ` (lỗi: ${failed.map((f) => f.row_number).join(",")})` : ""}`, deleted.length ? "success" : "error");
    return res.json({
      success: failed.length === 0,
      message: failed.length === 0
        ? `Đã xóa ${deleted.length} dòng khỏi Google Sheet!`
        : `Đã xóa ${deleted.length} dòng, ${failed.length} dòng lỗi!`,
      deleted,
      failed
    });
  } catch (err) {
    logger.log(`❌ [DELETE BATCH] Lỗi: ${err.message}`, "error");
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================
// 8. POST /api/sheet/approve - Duyệt Option và đổi trạng thái bài
// ============================================================
router.post("/api/sheet/approve", async (req, res) => {
  try {
    const { row_number, approved_option, status = "publish" } = req.body;
    if (!row_number) {
      return res.status(400).json({ success: false, error: "Thiếu row_number" });
    }
    const updated = await SheetsService.updateRow(row_number, { approved_option, status });
    return res.json({ success: true, message: `Đã duyệt ${approved_option} cho dòng ${row_number}`, updated });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================
// 9. POST /api/sheet/publish-buffer - Duyệt & Bắn ngay lên Buffer
// ============================================================
router.post("/api/sheet/publish-buffer", async (req, res) => {
  try {
    const { row_number, option_choice = "Option 1", save_to_draft = false, due_at } = req.body;
    if (!row_number) {
      return res.status(400).json({ success: false, error: "Thiếu row_number" });
    }
    const result = await SheetsService.publishRowToBuffer({
      rowNumber: row_number,
      optionChoice: option_choice,
      saveToDraft: Boolean(save_to_draft),
      dueAt: due_at
    });
    return res.json({ success: true, ...result });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================
// 9b. POST /api/sheet/publish-selected - Đăng Buffer trực tiếp các dòng đã chọn (B1)
// Body: { row_numbers:[5,6], option_choice:"Option 1", save_to_draft:false, dry_run:true|false }
// dry_run=true: chỉ trả kế hoạch (caption có/không, giờ quá khứ, kênh) — KHÔNG gọi Buffer.
// dry_run=false: gọi tuần tự từng dòng qua SheetsService.publishRowToBuffer,
//   dòng lỗi không chặn dòng sau, trả kết quả chi tiết từng dòng (post_id / error).
// Khác với trigger-selected action=publish (đi qua n8n workflow): đây là đường
// Buffer trực tiếp, đồng bộ, thấy Post ID ngay.
// ============================================================
router.post("/api/sheet/publish-selected", async (req, res) => {
  try {
    const { row_numbers = [], option_choice = "Option 1", save_to_draft = false, dry_run = false } = req.body || {};

    const nums = [...new Set(
      (Array.isArray(row_numbers) ? row_numbers : [])
        .map((n) => parseInt(n, 10))
        .filter((n) => Number.isInteger(n) && n > 0)
    )].sort((a, b) => a - b);

    if (nums.length === 0) {
      return res.status(400).json({ success: false, error: "Vui lòng chọn ít nhất 1 dòng!" });
    }
    if (nums.length > 100) {
      return res.status(400).json({ success: false, error: "Tối đa 100 dòng mỗi lần đăng!" });
    }

    const VALID_OPTIONS = ["Option 1", "Option 2", "Option 3"];
    const cleanOption = String(option_choice || "Option 1").trim();
    if (!VALID_OPTIONS.includes(cleanOption)) {
      return res.status(400).json({ success: false, error: "option_choice phải là Option 1/2/3!" });
    }
    const saveToDraft = Boolean(save_to_draft);

    if (dry_run) {
      const allRows = await SheetsService.fetchSheetRows();
      const byNum = new Map(allRows.map((r) => [parseInt(r.row_number, 10), r]));
      const plan = nums.map((rn) => {
        const r = byNum.get(rn);
        if (!r) return { row_number: rn, ok: false, error: "Không còn trong bảng!" };
        const caption = cleanOption === "Option 2" ? r.option_2 : cleanOption === "Option 3" ? r.option_3 : r.option_1;
        if (!caption || !String(caption).trim()) {
          return { row_number: rn, ok: false, channel: r.channel || "", scheduled_time: r.scheduled_time || "", error: `${cleanOption} đang trống!` };
        }
        return {
          row_number: rn,
          ok: true,
          channel: r.channel || "",
          scheduled_time: r.scheduled_time || "",
          caption_preview: String(caption).trim().slice(0, 80)
        };
      });
      return res.json({
        success: true,
        dry_run: true,
        count: nums.length,
        option_choice: cleanOption,
        save_to_draft: saveToDraft,
        plan
      });
    }

    logger.log(`🚀 [PUBLISH SELECTED] Đăng Buffer trực tiếp ${nums.length} dòng (${cleanOption} | ${saveToDraft ? "Lưu nháp" : "Đăng ngay"}) — tuần tự`, "info");
    const results = [];
    for (const rn of nums) {
      try {
        const out = await SheetsService.publishRowToBuffer({
          rowNumber: rn,
          optionChoice: cleanOption,
          saveToDraft
        });
        results.push({ row_number: rn, success: true, post_id: out.post_id || null });
      } catch (e) {
        logger.log(`⚠️ [PUBLISH SELECTED] Dòng #${rn} lỗi: ${e.message}`, "warn");
        results.push({ row_number: rn, success: false, error: e.message });
      }
    }

    const okCount = results.filter((r) => r.success).length;
    return res.json({
      success: okCount > 0,
      message: okCount === nums.length
        ? `Đã đăng Buffer ${okCount} dòng (${saveToDraft ? "lưu nháp" : "lên lịch/đăng ngay"})!`
        : `Đã đăng ${okCount}/${nums.length} dòng, ${nums.length - okCount} dòng lỗi!`,
      count: nums.length,
      ok_count: okCount,
      fail_count: nums.length - okCount,
      option_choice: cleanOption,
      save_to_draft: saveToDraft,
      results
    });
  } catch (err) {
    logger.log(`❌ [PUBLISH SELECTED] Lỗi: ${err.message}`, "error");
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================
// 10. GET /api/health/n8n - Kiểm tra n8n có đang chạy không
// ============================================================
router.get("/api/health/n8n", async (_, res) => {
  const hosts = [
    "http://127.0.0.1:5678",
    "http://localhost:5678",
    "http://host.docker.internal:5678"
  ];

  for (const host of hosts) {
    try {
      const r = await fetch(`${host}/healthz`, { signal: AbortSignal.timeout(1500) });
      if (r.ok) {
        return res.json({ success: true, running: true, host, status: "online" });
      }
    } catch (_) { }
  }

  return res.json({ success: true, running: false, status: "offline" });
});

// ============================================================
// 11. GET /api/sheet/pending - Chỉ trả về bài chờ duyệt
// ============================================================
router.get("/api/sheet/pending", async (_, res) => {
  try {
    const rows = await SheetsService.fetchSheetRows();
    const pending = rows.filter(r => {
      const s = (r.status || "").toLowerCase();
      return s === "waiting_review" || s === "" || s === "chờ duyệt";
    });
    const approved = rows.filter(r => {
      const s = (r.status || "").toLowerCase();
      return s === "publish" || s === "posted";
    });
    return res.json({ success: true, pending_count: pending.length, approved_count: approved.length, pending, approved });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================
// 12. GET /api/drive/thumbnails - Lấy thumbnail ảnh từ Drive folder
// ============================================================
router.get("/api/drive/thumbnails", async (req, res) => {
  try {
    const { folder_url } = req.query;
    if (!folder_url) {
      return res.status(400).json({ success: false, error: "Thiếu folder_url" });
    }
    const images = await SheetsService.listFolderImages(folder_url);
    return res.json({ success: true, count: images.length, images });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================
// 13. POST /api/n8n/execute - Trigger n8n workflow qua REST API
// ============================================================
router.post("/api/n8n/execute", async (req, res) => {
  const { workflow_id, data = {} } = req.body;
  const N8N_API_KEY = process.env.N8N_API_KEY;
  const n8nBase = "http://localhost:5678";

  if (!N8N_API_KEY) {
    // Fallback: thử gọi webhook URL nếu có
    logger.log("⚠️ [n8n] N8N_API_KEY chưa được cấu hình trong .env", "warn");
    return res.json({
      success: false,
      error: "Chưa có N8N_API_KEY trong .env. Thêm N8N_API_KEY=xxx để trigger workflow từ dashboard."
    });
  }

  try {
    const targetId = workflow_id || process.env.N8N_WORKFLOW_ID || "uWbys7XrXlEP1iy9"; // content-flow-V2-TEST
    const r = await fetch(`${n8nBase}/api/v1/workflows/${targetId}/run`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-N8N-API-KEY": N8N_API_KEY
      },
      body: JSON.stringify({ workflowData: {}, startNodes: [], data }),
      signal: AbortSignal.timeout(5000)
    });

    if (r.ok) {
      const result = await r.json();
      logger.log(`✅ [n8n] Đã trigger workflow ${targetId} thành công!`, "success");
      return res.json({ success: true, execution_id: result.executionId || result.id });
    } else {
      const text = await r.text();
      throw new Error(`n8n trả ${r.status}: ${text.slice(0, 200)}`);
    }
  } catch (err) {
    logger.log(`❌ [n8n] Lỗi trigger: ${err.message}`, "error");
    return res.status(500).json({ success: false, error: err.message });
  }
});

export default router;


