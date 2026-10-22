/**
 * Content Hub Common Utilities & Components
 */

function renderNavbar(activeTab) {
  const root = document.getElementById("navbar-root");
  if (!root) return;

  root.innerHTML = `
    <header class="navbar">
      <div class="nav-container">
        <a class="brand" href="/" title="Về trang chủ">
          <img src="/assets/logo.png" alt="Ecolar Logo" style="height: 40px; object-fit: contain;">
          <div class="brand-title">
            Content Hub <span class="tag" id="brand-sheet-tag">Ecolar</span>
          </div>
        </a>

        <!-- MAIN ROUTE TABS -->
        <nav class="nav-links">
          <a class="nav-link ${activeTab === 'content' ? 'active' : ''}" href="/content">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3h18v18H3zM3 9h18M3 15h18M9 3v18M15 3v18"/></svg>
            <span>Kế Hoạch Content</span>
          </a>
          <a class="nav-link ${activeTab === 'buffer' ? 'active' : ''}" href="/buffer">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/></svg>
            <span>Quản Lý Buffer</span>
          </a>
          <a class="nav-link ${activeTab === 'automation' ? 'active' : ''}" href="/automation">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>
            <span>n8n & Logs</span>
          </a>
        </nav>

        <!-- RIGHT STATUS & ACTIONS -->
        <div class="nav-actions">
          <div class="status-pill" id="nav-n8n-pill">
            <span class="pulse-dot" id="nav-n8n-dot"></span>
            <span id="nav-n8n-text">n8n Online</span>
          </div>
          <a id="nav-sheet-btn" href="#" target="_blank" class="btn btn-sm">Mở Sheet ↗</a>
        </div>
      </div>
    </header>
  `;

  checkSystemHealth();
  loadNavbarConfig();
}

async function loadNavbarConfig() {
  try {
    const r = await fetch('/api/sheet/config');
    const d = await r.json();
    if (d.success) {
      const btn = document.getElementById('nav-sheet-btn');
      if (btn && d.sheet_url) btn.href = d.sheet_url;
      const tag = document.getElementById('brand-sheet-tag');
      if (tag && d.sheet_name) tag.innerText = d.sheet_name;
    }
  } catch (_) { }
}

async function checkSystemHealth() {
  try {
    const r = await fetch('/api/health/n8n');
    const d = await r.json();
    const text = document.getElementById('nav-n8n-text');
    const dot = document.getElementById('nav-n8n-dot');
    if (text && dot) {
      if (d.running) {
        text.innerText = 'n8n Online';
        dot.style.background = 'var(--success)';
      } else {
        text.innerText = 'n8n Offline';
        dot.style.background = 'var(--danger)';
      }
    }
  } catch (_) { }
}

let toastTimer;
/**
 * showToast(msg, type?)
 * type: 'error' | 'success' | 'warning' | 'info' | 'default' (default: 'default' = dark pill)
 * Error toasts stay for 6s, others for 3.5s. Click to dismiss.
 */
function showToast(msg, type) {
  let t = document.getElementById('toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'toast';
    document.body.appendChild(t);
  }
  t.innerText = msg;
  // Reset type classes
  t.className = '';
  if (type === 'error')   t.classList.add('toast-error');
  else if (type === 'success') t.classList.add('toast-success');
  else if (type === 'warning') t.classList.add('toast-warning');
  else if (type === 'info')    t.classList.add('toast-info');

  t.style.display = 'flex';
  requestAnimationFrame(() => {
    t.classList.add('show');
  });

  // Click to dismiss
  t.onclick = () => {
    t.classList.remove('show');
    setTimeout(() => { t.style.display = 'none'; }, 200);
  };

  clearTimeout(toastTimer);
  const duration = (type === 'error') ? 7000 : 3500;
  toastTimer = setTimeout(() => {
    t.classList.remove('show');
    setTimeout(() => {
      if (!t.classList.contains('show')) {
        t.style.display = 'none';
      }
    }, 200);
  }, duration);
}

let errorBannerTimer;
/**
 * showErrorBanner(title, detail?, onRetry?)
 * Shows a persistent dark-red banner for important workflow errors.
 * Stays until user clicks "Đóng" or after 15s.
 */
function showErrorBanner(title, detail, onRetry) {
  let banner = document.getElementById('error-banner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'error-banner';
    document.body.appendChild(banner);
  }
  const detailHtml = detail
    ? `<div class="err-body">${escapeHtml(detail)}</div>`
    : '';
  const retryBtn = typeof onRetry === 'function'
    ? `<button class="err-close" id="err-retry-btn" style="background:rgba(255,255,255,0.25);">🔄 Thử lại</button>`
    : '';
  banner.innerHTML = `
    <div class="err-title">⚠️ ${escapeHtml(title)}</div>
    ${detailHtml}
    <div class="err-actions">
      ${retryBtn}
      <button class="err-close" id="err-close-btn">Đóng</button>
    </div>
  `;
  banner.style.display = 'flex';
  requestAnimationFrame(() => banner.classList.add('show'));

  const close = () => {
    banner.classList.remove('show');
    setTimeout(() => { banner.style.display = 'none'; }, 250);
  };

  const closeBtn = document.getElementById('err-close-btn');
  if (closeBtn) closeBtn.onclick = close;

  const retryBtnEl = document.getElementById('err-retry-btn');
  if (retryBtnEl && typeof onRetry === 'function') {
    retryBtnEl.onclick = () => { close(); onRetry(); };
  }

  clearTimeout(errorBannerTimer);
  errorBannerTimer = setTimeout(close, 15000);
}


function escapeHtml(text) {
  return String(text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Auto init health check
setInterval(checkSystemHealth, 30000);
