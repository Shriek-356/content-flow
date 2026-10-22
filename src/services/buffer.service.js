import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { parseSheetTimeVN } from "./sheets.service.js";

/**
 * Service: Tích hợp Buffer GraphQL API (Tự động đăng Video & Post lên TikTok/FB/Instagram)
 */
export class BufferService {
  static _cachedChannels = null;
  static _cachedOrgId = null;
  static _cachedLivePosts = null;
  static _lastLivePostsFetch = 0;
  static _lastKnownToken = null;
  static LIVE_POSTS_TTL = 60 * 1000; // 60 seconds smart throttle (tiết kiệm quota Buffer API)
  static _lastSyncDueQueueFetch = 0;
  static SYNC_DUE_TTL = 60 * 1000; // Tối đa quét hàng đợi 1 lần / 60 giây

  static checkTokenChanged() {
    try {
      dotenv.config({ override: true });
    } catch (_) {}
    const currentToken = process.env.BUFFER_ACCESS_TOKEN || null;
    if (this._lastKnownToken && currentToken && this._lastKnownToken !== currentToken) {
      console.log(`🔄 Phát hiện BUFFER_ACCESS_TOKEN trong .env thay đổi -> Nạp lại cấu hình & xóa cache cũ...`);
      this.reloadToken(currentToken);
    }
    this._lastKnownToken = currentToken;
  }

  static clearLivePostsCache() {
    this._cachedLivePosts = null;
    this._lastLivePostsFetch = 0;
  }
  static getApiUrl() {
    return "https://api.buffer.com";
  }

  static getHeaders(customToken = null) {
    this.checkTokenChanged();
    const token = customToken || process.env.BUFFER_ACCESS_TOKEN;
    if (!token) {
      throw new Error("Thiếu BUFFER_ACCESS_TOKEN (cấu hình trong file .env hoặc truyền vào API)");
    }
    return {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json"
    };
  }

  static _quota = {
    remaining: null,
    limit: 250,
    resetInSeconds: null,
    resetTimestamp: null,
    isRateLimited: false,
    lastChecked: null,
    statusText: "Normal"
  };

  static updateQuotaFromResponse(res) {
    if (!res) return;
    try {
      const remainingHeader = res.headers ? res.headers.get("x-ratelimit-remaining") : null;
      const limitHeader = res.headers ? res.headers.get("x-ratelimit-limit") : null;
      const retryAfter = res.headers ? res.headers.get("retry-after") : null;
      const resetHeader = res.headers ? res.headers.get("x-ratelimit-reset") : null;
      const rateLimitRaw = res.headers ? (res.headers.get("ratelimit") || "") : "";

      let remaining = remainingHeader !== null && remainingHeader !== undefined ? parseInt(remainingHeader, 10) : null;
      let limit = limitHeader !== null && limitHeader !== undefined ? parseInt(limitHeader, 10) : 250;
      let resetSeconds = retryAfter !== null && retryAfter !== undefined ? parseInt(retryAfter, 10) : null;

      // Trích xuất từ header ratelimit nếu có (ví dụ: "250-in-1day"; r=0; t=64108)
      if (rateLimitRaw) {
        const dayMatch = rateLimitRaw.match(/\"250-in-1day\";\s*r=(\d+);\s*t=(\d+)/);
        if (dayMatch) {
          if (remaining === null || isNaN(remaining)) remaining = parseInt(dayMatch[1], 10);
          if (resetSeconds === null || isNaN(resetSeconds)) resetSeconds = parseInt(dayMatch[2], 10);
        }
      }

      if (remaining !== null && !isNaN(remaining)) {
        this._quota.remaining = remaining;
      }
      if (limit !== null && !isNaN(limit)) {
        this._quota.limit = limit;
      }
      if (resetSeconds !== null && !isNaN(resetSeconds)) {
        this._quota.resetInSeconds = resetSeconds;
        this._quota.resetTimestamp = Date.now() + (resetSeconds * 1000);
      } else if (resetHeader) {
        const parsed = parseInt(resetHeader, 10);
        if (!isNaN(parsed)) {
          this._quota.resetTimestamp = parsed > 1e11 ? parsed : parsed * 1000;
          this._quota.resetInSeconds = Math.max(0, Math.round((this._quota.resetTimestamp - Date.now()) / 1000));
        }
      }

      this._quota.isRateLimited = res.status === 429 || this._quota.remaining === 0;
      this._quota.statusText = this._quota.isRateLimited ? "RATE_LIMIT_EXCEEDED" : "OK";
      this._quota.lastChecked = new Date().toISOString();
    } catch (_) {}
  }

  static getQuota() {
    // Nếu có resetTimestamp thì cập nhật lại số giây còn lại theo thời gian thực
    if (this._quota.resetTimestamp) {
      const diff = Math.max(0, Math.round((this._quota.resetTimestamp - Date.now()) / 1000));
      this._quota.resetInSeconds = diff;
      if (diff === 0 && this._quota.isRateLimited) {
        // Hết thời gian chờ, reset trạng thái
        this._quota.isRateLimited = false;
        this._quota.remaining = null;
      }
    }
    return { ...this._quota };
  }

  /**
   * Kiểm tra quota trực tiếp từ Buffer API, tự động nạp lại .env nếu có thay đổi
   */
  static async checkQuota(customToken = null) {
    try {
      dotenv.config({ override: true });
    } catch (_) {}

    const token = customToken || process.env.BUFFER_ACCESS_TOKEN;
    if (!token) {
      this._quota.isRateLimited = false;
      this._quota.statusText = "NO_TOKEN";
      return this.getQuota();
    }

    try {
      const res = await fetch(this.getApiUrl(), {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ query: "{ account { id } }" })
      });

      this.updateQuotaFromResponse(res);
      const data = await res.json().catch(() => ({}));

      if (res.status === 429 || data.errors?.some(e => e.extensions?.code === "RATE_LIMIT_EXCEEDED")) {
        this._quota.isRateLimited = true;
        this._quota.remaining = 0;
        this._quota.statusText = "RATE_LIMIT_EXCEEDED";
      } else if (res.ok && !data.errors) {
        this._quota.isRateLimited = false;
        if (this._quota.remaining === null) this._quota.remaining = 250;
        this._quota.statusText = "OK";
      }
    } catch (err) {
      console.warn("Lỗi kiểm tra quota Buffer:", err.message);
    }

    return this.getQuota();
  }

  /**
   * Đổi Token Buffer mới và xóa toàn bộ bộ đệm cũ
   */
  static reloadToken(newToken = null) {
    if (newToken) {
      process.env.BUFFER_ACCESS_TOKEN = newToken;
      this._lastKnownToken = newToken;
    } else {
      try {
        dotenv.config({ override: true });
      } catch (_) {}
      this._lastKnownToken = process.env.BUFFER_ACCESS_TOKEN || null;
    }
    this.clearLivePostsCache();
    this._cachedChannels = null;
    this._cachedOrgId = null;
    this._quota.isRateLimited = false;
    this._quota.remaining = null;
    this._quota.statusText = "RELOADED";
  }

  /**
   * Tự động lấy Organization ID của tài khoản Buffer hiện tại
   */
  static async resolveOrganizationId(token = null) {
    if (this._cachedOrgId) return this._cachedOrgId;

    const orgQuery = `query GetOrganizations {
      account {
        organizations {
          id
          name
        }
      }
    }`;

    try {
      const orgRes = await fetch(this.getApiUrl(), {
        method: "POST",
        headers: this.getHeaders(token),
        body: JSON.stringify({ query: orgQuery })
      });
      this.updateQuotaFromResponse(orgRes);
      if (orgRes.status === 429) {
        this._quota.isRateLimited = true;
        this._quota.remaining = 0;
        throw new Error("Buffer API đã đạt giới hạn 250 lượt gọi/ngày (RATE_LIMIT_EXCEEDED).");
      }
      const orgData = await orgRes.json();
      const orgId = orgData.data?.account?.organizations?.[0]?.id;
      if (orgId) {
        this._cachedOrgId = orgId;
        process.env.ORGANIZATION_ID = orgId;
        return orgId;
      }
    } catch (e) {
      if (e.message?.includes("RATE_LIMIT")) throw e;
      console.warn("Không thể lấy Organization qua API:", e.message);
    }

    return process.env.ORGANIZATION_ID || null;
  }

  /**
   * Tự động quét và nhận diện toàn bộ kênh (Channels) thuộc tài khoản Buffer
   * Cập nhật ngay vào runtime và đồng bộ vào file .env
   */
  static async autoDiscoverChannels(customToken = null) {
    const token = customToken || process.env.BUFFER_ACCESS_TOKEN;
    if (!token) throw new Error("Thiếu BUFFER_ACCESS_TOKEN");

    this._cachedOrgId = null;
    this._cachedChannels = null;

    const orgId = await this.resolveOrganizationId(token);
    if (!orgId) throw new Error("Không thể tìm thấy Organization ID cho Token này");

    const channels = await this.getChannels({ organizationId: orgId, token, force: true });
    if (!channels || channels.length === 0) {
      return { organizationId: orgId, channels: [], mapped: {} };
    }

    // Tự động phân loại kênh theo service
    const tiktokCh = channels.find(c => (c.service || '').toLowerCase() === 'tiktok');
    const fbPageCh = channels.find(c => (c.service || '').toLowerCase() === 'facebook' && !c.name?.toLowerCase().includes('group') && !c.name?.toLowerCase().includes('hội'));
    const fbGroupCh = channels.find(c => (c.service || '').toLowerCase() === 'facebook' && (c.name?.toLowerCase().includes('group') || c.name?.toLowerCase().includes('hội') || c.name?.toLowerCase().includes('test')));

    // Cập nhật runtime
    if (tiktokCh) process.env.BUFFER_TIKTOK_CHANNEL_ID = tiktokCh.id;
    if (fbPageCh) process.env.BUFFER_FB_PAGE_CHANNEL_ID = fbPageCh.id;
    if (fbGroupCh) process.env.BUFFER_FB_GROUP_CHANNEL_ID = fbGroupCh.id;

    // Ghi vào .env để ghi nhớ lâu dài
    this._syncEnvVars({
      BUFFER_ACCESS_TOKEN: token,
      ORGANIZATION_ID: orgId,
      BUFFER_TIKTOK_CHANNEL_ID: tiktokCh?.id,
      BUFFER_FB_PAGE_CHANNEL_ID: fbPageCh?.id,
      BUFFER_FB_GROUP_CHANNEL_ID: fbGroupCh?.id
    });

    console.log(`🎯 [AUTO DISCOVER] Đã tự động nhận diện các kênh của nick mới:`, {
      orgId,
      tiktok: tiktokCh ? `${tiktokCh.name} (${tiktokCh.id})` : 'Chưa kết nối',
      fbPage: fbPageCh ? `${fbPageCh.name} (${fbPageCh.id})` : 'Chưa kết nối',
      fbGroup: fbGroupCh ? `${fbGroupCh.name} (${fbGroupCh.id})` : 'Chưa kết nối'
    });

    return {
      organizationId: orgId,
      channels,
      mapped: {
        tiktok: tiktokCh ? { id: tiktokCh.id, name: tiktokCh.name } : null,
        facebook_page: fbPageCh ? { id: fbPageCh.id, name: fbPageCh.name } : null,
        facebook_group: fbGroupCh ? { id: fbGroupCh.id, name: fbGroupCh.name } : null
      }
    };
  }

  static _syncEnvVars(updates) {
    try {
      const envPath = path.resolve(process.cwd(), ".env");
      if (!fs.existsSync(envPath)) return;
      let envContent = fs.readFileSync(envPath, "utf8");

      for (const [key, val] of Object.entries(updates)) {
        if (!val) continue;
        const regex = new RegExp(`^#?\\s*${key}=.*$`, "m");
        if (regex.test(envContent)) {
          envContent = envContent.replace(regex, `${key}=${val}`);
        } else {
          envContent += `\n${key}=${val}`;
        }
      }
      fs.writeFileSync(envPath, envContent, "utf8");
      dotenv.config({ override: true });
    } catch (e) {
      console.warn("Không thể lưu cấu hình vào .env:", e.message);
    }
  }

  /**
   * Đăng hoặc lưu nháp Video lên TikTok / Facebook Group / Fanpage thông qua Buffer GraphQL API
   */
  static async publishVideo({
    videoUrl,
    text = "",
    title = "",
    channelId = null,
    schedulingType = "automatic",
    facebookType = null,
    saveToDraft = false,
    dueAt = null,
    token = null
  }) {
    const targetChannelId = channelId || process.env.BUFFER_TIKTOK_CHANNEL_ID;
    if (!targetChannelId) {
      throw new Error("Thiếu Channel ID trên Buffer (cấu hình trong .env hoặc truyền tham số 'channel_id')");
    }

    const caption = text || title || "Video mới từ Ecolar";

    // Hướng 1: Lên lịch vào Hàng đợi (Queue)
    // Chỉ lưu draft nếu được yêu cầu rõ ràng VÀ không có thời gian hẹn giờ
    const isExplicitDraft = Boolean(saveToDraft) && !dueAt;
    let mode = "customScheduled";
    let formattedDueAt = null;

    if (isExplicitDraft) {
      mode = "addToQueue";
    } else {
      // Giờ hẹn tường minh mà đã qua -> chặn sớm với thông báo rõ (Buffer sẽ từ chối).
      // Giờ Sheet là giờ VN (parse tường minh +07:00 để khớp mọi môi trường).
      if (dueAt) {
        const t = parseSheetTimeVN(dueAt);
        if (t !== null && t <= Date.now()) {
          throw new Error(`Giờ hẹn "${dueAt}" đã qua — vui lòng đặt giờ mới trong tương lai rồi đăng lại!`);
        }
      }
      let targetDate = null;
      if (dueAt) {
        const d = new Date(dueAt);
        if (!isNaN(d.getTime())) targetDate = d;
      }
      // Thời gian đăng mặc định sẽ là 1 ngày sau (+24h)
      if (!targetDate) {
        targetDate = new Date(Date.now() + 24 * 60 * 60 * 1000);
      }
      formattedDueAt = targetDate.toISOString();
      mode = "customScheduled";
    }

    console.log(`\n${"=".repeat(60)}`);
    console.log(`🚀 [BUFFER SERVICE] Đăng Video qua GraphQL API`);
    console.log(`📺 Channel ID: ${targetChannelId}`);
    console.log(`📝 Caption: ${caption.slice(0, 80)}...`);
    console.log(`📁 Video URL: ${videoUrl}`);
    console.log(`⚙️ Chế độ: ${isExplicitDraft ? "LƯU NHÁP (Draft)" : `HẸN GIỜ QUEUE (${formattedDueAt})`}`);

    const isFb = targetChannelId === process.env.BUFFER_FB_GROUP_CHANNEL_ID || Boolean(facebookType);

    const sendRequest = async (schedType, withFbMeta = isFb) => {
      const mutation = `mutation CreatePost($input: CreatePostInput!) {
        createPost(input: $input) {
          ... on PostActionSuccess {
            post {
              id
              text
              status
              dueAt
              assets {
                source
              }
            }
          }
          ... on MutationError {
            message
          }
        }
      }`;

      const input = {
        channelId: targetChannelId,
        text: caption,
        schedulingType: schedType,
        mode: mode,
        saveToDraft: isExplicitDraft,
        assets: [
          {
            video: {
              url: videoUrl,
              metadata: { thumbnailOffset: 2000 }
            }
          }
        ]
      };

      if (formattedDueAt && !isExplicitDraft) {
        input.dueAt = formattedDueAt;
      }

      if (withFbMeta) {
        input.metadata = {
          facebook: {
            type: facebookType || "post"
          }
        };
      }

      const response = await fetch(this.getApiUrl(), {
        method: "POST",
        headers: this.getHeaders(token),
        body: JSON.stringify({ query: mutation, variables: { input } })
      });

      return await response.json();
    };

    let result = await sendRequest(schedulingType, isFb);

    // 1. Tự động xử lý nếu Facebook yêu cầu post type (post/reel/story)
    if (result.data?.createPost?.message?.includes("Facebook posts require a type")) {
      console.log(`ℹ️ [BUFFER] Kênh Facebook yêu cầu type -> Đang thử lại với metadata.facebook.type: post...`);
      result = await sendRequest(schedulingType, true);
    }

    // 2. Tự động chuyển sang 'notification' nếu Buffer/Meta yêu cầu cho Facebook Group
    if (result.data?.createPost?.message?.includes("notification scheduling")) {
      console.log(`ℹ️ [BUFFER] Kênh Facebook Group yêu cầu notification scheduling -> Đang thử lại với schedulingType: notification...`);
      result = await sendRequest("notification", true);
    }

    if (result.errors && result.errors.length > 0) {
      throw new Error(`Buffer GraphQL Error: ${result.errors[0].message}`);
    }

    const createPostData = result.data?.createPost;

    if (createPostData?.message) {
      throw new Error(`Buffer Mutation Error: ${createPostData.message}`);
    }

    const post = createPostData?.post;
    console.log(`🎉 [BUFFER SERVICE] Đăng thành công! Post ID: ${post?.id} | Status: ${post?.status}`);
    console.log(`${"=".repeat(60)}\n`);

    if (post && post.id && (post.status === 'scheduled' || post.dueAt || formattedDueAt)) {
      BufferService.trackQueuePost({
        id: post.id,
        due_at: post.dueAt || formattedDueAt,
        channel_id: targetChannelId,
        title: title || (text ? text.slice(0, 80) : "Video"),
        caption: text || "",
        status: post.status || "scheduled"
      });
    }

    BufferService.clearLivePostsCache();
    return post;
  }

  /**
   * Đăng hoặc lưu nháp Album ảnh (Photo Mode / Carousel) qua Buffer GraphQL API
   */
  static async publishPhotos({
    imageUrls = [],
    text = "",
    title = "",
    channelId = null,
    schedulingType = "automatic",
    facebookType = null,
    saveToDraft = false,
    dueAt = null,
    token = null
  }) {
    const targetChannelId = channelId || process.env.BUFFER_TIKTOK_CHANNEL_ID;
    if (!targetChannelId) {
      throw new Error("Thiếu Channel ID trên Buffer (cấu hình trong .env hoặc truyền tham số 'channel_id')");
    }

    if (!imageUrls || !Array.isArray(imageUrls) || imageUrls.length === 0) {
      throw new Error("Thiếu danh sách imageUrls để đăng ảnh qua Buffer!");
    }

    const caption = text || title || "Bài viết mới từ Ecolar";

    // Hướng 1: Lên lịch vào Hàng đợi (Queue)
    // Chỉ lưu draft nếu được yêu cầu rõ ràng VÀ không có thời gian hẹn giờ
    const isExplicitDraft = Boolean(saveToDraft) && !dueAt;
    let mode = "customScheduled";
    let formattedDueAt = null;

    if (isExplicitDraft) {
      mode = "addToQueue";
    } else {
      // Giờ hẹn tường minh mà đã qua -> chặn sớm với thông báo rõ (Buffer sẽ từ chối).
      if (dueAt) {
        const t = parseSheetTimeVN(dueAt);
        if (t !== null && t <= Date.now()) {
          throw new Error(`Giờ hẹn "${dueAt}" đã qua — vui lòng đặt giờ mới trong tương lai rồi đăng lại!`);
        }
      }
      let targetDate = null;
      if (dueAt) {
        const d = new Date(dueAt);
        if (!isNaN(d.getTime())) targetDate = d;
      }
      // Thời gian đăng mặc định sẽ là 1 ngày sau (+24h)
      if (!targetDate) {
        targetDate = new Date(Date.now() + 24 * 60 * 60 * 1000);
      }
      formattedDueAt = targetDate.toISOString();
      mode = "customScheduled";
    }

    console.log(`\n${"=".repeat(60)}`);
    console.log(`🚀 [BUFFER SERVICE] Đăng Album Ảnh (${imageUrls.length} ảnh) qua GraphQL API`);
    console.log(`📺 Channel ID: ${targetChannelId}`);
    console.log(`📝 Caption: ${caption.slice(0, 80)}...`);
    console.log(`🖼️ Số lượng ảnh: ${imageUrls.length}`);
    console.log(`⚙️ Chế độ: ${isExplicitDraft ? "LƯU NHÁP (Draft)" : `HẸN GIỜ QUEUE (${formattedDueAt})`}`);

    const isFb = targetChannelId === process.env.BUFFER_FB_GROUP_CHANNEL_ID || Boolean(facebookType);

    const sendRequest = async (schedType, withFbMeta = isFb) => {
      const mutation = `mutation CreatePost($input: CreatePostInput!) {
        createPost(input: $input) {
          ... on PostActionSuccess {
            post {
              id
              text
              status
              dueAt
              assets {
                source
              }
            }
          }
          ... on MutationError {
            message
          }
        }
      }`;

      const assets = imageUrls.map(url => ({
        image: {
          url: url
        }
      }));

      const input = {
        channelId: targetChannelId,
        text: caption,
        schedulingType: schedType,
        mode: mode,
        saveToDraft: isExplicitDraft,
        assets: assets
      };

      if (formattedDueAt && !isExplicitDraft) {
        input.dueAt = formattedDueAt;
      }

      if (withFbMeta) {
        input.metadata = {
          facebook: {
            type: facebookType || "post"
          }
        };
      }

      const response = await fetch(this.getApiUrl(), {
        method: "POST",
        headers: this.getHeaders(token),
        body: JSON.stringify({ query: mutation, variables: { input } })
      });

      return await response.json();
    };

    let result = await sendRequest(schedulingType, isFb);

    // 1. Tự động xử lý nếu Facebook yêu cầu post type
    if (result.data?.createPost?.message?.includes("Facebook posts require a type")) {
      console.log(`ℹ️ [BUFFER] Kênh Facebook yêu cầu type -> Đang thử lại với metadata.facebook.type: post...`);
      result = await sendRequest(schedulingType, true);
    }

    // 2. Tự động chuyển sang 'notification' nếu Buffer/Meta yêu cầu
    if (result.data?.createPost?.message?.includes("notification scheduling")) {
      console.log(`ℹ️ [BUFFER] Kênh yêu cầu notification scheduling -> Đang thử lại với schedulingType: notification...`);
      result = await sendRequest("notification", isFb);
    }

    if (result.errors && result.errors.length > 0) {
      throw new Error(`Buffer GraphQL Error: ${result.errors[0].message}`);
    }

    const createPostData = result.data?.createPost;

    if (createPostData?.message) {
      throw new Error(`Buffer Mutation Error: ${createPostData.message}`);
    }

    const post = createPostData?.post;
    console.log(`🎉 [BUFFER SERVICE] Đăng ảnh thành công! Post ID: ${post?.id} | Status: ${post?.status}`);
    console.log(`${"=".repeat(60)}\n`);

    if (post && post.id && (post.status === 'scheduled' || post.dueAt || formattedDueAt)) {
      BufferService.trackQueuePost({
        id: post.id,
        due_at: post.dueAt || formattedDueAt,
        channel_id: targetChannelId,
        title: title || (text ? text.slice(0, 80) : "Album ảnh"),
        caption: text || "",
        status: post.status || "scheduled"
      });
    }

    BufferService.clearLivePostsCache();
    return post;
  }

  /**
   * Cập nhật bài viết trên Buffer (chuyển Draft -> Queue hoặc đổi giờ hẹn đăng dueAt)
   */
  static async editPost({
    postId,
    text = null,
    dueAt = null,
    saveToDraft = false,
    mode = null,
    schedulingType = null,
    metadata = null,
    assets = null,
    token = null
  }) {
    if (!postId) throw new Error("Thiếu postId khi cập nhật bài viết trên Buffer");

    let finalMode = mode || "addToQueue";
    let formattedDueAt = null;

    if (mode === "shareNow") {
      finalMode = "shareNow";
      saveToDraft = false;
    } else if (saveToDraft) {
      finalMode = "addToQueue";
      saveToDraft = true;
    } else if (dueAt) {
      const d = new Date(dueAt);
      if (!isNaN(d.getTime())) {
        formattedDueAt = d.toISOString();
        finalMode = "customScheduled";
      }
    }

    const mutation = `mutation EditPost($input: EditPostInput!) {
      editPost(input: $input) {
        ... on PostActionSuccess {
          post {
            id
            text
            status
            dueAt
          }
        }
        ... on MutationError {
          message
        }
      }
    }`;

    const input = {
      id: postId,
      saveToDraft: Boolean(saveToDraft),
      mode: finalMode
    };

    // Buffer GraphQL: Luôn lấy thông tin gốc của bài viết (text, channelService, assets)
    // để bảo toàn hình ảnh/video (TikTok bắt buộc phải có ít nhất 1 media), và metadata Facebook nếu có
    let originalPost = null;
    try {
      const fetchRes = await fetch(this.getApiUrl(), {
        method: "POST",
        headers: this.getHeaders(token),
        body: JSON.stringify({
          query: `query GetPostOriginal($input: PostInput!) {
            post(input: $input) {
              id
              text
              channelService
              channelId
              assets {
                id
                source
                thumbnail
                type
              }
            }
          }`,
          variables: { input: { id: postId } }
        })
      }).then(r => r.json());
      originalPost = fetchRes.data?.post;
    } catch (err) {
      console.warn("⚠️ [BUFFER EDIT] Không thể đọc dữ liệu gốc của bài viết:", err.message);
    }

    // 1. Xử lý text: nếu có text mới thì cập nhật, ngược lại giữ text gốc
    if (text !== null && text !== undefined && text.trim() !== '') {
      input.text = text;
    } else if (originalPost?.text) {
      input.text = originalPost.text;
    }

    // 2. Xử lý assets: CHỈ gửi assets khi caller chủ động truyền assets mới (ví dụ thay đổi ảnh).
    // Tuyệt đối KHÔNG re-send assets cũ từ Buffer, vì Buffer sẽ coi như upload lại media mới
    // và đẩy bài viết về trạng thái 'draft' / xử lý lại media, khiến lệnh 'shareNow' bị hủy!
    if (assets && Array.isArray(assets) && assets.length > 0) {
      input.assets = assets;
    }

    // 3. Xử lý metadata Facebook
    const svc = (originalPost?.channelService || '').toLowerCase();
    if ((svc.includes('facebook') || originalPost?.channelId === process.env.BUFFER_FB_GROUP_CHANNEL_ID) && !input.metadata?.facebook) {
      input.metadata = { ...(input.metadata || {}), facebook: { type: "post" } };
    }

    if (formattedDueAt && !saveToDraft && finalMode === "customScheduled") {
      input.dueAt = formattedDueAt;
    }
    if (schedulingType) input.schedulingType = schedulingType;
    if (metadata) {
      input.metadata = { ...(input.metadata || {}), ...metadata };
    }

    let result = await fetch(this.getApiUrl(), {
      method: "POST",
      headers: this.getHeaders(token),
      body: JSON.stringify({ query: mutation, variables: { input } })
    }).then(r => r.json());

    // Tự động xử lý nếu Facebook yêu cầu post type (post, story, or reel)
    if (result.data?.editPost?.message?.includes("Facebook posts require a type")) {
      console.log(`ℹ️ [BUFFER EDIT] Kênh Facebook yêu cầu type -> Đang tự động gắn metadata.facebook.type: post...`);
      input.metadata = {
        ...(input.metadata || {}),
        facebook: {
          type: "post"
        }
      };
      result = await fetch(this.getApiUrl(), {
        method: "POST",
        headers: this.getHeaders(token),
        body: JSON.stringify({ query: mutation, variables: { input } })
      }).then(r => r.json());
    }

    if (result.errors && result.errors.length > 0) {
      throw new Error(`Buffer GraphQL Error: ${result.errors[0].message}`);
    }

    const editData = result.data?.editPost;
    if (editData?.message) {
      throw new Error(`Buffer Edit Mutation Error: ${editData.message}`);
    }

    const post = editData?.post;
    if (post && post.id) {
      if (originalPost?.channelService) {
        post.channelService = originalPost.channelService;
      }
      if (originalPost?.channelId) {
        post.channelId = originalPost.channelId;
      }
      if (post.status === 'scheduled' || post.dueAt) {
        BufferService.trackQueuePost({
          id: post.id,
          due_at: post.dueAt || dueAt,
          channelService: originalPost?.channelService,
          channel_id: originalPost?.channelId,
          title: originalPost?.text ? originalPost.text.slice(0, 80) : "Bài viết",
          caption: input.text || originalPost?.text || "",
          status: post.status || "scheduled"
        });
      } else if (post.status === 'draft') {
        BufferService.untrackQueuePost(post.id);
      }
    }

    BufferService.clearLivePostsCache();
    return post;
  }

  /**
   * Đăng ngay lập tức bài viết trên Buffer (Publish Now)
   * Tối ưu: Bỏ qua query trùng lặp GetPostForPublish, để editPost tự động đọc và bảo toàn text/kênh Facebook
   * -> Tiết kiệm 1 Buffer API request cho mỗi lần bấm xuất bản
   */
  static async publishPostNow({ postId, text = null, token = null }) {
    if (!postId) throw new Error("Thiếu postId khi xuất bản bài viết trên Buffer");

    return await this.editPost({
      postId,
      text: (text !== null && text !== undefined && text.trim() !== '') ? text : undefined,
      mode: "shareNow",
      saveToDraft: false,
      token
    });
  }

  /**
   * Xóa bài viết khỏi Buffer
   */
  static async deletePost({ postId, token = null }) {
    if (!postId) throw new Error("Thiếu postId khi xóa bài viết trên Buffer");

    const mutation = `mutation DeletePost($input: DeletePostInput!) {
      deletePost(input: $input) {
        ... on DeletePostSuccess {
          id
        }
        ... on VoidMutationError {
          message
        }
      }
    }`;

    const response = await fetch(this.getApiUrl(), {
      method: "POST",
      headers: this.getHeaders(token),
      body: JSON.stringify({
        query: mutation,
        variables: { input: { id: postId } }
      })
    });

    this.updateQuotaFromResponse(response);
    if (response.status === 429) {
      this._quota.isRateLimited = true;
      this._quota.remaining = 0;
      throw new Error("Buffer API đã đạt giới hạn 250 lượt gọi/ngày (RATE_LIMIT_EXCEEDED). Vui lòng đổi nick/token mới trong file .env.");
    }

    const result = await response.json();
    if (result.errors && result.errors.length > 0) {
      throw new Error(`Buffer GraphQL Error: ${result.errors[0].message}`);
    }

    const deleteData = result.data?.deletePost;
    if (deleteData?.message) {
      throw new Error(`Buffer Delete Error: ${deleteData.message}`);
    }

    BufferService.clearLivePostsCache();
    return deleteData;
  }

  /**
   * Lấy danh sách Channels kết nối (Có cache in-memory)
   */
  static async getChannels({ organizationId = null, token = null, force = false } = {}) {
    if (!force && this._cachedChannels && this._cachedChannels.length > 0) {
      return this._cachedChannels;
    }

    const orgId = organizationId || (await this.resolveOrganizationId(token));
    if (!orgId) return [];

    const query = `query GetChannels($input: ChannelsInput!) {
      channels(input: $input) {
        id
        name
        service
      }
    }`;

    const response = await fetch(this.getApiUrl(), {
      method: "POST",
      headers: this.getHeaders(token),
      body: JSON.stringify({ query, variables: { input: { organizationId: orgId } } })
    });

    this.updateQuotaFromResponse(response);
    if (response.status === 429) {
      this._quota.isRateLimited = true;
      this._quota.remaining = 0;
      throw new Error("Buffer API đã đạt giới hạn 250 lượt gọi/ngày (RATE_LIMIT_EXCEEDED). Vui lòng đổi nick/token mới.");
    }

    const result = await response.json();
    const channels = result.data?.channels || [];
    if (channels.length > 0) {
      this._cachedChannels = channels;
      console.log(`📡 [BUFFER] Đã cache danh sách ${channels.length} channels vào bộ nhớ.`);
    }
    return channels;
  }

  /**
   * Lấy danh sách bài viết trực tiếp từ Buffer GraphQL API
   * Tích hợp bộ đệm thông minh 60 giây (LIVE_POSTS_TTL): nếu F5 trong vòng 60s thì dùng cache (0 request)
   */
  static async getLivePosts({ channelId = null, organizationId = null, token = null, force = false } = {}) {
    const now = Date.now();
    if (!force && !channelId && this._cachedLivePosts && (now - this._lastLivePostsFetch < this.LIVE_POSTS_TTL)) {
      const remainingSec = Math.round((this.LIVE_POSTS_TTL - (now - this._lastLivePostsFetch)) / 1000);
      console.log(`⚡ [BUFFER] Sử dụng cache thông minh 60s (còn ${remainingSec}s) -> 0 request Buffer`);
      return this._cachedLivePosts;
    }

    const orgId = organizationId || (await this.resolveOrganizationId(token));
    if (!orgId) return [];

    const channels = await this.getChannels({ organizationId: orgId, token, force });
    const chMap = {};
    channels.forEach(c => { chMap[c.id] = c; });

    const filter = {
      status: ["draft", "needs_approval", "scheduled"]
    };
    if (channelId) {
      filter.channelIds = [channelId];
    }

    const query = `query GetLivePosts($input: PostsInput!) {
      posts(input: $input) {
        edges {
          node {
            id
            text
            status
            channelId
            channelService
            createdAt
            updatedAt
            dueAt
            sentAt
            externalLink
            assets {
              ... on VideoAsset {
                id
                thumbnail
                source
              }
              ... on ImageAsset {
                id
                thumbnail
                source
              }
            }
          }
        }
      }
    }`;

    const res = await fetch(this.getApiUrl(), {
      method: "POST",
      headers: this.getHeaders(token),
      body: JSON.stringify({
        query,
        variables: {
          input: {
            organizationId: orgId,
            filter
          }
        }
      })
    });

    this.updateQuotaFromResponse(res);

    const data = await res.json();
    if (res.status === 429 || data.errors?.some(e => e.extensions?.code === 'RATE_LIMIT_EXCEEDED')) {
      this._quota.isRateLimited = true;
      this._quota.remaining = 0;
      throw new Error("Buffer API đã đạt giới hạn 250 lượt gọi/ngày (RATE_LIMIT_EXCEEDED). Vui lòng đổi nick/token mới trong file .env hoặc thử lại sau.");
    }
    if (data.errors && data.errors.length > 0) {
      throw new Error(`Buffer API Error: ${data.errors[0].message}`);
    }
    const edges = data.data?.posts?.edges || [];

    const livePosts = edges.map(e => {
      const p = e.node;
      const ch = chMap[p.channelId] || {};
      const tab = (p.status === 'scheduled' || p.status === 'sending') ? 'queue' : (p.status === 'sent' ? 'sent' : 'drafts');
      const directUrl = p.channelId 
        ? `https://publish.buffer.com/channels/${p.channelId}/schedule?tab=${tab}`
        : `https://publish.buffer.com/channels/6a9127f8ccaf649a6730ed06/schedule?tab=${tab}`;

      const chName = ch.name || p.channelService || '';
      let platform = 'facebook_page';
      if (p.channelService === 'tiktok' || chName.toLowerCase().includes('tiktok')) {
        platform = 'tiktok';
      } else if (chName.toLowerCase().includes('group') || chName.toLowerCase().includes('hội') || chName.toLowerCase().includes('test')) {
        platform = 'facebook_group';
      }

      const isVideo = p.assets?.some(a => a.source?.includes('.mp4') || a.source?.includes('video'));

      return {
        id: p.id,
        post_id: p.id,
        text: p.text || '',
        title: (p.text || '').split('\n')[0].replace(/^[^\w\s\u00C0-\u1EF9]+/, '').trim().slice(0, 90) || 'Bài viết',
        caption: p.text || '',
        status: p.status,
        channel_id: p.channelId,
        channel_name: chName,
        platform: platform,
        type: isVideo ? 'VIDEO' : 'PHOTO_MODE',
        created_at: p.createdAt,
        updated_at: p.updatedAt,
        due_at: p.dueAt,
        sent_at: p.sentAt,
        live_post_url: p.externalLink || null,
        external_url: p.externalLink || null,
        externalLink: p.externalLink || null,
        assets: p.assets || [],
        metadata: {
          channel_id: p.channelId,
          buffer_post_id: p.id,
          buffer_url: directUrl,
          externalLink: p.externalLink || null
        },
        buffer_url: directUrl
      };
    });

    if (!channelId) {
      this._cachedLivePosts = livePosts;
      this._lastLivePostsFetch = Date.now();

      // Tự động lưu và theo dõi các bài viết đang trong hàng đợi (Queue)
      try {
        const currentScheduledIds = new Set();
        livePosts.forEach(p => {
          if (p.status === 'scheduled') {
            this.trackQueuePost(p);
            currentScheduledIds.add(p.id);
          }
        });

        // Nếu bài trong danh sách theo dõi không còn nằm trong live scheduled -> có thể Buffer vừa xuất bản sang 'sent'
        if (this._trackedQueuePosts) {
          for (const [id, item] of this._trackedQueuePosts.entries()) {
            if (!currentScheduledIds.has(id)) {
              item.missingFromLive = true;
            }
          }
        }
      } catch (trackErr) {
        console.warn("Lỗi theo dõi bài queue:", trackErr.message);
      }
    }
    console.log(`🌐 [BUFFER] Đã gọi GraphQL GetLivePosts (${livePosts.length} bài) -> Tốn đúng 1 request Buffer`);
    return livePosts;
  }

  /**
   * Lấy chi tiết 1 bài viết từ Buffer GraphQL API
   */
  static async getPostDetail({ postId, token = null }) {
    if (!postId) throw new Error("Thiếu postId");

    const query = `query GetPost($input: PostInput!) {
      post(input: $input) {
        id
        text
        status
        channelId
        channelService
        createdAt
        updatedAt
        dueAt
        sentAt
        assets {
          ... on VideoAsset {
            id
            thumbnail
            source
          }
          ... on ImageAsset {
            id
            thumbnail
            source
          }
        }
      }
    }`;

    const res = await fetch(this.getApiUrl(), {
      method: "POST",
      headers: this.getHeaders(token),
      body: JSON.stringify({
        query,
        variables: { input: { id: postId } }
      })
    });

    const data = await res.json();
    const p = data.data?.post;
    if (!p) return null;

    const channels = await this.getChannels({ token });
    const ch = channels.find(c => c.id === p.channelId) || {};
    const tab = (p.status === 'scheduled' || p.status === 'sending') ? 'queue' : 'drafts';
    const directUrl = p.channelId 
      ? `https://publish.buffer.com/channels/${p.channelId}/schedule?tab=${tab}`
      : `https://publish.buffer.com/channels/6a9127f8ccaf649a6730ed06/schedule?tab=${tab}`;

    const chName = ch.name || p.channelService || '';
    let platform = 'facebook_page';
    if (p.channelService === 'tiktok' || chName.toLowerCase().includes('tiktok')) {
      platform = 'tiktok';
    } else if (chName.toLowerCase().includes('group') || chName.toLowerCase().includes('hội') || chName.toLowerCase().includes('test')) {
      platform = 'facebook_group';
    }

    const isVideo = p.assets?.some(a => a.source?.includes('.mp4') || a.source?.includes('video'));

    return {
      id: p.id,
      post_id: p.id,
      text: p.text || '',
      caption: p.text || '',
      title: (p.text || '').split('\n')[0].replace(/^[^\w\s\u00C0-\u1EF9]+/, '').trim().slice(0, 90) || 'Bài viết',
      status: p.status,
      channel_id: p.channelId,
      channel_name: chName,
      platform: platform,
      type: isVideo ? 'VIDEO' : 'PHOTO_MODE',
      created_at: p.createdAt,
      updated_at: p.updatedAt,
      due_at: p.dueAt,
      sent_at: p.sentAt,
      assets: p.assets || [],
      buffer_url: directUrl
    };
  }

  /**
   * Kiểm tra trạng thái danh sách bài viết trên Buffer bằng GraphQL Batch Aliases (chỉ 1 HTTP request)
   * @param {string[]} postIds
   * @param {object} options
   */
  static async checkPostsStatus(postIds = [], { token = null } = {}) {
    const validIds = Array.from(new Set(postIds.map(id => String(id || '').trim()))).filter(id => id && id.length > 5);
    if (validIds.length === 0) return {};

    const batchSize = 25;
    const results = {};

    for (let i = 0; i < validIds.length; i += batchSize) {
      const slice = validIds.slice(i, i + batchSize);
      const subQueries = slice.map((id, idx) => `
        p${idx}: post(input: { id: "${id}" }) {
          id
          status
          dueAt
          sentAt
          externalLink
          channelId
          channelService
          error {
            message
          }
        }
      `).join('\n');

      const query = `query CheckPostsStatusBatch { ${subQueries} }`;

      try {
        const res = await fetch(this.getApiUrl(), {
          method: "POST",
          headers: this.getHeaders(token),
          body: JSON.stringify({ query })
        });
        const json = await res.json();
        const data = json.data || {};

        slice.forEach((id, idx) => {
          const p = data[`p${idx}`];
          if (p) {
            results[id] = {
              id: p.id,
              status: p.status,
              sentAt: p.sentAt || null,
              dueAt: p.dueAt || null,
              externalLink: p.externalLink || null,
              channelId: p.channelId || null,
              channelService: p.channelService || null,
              error: p.error?.message || null
            };
          }
        });
      } catch (err) {
        console.error("Lỗi truy vấn trạng thái Buffer batch:", err.message);
      }
    }

    return results;
  }

  /**
   * ── CƠ CHẾ THEO DÕI VÀ TỰ ĐỘNG ĐỒNG BỘ HÀNG ĐỢI (QUEUE AUTO-SYNC TO SHEET) ──
   */
  static TRACKED_QUEUE_FILE = path.join(process.cwd(), "data", "tracked_queue.json");
  static _trackedQueuePosts = null;

  static loadTrackedQueuePosts() {
    try {
      if (fs.existsSync(this.TRACKED_QUEUE_FILE)) {
        const raw = fs.readFileSync(this.TRACKED_QUEUE_FILE, "utf8");
        const list = JSON.parse(raw || "[]");
        this._trackedQueuePosts = new Map(list.map(item => [item.id, item]));
      } else {
        this._trackedQueuePosts = new Map();
      }
    } catch (_) {
      this._trackedQueuePosts = new Map();
    }
    return this._trackedQueuePosts;
  }

  static saveTrackedQueuePosts() {
    try {
      const dir = path.dirname(this.TRACKED_QUEUE_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const list = Array.from(this._trackedQueuePosts ? this._trackedQueuePosts.values() : []);
      fs.writeFileSync(this.TRACKED_QUEUE_FILE, JSON.stringify(list, null, 2), "utf8");
    } catch (e) {
      console.warn("Lỗi lưu tracked_queue.json:", e.message);
    }
  }

  static trackQueuePost(post) {
    if (!this._trackedQueuePosts) this.loadTrackedQueuePosts();
    if (!post || !post.id) return;
    const existing = this._trackedQueuePosts.get(post.id) || {};
    this._trackedQueuePosts.set(post.id, {
      id: post.id,
      due_at: post.due_at || post.dueAt || existing.due_at || null,
      channelService: post.channelService || post.platform || existing.channelService || null,
      channel_id: post.channel_id || post.channelId || existing.channel_id || null,
      title: post.title || existing.title || (post.text || post.caption ? (post.text || post.caption).slice(0, 80) : "Bài viết"),
      caption: post.caption || post.text || existing.caption || "",
      status: post.status || existing.status || "scheduled",
      tracked_at: existing.tracked_at || new Date().toISOString(),
      // Giữ lại số lần / thời điểm sync để lấp link FB/TikTok dần (bài sent nhưng chưa có link)
      sync_attempts: post.sync_attempts ?? existing.sync_attempts ?? 0,
      first_seen: post.first_seen || existing.first_seen || existing.tracked_at || new Date().toISOString()
    });
    this.saveTrackedQueuePosts();
  }

  static untrackQueuePost(postId) {
    if (!this._trackedQueuePosts) this.loadTrackedQueuePosts();
    if (this._trackedQueuePosts.has(postId)) {
      this._trackedQueuePosts.delete(postId);
      this.saveTrackedQueuePosts();
    }
  }

  static getTrackedQueuePosts() {
    if (!this._trackedQueuePosts) this.loadTrackedQueuePosts();
    return Array.from(this._trackedQueuePosts.values());
  }

  /**
   * Tự động quét các bài viết trong hàng đợi đã đến giờ hẹn hoặc đang publishing
   * Nếu Buffer đã đăng xong ('sent') -> Tự động ghi ngay vào tab 'Publish Content'
   */
  static async syncDueQueuePosts({ force = false } = {}) {
    if (!this._trackedQueuePosts) this.loadTrackedQueuePosts();
    if (this._trackedQueuePosts.size === 0) return [];

    const now = Date.now();
    if (!force && (now - this._lastSyncDueQueueFetch < this.SYNC_DUE_TTL)) {
      return [];
    }

    const candidates = [];

    for (const [id, item] of this._trackedQueuePosts.entries()) {
      const isPublishing = item.status === "publishing" || item.status === "sending";
      // Bài đã sent nhưng chưa có link FB/TikTok: giữ lại để lấp link dần ở các vòng sau
      // (các bài sent đã có link / quá 2h đã bị untrack nên còn lại đây đúng tập cần retry)
      const needsUrlRetry = item.status === "sent";
      let isDue = false;
      if (item.due_at) {
        const dueTime = new Date(item.due_at).getTime();
        // Đến giờ hẹn hoặc quá giờ hẹn (trước 15 giây vẫn tính)
        if (!isNaN(dueTime) && dueTime <= now + 15000) {
          isDue = true;
        }
      }
      if (isDue || isPublishing || needsUrlRetry || item.missingFromLive || force) {
        candidates.push(item);
      }
    }

    if (candidates.length === 0) {
      this._lastSyncDueQueueFetch = now;
      return [];
    }

    this._lastSyncDueQueueFetch = now;
    const candidateIds = candidates.map(c => c.id);
    console.log(`🔍 [QUEUE AUTO-SYNC] Đang kiểm tra trạng thái ${candidateIds.length} bài viết hàng đợi từ Buffer...`);

    const statusMap = await this.checkPostsStatus(candidateIds);
    const publishedRecords = [];

    const { SheetsService } = await import("./sheets.service.js");

    for (const item of candidates) {
      const info = statusMap[item.id];
      if (!info) continue;

      if (info.status === "sent" || info.externalLink) {
        const liveUrl = info.externalLink || "";
        const svc = (info.channelService || item.channelService || "").toLowerCase();
        let channelName = "Facebook Page";
        if (svc.includes("tiktok") || liveUrl.includes("tiktok")) {
          channelName = "TikTok";
        } else if (svc.includes("group") || (item.channelService || "").includes("group")) {
          channelName = "Facebook Group";
        }

        try {
          const rec = await SheetsService.recordPublishedPost({
            buffer_post_id: item.id,
            live_post_url: liveUrl,
            channel: channelName,
            title: item.title || (item.caption ? item.caption.slice(0, 80) : "Bài viết đã đăng"),
            caption: item.caption || "",
            published_at: info.sentAt || new Date().toISOString(),
            status: "sent"
          });
          console.log(`🎉 [QUEUE AUTO-SYNC] Đã tự động ghi nhận bài đăng vào Sheet 'Publish Content': ${liveUrl || item.id}`);
          publishedRecords.push({ id: item.id, liveUrl, ...rec });

          // Bài sent nhưng Buffer chưa trả link FB/TikTok (thường TikTok 60-90s):
          // GIỮ tracking để các vòng sau lấp link dần (recordPublishedPost tự dedup theo
          // buffer_post_id nên không tạo dòng trùng). Chỉ bỏ theo dõi khi đã có link
          // hoặc quá 2h (tránh treo mãi với post không bao giờ có link, vd FB Group).
          const firstSeen = item.first_seen || item.tracked_at || new Date().toISOString();
          const ageMs = now - new Date(firstSeen).getTime();
          if (liveUrl || ageMs > 2 * 60 * 60 * 1000) {
            this.untrackQueuePost(item.id);
          } else {
            this.trackQueuePost({
              ...item,
              first_seen: firstSeen,
              sync_attempts: (item.sync_attempts || 0) + 1,
              status: "sent"
            });
            console.log(`⏳ [QUEUE AUTO-SYNC] Bài ${item.id} đã sent nhưng chưa có link (lần ${(item.sync_attempts || 0) + 1}) — giữ tracking để lấp link sau.`);
          }
        } catch (err) {
          console.warn(`Lỗi ghi nhận bài ${item.id} vào Sheet 'Publish Content':`, err.message);
        }
      } else if (info.status === "error") {
        console.warn(`⚠️ [QUEUE AUTO-SYNC] Bài ${item.id} gặp lỗi khi Buffer xuất bản: ${info.error}`);
      }
    }

    if (publishedRecords.length > 0) {
      this.clearLivePostsCache();
    }

    return publishedRecords;
  }

  /**
   * Đồng bộ bài viết: Toàn bộ bài đã xuất bản hiện được quản lý độc lập tại sheet 'Publish Content'
   */
  static async syncPublishedPosts() {
    return { 
      success: true, 
      message: "Dữ liệu bài đã đăng hiện được quản lý độc lập tại tab Google Sheet 'Publish Content'." 
    };
  }
}
