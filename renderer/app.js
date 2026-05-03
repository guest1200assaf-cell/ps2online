// ── Helpers (must be first) ──
const $ = (id) => document.getElementById(id);

function showStep(name) {
  Object.values(steps).forEach(s => s.classList.remove('active'));
  steps[name].classList.add('active');
}

function shortPath(p) {
  if (!p) return 'لم يُحدد';
  return p.replace(/\\/g, '/').split('/').pop();
}

function fmtSize(bytes) {
  if (!bytes) return '';
  const mb = bytes / (1024 * 1024);
  if (mb < 1024) return `${mb.toFixed(0)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// ── UI Sounds ──
function playClickSound() {
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(800, ctx.currentTime);
  osc.frequency.exponentialRampToValueAtTime(400, ctx.currentTime + 0.1);
  gain.gain.setValueAtTime(0.3, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.1);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start();
  osc.stop(ctx.currentTime + 0.1);
}

function playHoverSound() {
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'triangle';
  osc.frequency.setValueAtTime(400, ctx.currentTime);
  gain.gain.setValueAtTime(0.05, ctx.currentTime);
  gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.05);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start();
  osc.stop(ctx.currentTime + 0.05);
}

document.addEventListener('mouseover', (e) => {
  if (e.target.tagName === 'BUTTON' || e.target.closest('.game-card') || e.target.closest('.tab')) {
    playHoverSound();
  }
});
document.addEventListener('click', (e) => {
  if (e.target.tagName === 'BUTTON' || e.target.closest('.tab')) {
    playClickSound();
  }
});

// ── State ──
let socket    = null;
const serverUrl = 'https://ps2-7stb.onrender.com';
let playerName  = '';
let myRole      = '';
let roomCode    = '';
let pcsx2Path   = localStorage.getItem('pcsx2Path') || '';
let fullscreenMode = localStorage.getItem('fullscreenMode') !== '0';
let library     = { games: [], selectedId: null, gamesFolder: null };
let librarySearch = '';
let platformFilter = 'all';
let platforms = [];
let autoLaunchTimer = null;

// ── Steps map ──
const steps = {
  server:   $('step-server'),
  emulator: $('step-emulator'),
  library:  $('step-library'),
  name:     $('step-name'),
  join:     $('step-join'),
  waiting:  $('step-waiting'),
  bridge:   $('step-bridge'),
};

// ── Title bar ──
$('btn-minimize').addEventListener('click', () => window.electronAPI.minimize());
$('btn-maximize').addEventListener('click', () => window.electronAPI.maximize());
$('btn-close').addEventListener('click',    () => window.electronAPI.close());

// ── Settings panel ──
$('btn-settings').addEventListener('click', () => {
  $('settings-panel').classList.toggle('hidden');
});

$('pcsx2-path-label').textContent = shortPath(pcsx2Path);

$('opt-fullscreen').checked = fullscreenMode;
$('opt-fullscreen').addEventListener('change', (e) => {
  fullscreenMode = e.target.checked;
  localStorage.setItem('fullscreenMode', fullscreenMode ? '1' : '0');
});

$('btn-pick-pcsx2').addEventListener('click', async () => {
  const p = await window.electronAPI.pickFile({
    title: 'اختر PCSX2',
    filters: [{ name: 'PCSX2', extensions: ['exe'] }],
  });
  if (p) {
    pcsx2Path = p;
    localStorage.setItem('pcsx2Path', p);
    $('pcsx2-path-label').textContent = shortPath(p);
  }
});

$('btn-open-library-from-settings').addEventListener('click', () => {
  $('settings-panel').classList.add('hidden');
  showStep('library');
});

// ── Emulator install step (per platform) ──
async function initEmulatorStep() {
  platforms = await window.electronAPI.platformsInfo();
  // Sync legacy pcsx2 path
  const ps2 = platforms.find(p => p.id === 'ps2');
  if (ps2?.emulator.installed) {
    pcsx2Path = ps2.emulator.exePath;
    localStorage.setItem('pcsx2Path', pcsx2Path);
    $('pcsx2-path-label').textContent = shortPath(pcsx2Path);
  }
  // If at least PS2 is installed, skip to library
  if (ps2?.emulator.installed) {
    await initLibrary();
    return;
  }
  renderEmulatorList();
  showStep('emulator');
}

function renderEmulatorList() {
  $('emulator-list').innerHTML = platforms.map(p => {
    const installed = p.emulator.installed;
    const note = p.emulator.manualNote
      ? `<p class="emu-note">${escapeHtml(p.emulator.manualNote)}</p>` : '';
    const action = installed
      ? `<span class="emu-installed">✓ مُثبّت</span>`
      : p.emulator.customInstall
        ? `<button class="btn btn-ghost btn-small" disabled>يدوي</button>`
        : `<button class="btn btn-primary btn-small emu-install-btn" data-emu="${p.emulator.id}">تثبيت</button>`;
    const netBadge = p.netplay
      ? `<span class="net-badge net-yes">نتبلاي ✓</span>`
      : `<span class="net-badge net-no">نتبلاي قريباً</span>`;
    return `
      <div class="emu-row" data-emu="${p.emulator.id}">
        <div class="emu-icon-cell">${p.icon}</div>
        <div class="emu-body">
          <div class="emu-title">${escapeHtml(p.short)} <span class="emu-name">${escapeHtml(p.emulator.name)}</span> ${netBadge}</div>
          <div class="emu-progress-wrap hidden">
            <div class="progress-bar-track"><div class="progress-bar-fill"></div></div>
            <span class="emu-progress-label hint">0%</span>
          </div>
          ${note}
        </div>
        <div class="emu-action">${action}</div>
      </div>
    `;
  }).join('');

  $('emulator-list').querySelectorAll('.emu-install-btn').forEach(btn => {
    btn.addEventListener('click', () => installEmulatorUI(btn.dataset.emu));
  });
}

async function installEmulatorUI(emuId) {
  const row = document.querySelector(`.emu-row[data-emu="${emuId}"]`);
  if (!row) return;
  const wrap   = row.querySelector('.emu-progress-wrap');
  const fill   = row.querySelector('.progress-bar-fill');
  const label  = row.querySelector('.emu-progress-label');
  const action = row.querySelector('.emu-action');
  wrap.classList.remove('hidden');
  action.innerHTML = `<span class="emu-installing">جاري...</span>`;
  fill.style.width = '0%';

  // Listen for THIS emulator's progress
  installProgressTargets[emuId] = { fill, label };

  const result = await window.electronAPI.emulatorInstall(emuId);
  delete installProgressTargets[emuId];

  if (result.success) {
    action.innerHTML = `<span class="emu-installed">✓ مُثبّت</span>`;
    label.textContent = 'تم!';
    if (emuId === 'pcsx2') {
      pcsx2Path = result.exePath;
      localStorage.setItem('pcsx2Path', result.exePath);
      $('pcsx2-path-label').textContent = shortPath(result.exePath);
    }
    // Refresh platforms info
    platforms = await window.electronAPI.platformsInfo();
  } else {
    label.textContent = `فشل: ${result.error || ''}`;
    action.innerHTML = `<button class="btn btn-primary btn-small emu-install-btn" data-emu="${emuId}">إعادة المحاولة</button>`;
    action.querySelector('.emu-install-btn').addEventListener('click', () => installEmulatorUI(emuId));
    if (result.manualNote) {
      const note = document.createElement('p');
      note.className = 'emu-note';
      note.textContent = result.manualNote;
      row.querySelector('.emu-body').appendChild(note);
    }
  }
}

const installProgressTargets = {};

window.electronAPI.onDownloadProgress(({ pct, msg, emuId }) => {
  const target = emuId && installProgressTargets[emuId];
  if (target) {
    target.fill.style.width = `${pct}%`;
    target.label.textContent = msg;
  }
});

$('btn-skip-install').addEventListener('click', () => initLibrary());

// ── Library ──
async function initLibrary() {
  if (!platforms.length) platforms = await window.electronAPI.platformsInfo();
  library = await window.electronAPI.libraryGet();
  renderPlatformFilter();
  renderLibrary();
  if (library.selectedId && library.games.some(g => g.id === library.selectedId)) {
    syncSelectedGameUI();
    showStep('name');
  } else {
    showStep('library');
  }
}

function renderPlatformFilter() {
  const cont = $('platform-filter');
  if (!cont) return;
  const all = `<button class="chip ${platformFilter === 'all' ? 'active' : ''}" data-plat="all">الكل</button>`;
  const chips = platforms.map(p => {
    const count = library.games.filter(g => (g.platform || 'ps2') === p.id).length;
    const active = platformFilter === p.id ? 'active' : '';
    return `<button class="chip ${active}" data-plat="${p.id}">${p.icon} ${escapeHtml(p.short)}${count ? ` <span class="chip-count">${count}</span>` : ''}</button>`;
  }).join('');
  cont.innerHTML = all + chips;
  cont.querySelectorAll('.chip').forEach(c => {
    c.addEventListener('click', () => {
      platformFilter = c.dataset.plat;
      renderPlatformFilter();
      renderLibrary();
    });
  });
}

function getSelectedGame() {
  return library.games.find(g => g.id === library.selectedId) || null;
}

function syncSelectedGameUI() {
  const g = getSelectedGame();
  const pill = $('selected-game-pill');
  const note = $('netplay-support-note');
  if (g) {
    const plat = platformInfo(platformOf(g));
    pill.classList.remove('hidden');
    $('selected-game-name').textContent = g.name;
    if (plat) $('selected-game-platform').textContent = `${plat.icon} ${plat.short}`;
    if (note) {
      if (plat?.netplay) {
        note.className = 'netplay-note ok';
        note.textContent = '✓ النتبلاي مدعوم';
      } else {
        note.className = 'netplay-note warn';
        note.textContent = '⚠️ النتبلاي ما يدعم هذه المنصّة بعد — التشغيل المحلي فقط';
      }
      note.classList.remove('hidden');
    }
  } else {
    pill.classList.add('hidden');
    if (note) note.classList.add('hidden');
  }
  refreshNameButtons();
}

function refreshNameButtons() {
  const g = getSelectedGame();
  const nameOk = nameInput.value.trim().length >= 2;
  const plat = g ? platformInfo(platformOf(g)) : null;
  const supportsNetplay = !!plat?.netplay;
  const baseOk = nameOk && !!g;

  btnCreate.disabled     = !(baseOk && supportsNetplay);
  btnJoinToggle.disabled = !(baseOk && supportsNetplay);

  const btnLocal = $('btn-play-local');
  if (btnLocal) {
    if (g && !supportsNetplay) {
      btnLocal.classList.remove('hidden');
      btnLocal.disabled = !nameOk;
    } else {
      btnLocal.classList.add('hidden');
    }
  }
}

function platformOf(g) { return g.platform || 'ps2'; }
function platformInfo(id) { return platforms.find(p => p.id === id); }

function renderLibrary() {
  const grid    = $('library-grid');
  const empty   = $('library-empty');
  const count   = $('library-count');
  const cont    = $('btn-library-continue');
  count.textContent = library.games.length;

  if (library.games.length === 0) {
    empty.style.display = 'flex';
    grid.style.display  = 'none';
    cont.disabled = true;
    return;
  }
  empty.style.display = 'none';
  grid.style.display  = 'grid';

  const q = librarySearch.trim().toLowerCase();
  let filtered = q
    ? library.games.filter(g => g.name.toLowerCase().includes(q) || g.filename.toLowerCase().includes(q))
    : library.games.slice();
  if (platformFilter !== 'all') filtered = filtered.filter(g => platformOf(g) === platformFilter);

  filtered.sort((a, b) => (b.lastPlayed || 0) - (a.lastPlayed || 0) || (b.addedAt || 0) - (a.addedAt || 0));

  grid.innerHTML = filtered.map(g => {
    const selected = g.id === library.selectedId ? 'selected' : '';
    const plat = platformInfo(platformOf(g));
    const platBadge = plat ? `<span class="plat-badge" title="${escapeHtml(plat.name)}">${plat.icon} ${escapeHtml(plat.short)}</span>` : '';
    const lastPlayed = g.lastPlayed
      ? `<span class="game-meta-item">آخر لعب: ${new Date(g.lastPlayed).toLocaleDateString('ar')}</span>`
      : '';
      
    // Auto Cover Art via Bing Thumbnail API
    const coverQuery = encodeURIComponent(`playstation 2 game cover ${g.name}`);
    const coverUrl = `https://tse2.mm.bing.net/th?q=${coverQuery}&w=300&h=420&c=7&rs=1&p=0`;

    return `
      <div class="game-card ${selected}" data-id="${g.id}">
        <div class="game-cover" style="background-image: url('${coverUrl}'); background-size: cover; background-position: center; border-radius: 8px;"></div>
        <div class="game-card-body">
          <div class="game-card-title" title="${escapeHtml(g.filename)}">${escapeHtml(g.name)} ${platBadge}</div>
          <div class="game-card-meta">
            <span class="game-meta-item">${fmtSize(g.size)}</span>
            ${lastPlayed}
          </div>
        </div>
        <div class="game-card-actions">
          <button class="btn-icon game-rename" title="إعادة تسمية">✎</button>
          <button class="btn-icon game-remove" title="إزالة">✕</button>
        </div>
      </div>
    `;
  }).join('');

  cont.disabled = !library.selectedId;

  grid.querySelectorAll('.game-card').forEach(card => {
    const id = card.dataset.id;
    card.addEventListener('click', async (e) => {
      if (e.target.closest('.game-card-actions')) return;
      playClickSound();
      library = await window.electronAPI.librarySelect(id);
      renderLibrary();
      syncSelectedGameUI();
    });
    card.querySelector('.game-remove').addEventListener('click', async (e) => {
      e.stopPropagation();
      const g = library.games.find(x => x.id === id);
      if (!g) return;
      if (!confirm(`إزالة "${g.name}" من المكتبة؟ (الملف الأصلي ما ينحذف)`)) return;
      library = await window.electronAPI.libraryRemove(id);
      renderLibrary();
      syncSelectedGameUI();
    });
    card.querySelector('.game-rename').addEventListener('click', async (e) => {
      e.stopPropagation();
      const g = library.games.find(x => x.id === id);
      if (!g) return;
      const name = prompt('اسم اللعبة:', g.name);
      if (name == null) return;
      library = await window.electronAPI.libraryRename(id, name);
      renderLibrary();
      syncSelectedGameUI();
    });
  });
}

$('library-search').addEventListener('input', (e) => {
  librarySearch = e.target.value;
  renderLibrary();
});

async function addGames() {
  library = await window.electronAPI.libraryAddFiles();
  renderLibrary();
}

async function scanFolder() {
  library = await window.electronAPI.libraryScanFolder();
  renderLibrary();
}

$('btn-add-game').addEventListener('click', addGames);
$('btn-add-game-empty').addEventListener('click', addGames);
$('btn-scan-folder').addEventListener('click', scanFolder);

$('btn-goto-store').addEventListener('click', () => switchTab('store'));

$('btn-library-continue').addEventListener('click', () => {
  if (!library.selectedId) return;
  syncSelectedGameUI();
  showStep('name');
});

// ── Tabs ──
function switchTab(name) {
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === `tab-${name}`));
  if (name === 'store') loadCatalog();
}

document.querySelectorAll('.tab').forEach(t => {
  t.addEventListener('click', () => switchTab(t.dataset.tab));
});

// ── Store / Catalog ──
let catalog = null;
let catalogSearch = '';
const downloadingIds = new Set();
const downloadProgress = {}; // gameId -> { pct, msg }

async function loadCatalog() {
  $('catalog-status').textContent = 'جاري التحميل...';
  $('catalog-grid').innerHTML = '';
  catalog = await window.electronAPI.catalogFetch();
  renderCatalog();
}

function renderCatalog() {
  const status = $('catalog-status');
  const grid   = $('catalog-grid');
  if (!catalog) { status.textContent = ''; return; }

  if (catalog.source === 'error') {
    status.textContent = `فشل التحميل: ${catalog.error || ''} — تحقق من رابط الكتالوج`;
    status.className = 'catalog-status error';
    return;
  }

  const games = Array.isArray(catalog.games) ? catalog.games : [];

  if (games.length === 0) {
    status.className = 'catalog-status';
    status.innerHTML = `
      <div class="empty-icon">📦</div>
      <p>المتجر فاضي</p>
      <p class="hint">${catalog.source === 'built-in'
        ? 'الكتالوج الافتراضي ما فيه ألعاب. اضغط ⚙ لإضافة رابط كتالوج.'
        : 'الكتالوج المُحمّل ما فيه ألعاب.'}</p>
      <p class="legal-note">استخدم كتالوجات لمحتوى شرعي فقط (homebrew أو ألعابك المستضافة).</p>
    `;
    return;
  }

  status.textContent = '';
  status.className = 'catalog-status';

  const q = catalogSearch.trim().toLowerCase();
  const filtered = q
    ? games.filter(g => (g.name || '').toLowerCase().includes(q) || (g.description || '').toLowerCase().includes(q))
    : games;

  grid.innerHTML = filtered.map(g => {
    const installed = library.games.some(x => x.catalogId === g.id || x.path?.includes(g.id || ''));
    const downloading = downloadingIds.has(g.id);
    const prog = downloadProgress[g.id];
    const initial = (g.name?.[0] || '?').toUpperCase();
    const sizeText = g.size ? fmtSize(g.size) : '';
    const cat = g.category ? `<span class="game-meta-item">${escapeHtml(g.category)}</span>` : '';

    let action;
    if (installed) {
      action = `<button class="btn btn-ghost btn-small" disabled>✓ مُحمّل</button>`;
    } else if (downloading) {
      action = `
        <div class="dl-progress">
          <div class="progress-bar-track"><div class="progress-bar-fill" style="width:${prog?.pct || 0}%"></div></div>
          <span class="dl-msg">${escapeHtml(prog?.msg || 'جاري التحميل...')}</span>
        </div>
      `;
    } else {
      action = `<button class="btn btn-primary btn-small store-dl" data-id="${escapeHtml(g.id)}">⬇ تحميل</button>`;
    }

    return `
      <div class="game-card store-card" data-id="${escapeHtml(g.id)}">
        <div class="game-cover"><span>${escapeHtml(initial)}</span></div>
        <div class="game-card-body">
          <div class="game-card-title">${escapeHtml(g.name || 'بدون اسم')}</div>
          ${g.description ? `<div class="game-card-desc">${escapeHtml(g.description)}</div>` : ''}
          <div class="game-card-meta">
            ${sizeText ? `<span class="game-meta-item">${sizeText}</span>` : ''}
            ${cat}
          </div>
        </div>
        <div class="game-card-actions store-actions">${action}</div>
      </div>
    `;
  }).join('');

  grid.querySelectorAll('.store-dl').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.id;
      const game = (catalog.games || []).find(x => x.id === id);
      if (game) downloadCatalogGame(game);
    });
  });
}

async function downloadCatalogGame(game) {
  if (downloadingIds.has(game.id)) return;
  downloadingIds.add(game.id);
  downloadProgress[game.id] = { pct: 0, msg: 'جاري البدء...' };
  renderCatalog();

  const result = await window.electronAPI.catalogDownload(game);
  downloadingIds.delete(game.id);
  delete downloadProgress[game.id];

  if (result?.success) {
    library = result.library;
    renderLibrary();
    renderCatalog();
  } else {
    alert(`فشل تحميل ${game.name}: ${result?.error || 'خطأ غير معروف'}`);
    renderCatalog();
  }
}

window.electronAPI.onCatalogProgress(({ gameId, pct, msg }) => {
  if (!downloadingIds.has(gameId)) return;
  downloadProgress[gameId] = { pct, msg };
  // Only re-render the affected card to avoid full grid rerender flicker
  const card = document.querySelector(`.store-card[data-id="${CSS.escape(gameId)}"] .dl-progress`);
  if (card) {
    const fill = card.querySelector('.progress-bar-fill');
    const msgEl = card.querySelector('.dl-msg');
    if (fill) fill.style.width = `${pct}%`;
    if (msgEl) msgEl.textContent = msg;
  } else {
    renderCatalog();
  }
});

$('catalog-search').addEventListener('input', (e) => {
  catalogSearch = e.target.value;
  renderCatalog();
});

$('btn-refresh-catalog').addEventListener('click', loadCatalog);

$('btn-catalog-settings').addEventListener('click', () => {
  const panel = $('catalog-source-panel');
  panel.classList.toggle('hidden');
  if (!panel.classList.contains('hidden')) {
    $('catalog-url-input').value = library.catalogUrl || '';
  }
});

$('btn-save-catalog-url').addEventListener('click', async () => {
  const url = $('catalog-url-input').value.trim();
  library = await window.electronAPI.librarySetCatalogUrl(url);
  $('catalog-source-panel').classList.add('hidden');
  loadCatalog();
});

$('btn-clear-catalog-url').addEventListener('click', async () => {
  library = await window.electronAPI.librarySetCatalogUrl('');
  $('catalog-url-input').value = '';
  $('catalog-source-panel').classList.add('hidden');
  loadCatalog();
});

// Block browser navigation on accidental file drop
['dragover', 'drop'].forEach(ev => {
  document.addEventListener(ev, (e) => { e.preventDefault(); e.stopPropagation(); });
});

// ── Step 1: Name ──
const nameInput     = $('player-name');
const btnCreate     = $('btn-create');
const btnJoinToggle = $('btn-join-toggle');

nameInput.addEventListener('input', refreshNameButtons);

nameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !btnCreate.disabled) btnCreate.click();
});

btnCreate.addEventListener('click', () => {
  playerName = nameInput.value.trim();
  myRole = 'host';
  connectAndCreate();
});

btnJoinToggle.addEventListener('click', () => {
  playerName = nameInput.value.trim();
  showStep('join');
  $('room-code-input').focus();
});

$('btn-change-game').addEventListener('click', () => showStep('library'));

$('btn-play-local').addEventListener('click', () => {
  const g = getSelectedGame();
  if (!g) return;
  launchGame(true);
  $('btn-play-local').textContent = 'جاري التشغيل...';
  $('btn-play-local').disabled = true;
  setTimeout(() => {
    $('btn-play-local').textContent = 'تشغيل محلي';
    $('btn-play-local').disabled = false;
  }, 3000);
});

// ── Step 1b: Join ──
const roomCodeInput = $('room-code-input');

roomCodeInput.addEventListener('input', () => {
  roomCodeInput.value = roomCodeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
});

roomCodeInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('btn-join-confirm').click();
});

$('btn-join-back').addEventListener('click', () => showStep('name'));

$('btn-join-confirm').addEventListener('click', () => {
  const code = roomCodeInput.value.trim();
  if (code.length !== 6) return;
  myRole = 'guest';
  connectAndJoin(code);
});

// ── Waiting ──
$('btn-copy').addEventListener('click', () => {
  navigator.clipboard.writeText(roomCode).then(() => {
    $('btn-copy').textContent = 'تم!';
    setTimeout(() => { $('btn-copy').textContent = 'نسخ'; }, 1500);
  });
});

// ── Leave ──
$('btn-leave').addEventListener('click', () => {
  clearTimeout(autoLaunchTimer);
  window.electronAPI.stopBridge();
  if (socket) { socket.disconnect(); socket = null; }
  location.reload();
});

// ── Launch PCSX2 button ──
$('btn-launch-pcsx2').addEventListener('click', () => launchGame(true));

function launchGame(manual) {
  clearTimeout(autoLaunchTimer);
  const g = getSelectedGame();
  if (!g) return;
  window.electronAPI.launchGame({
    platformId: platformOf(g),
    isoPath: g.path,
    fullscreen: fullscreenMode,
  });
  window.electronAPI.libraryMarkPlayed(g.id);
  if (manual) {
    $('btn-launch-pcsx2').disabled = true;
    $('btn-launch-pcsx2').textContent = 'جاري التشغيل...';
  }
}

// ── Socket ──
function connectSocket(cb) {
  if (socket && socket.id) { cb(); return; }

  const script = document.createElement('script');
  script.src = `${serverUrl}/socket.io/socket.io.js`;
  script.onload = () => {
    /* global io */
    socket = io(serverUrl);
    socket.on('connect', () => cb());
    socket.on('connect_error', () => alert('تعذر الاتصال بالسيرفر'));
    attachSocketEvents();
  };
  script.onerror = () => alert('تعذر الوصول للسيرفر — تأكد من الإنترنت');
  document.head.appendChild(script);
}

function connectAndCreate() { connectSocket(() => socket.emit('create-room', { playerName, maxPlayers: 4 })); }
function connectAndJoin(code) { connectSocket(() => socket.emit('join-room', { roomCode: code, playerName })); }

function renderWaitingRoom(host, guests, maxPlayers) {
  const row = $('waiting-players-row');
  let html = `
    <div class="player-slot">
      <div class="avatar">${host.name[0].toUpperCase()}</div>
      <span id="host-name">${escapeHtml(host.name)}</span>
      <span class="badge">مضيف</span>
    </div>
  `;
  for (let i = 0; i < maxPlayers - 1; i++) {
    const g = guests[i];
    if (g) {
      html += `
        <div class="vs">VS</div>
        <div class="player-slot">
          <div class="avatar green">${g.name[0].toUpperCase()}</div>
          <span>${escapeHtml(g.name)}</span>
        </div>
      `;
    } else {
      html += `
        <div class="vs">VS</div>
        <div class="player-slot">
          <div class="avatar pulse">?</div>
          <span>في الانتظار...</span>
        </div>
      `;
    }
  }
  row.innerHTML = html;

  if (myRole === 'host' && guests.length > 0) {
    $('btn-host-start-game').classList.remove('hidden');
  } else {
    $('btn-host-start-game').classList.add('hidden');
  }
}

$('btn-host-start-game').addEventListener('click', () => {
  // Host decides to start the game for everyone
  socket.emit('relay-join', { roomCode, role: 'host' });
});

$('btn-send-chat').addEventListener('click', () => {
  const text = $('chat-input').value.trim();
  if (!text || !socket) return;
  socket.emit('chat-message', { roomCode, playerName, text });
  $('chat-input').value = '';
});

$('chat-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('btn-send-chat').click();
});

function appendChatMessage(name, text) {
  const box = $('chat-messages');
  const msg = document.createElement('div');
  msg.style.marginBottom = '4px';
  msg.innerHTML = `<strong>${escapeHtml(name)}:</strong> ${escapeHtml(text)}`;
  box.appendChild(msg);
  box.scrollTop = box.scrollHeight;
}

function attachSocketEvents() {
  socket.on('room-created', ({ roomCode: code, maxPlayers }) => {
    roomCode = code;
    $('display-code').textContent = code;
    renderWaitingRoom({ name: playerName }, [], maxPlayers);
    showStep('waiting');
  });

  socket.on('join-error', ({ message }) => alert(message));

  socket.on('room-update', ({ roomCode: code, host, guests, maxPlayers }) => {
    roomCode = code;
    renderWaitingRoom(host, guests, maxPlayers);
    showStep('waiting');
    
    // Auto join relay for guests so they are ready when host starts
    if (myRole === 'guest' && !socket.data?.relayJoined) {
      socket.data = { ...socket.data, relayJoined: true };
      socket.emit('relay-join', { roomCode, role: 'guest' });
    }
  });

  // Fallback for old server (Render)
  socket.on('room-ready', ({ roomCode: code, host, guest }) => {
    roomCode = code;
    // Map the old single guest to an array
    renderWaitingRoom(host, [guest], 2);
    showStep('waiting');
    
    if (myRole === 'guest' && !socket.data?.relayJoined) {
      socket.data = { ...socket.data, relayJoined: true };
      socket.emit('relay-join', { roomCode, role: 'guest' });
    }
  });

  socket.on('chat-message', ({ playerName: sender, text }) => {
    appendChatMessage(sender, text);
    playClickSound(); // notification sound
  });

  socket.on('relay-ready', () => {
    const g = getSelectedGame();
    if (g) {
      $('bridge-game-pill').classList.remove('hidden');
      $('bridge-game-name').textContent = g.name;
    }
    showStep('bridge');
    launchBridge();
  });

  socket.on('player-left', ({ name }) => {
    clearTimeout(autoLaunchTimer);
    window.electronAPI.stopBridge();
    alert(`${name || 'اللاعب الآخر'} غادر الغرفة`);
    location.reload();
  });
}

// ── Bridge ──
let guideTimer = null;
let guideStepIdx = 0;

function getGuideSteps(role, platformId) {
  if (platformId === 'ps1') {
    return role === 'host' ? [
      'اللعبة بتفتح تلقائياً في DuckStation',
      'من القائمة العلوية: <code>Netplay</code> ← <code>Host Session</code>',
      'تأكد البورت <code>7777</code> واضغط Start',
      'العب!',
    ] : [
      'اللعبة بتفتح تلقائياً في DuckStation',
      'من القائمة العلوية: <code>Netplay</code> ← <code>Join Session</code>',
      'العنوان <code>127.0.0.1</code> والبورت <code>7777</code>',
      'اضغط Join',
    ];
  }
  return role === 'host' ? [
    'اللعبة بتفتح تلقائياً في PCSX2',
    'من القائمة العلوية: <code>Netplay</code>',
    'اختر <code>Host</code>',
    'تأكد البورت <code>7777</code> ثم Start',
  ] : [
    'اللعبة بتفتح تلقائياً في PCSX2',
    'من القائمة العلوية: <code>Netplay</code>',
    'اختر <code>Join</code>',
    'العنوان: <code>127.0.0.1:7777</code>',
  ];
}

function renderGuide(role) {
  const g = getSelectedGame();
  const platId = g ? platformOf(g) : 'ps2';
  const stepList = getGuideSteps(role, platId);
  stepList.forEach((html, i) => {
    const el = $(`guide-text-${i}`);
    if (el) el.innerHTML = html;
  });
  $('guide-title').textContent = role === 'host'
    ? 'خطوات إعداد Netplay (مضيف)'
    : 'خطوات إعداد Netplay (ضيف)';
  $('netplay-guide').classList.remove('hidden');
  startGuideAnimation();
}

function startGuideAnimation() {
  clearInterval(guideTimer);
  guideStepIdx = 0;
  highlightGuideStep(0);
  guideTimer = setInterval(() => {
    guideStepIdx = (guideStepIdx + 1) % 4;
    highlightGuideStep(guideStepIdx);
  }, 2200);
}

function highlightGuideStep(idx) {
  document.querySelectorAll('.guide-step').forEach((el, i) => {
    el.classList.remove('active');
    if (i === idx && !el.classList.contains('done')) el.classList.add('active');
  });
}

function markGuideDone() {
  clearInterval(guideTimer);
  document.querySelectorAll('.guide-step').forEach(el => {
    el.classList.remove('active');
    el.classList.add('done');
  });
}

$('btn-toggle-guide').addEventListener('click', () => {
  const stepsEl = $('guide-steps');
  stepsEl.classList.toggle('collapsed');
  $('btn-toggle-guide').textContent = stepsEl.classList.contains('collapsed') ? '▸' : '▾';
});

function launchBridge() {
  const g = getSelectedGame();
  const platId = g ? platformOf(g) : 'ps2';
  window.electronAPI.startBridge({ role: myRole, serverUrl, roomCode, platformId: platId });

  const emuName = platId === 'ps1' ? 'DuckStation' : 'PCSX2';

  $('pcsx2-hint').classList.remove('hidden');
  $('pcsx2-hint-text').textContent = myRole === 'host'
    ? `افتح ${emuName} ← Netplay ← Host ←`
    : `افتح ${emuName} ← Netplay ← Join ←`;

  renderGuide(myRole);

  const emuInstalled = platforms.find(p => p.id === platId)?.emulator?.installed;
  if (emuInstalled && g) {
    autoLaunchTimer = setTimeout(() => launchGame(false), 1500);
  } else {
    $('btn-launch-pcsx2').classList.remove('hidden');
  }
}

window.electronAPI.onBridgeLog((msg) => addLog(msg));

window.electronAPI.onBridgeStatus((status) => {
  $('bridge-dot').className = `status-dot ${status}`;
  const labels = {
    connecting:         'جاري الاتصال...',
    waiting:            'في انتظار اللاعب الآخر...',
    'connecting-pcsx2': 'جاري الاتصال بالمحاكي...',
    'waiting-pcsx2':    'في انتظار المحاكي...',
    active:             'الجسر نشط — اللعبة تعمل!',
    error:              'خطأ في الاتصال',
    disconnected:       'انقطع الاتصال',
    'pcsx2-error':      'المحاكي غير متاح',
    'emulator-error':   'المحاكي غير متاح',
  };
  $('bridge-status-label').textContent = labels[status] || status;
  if (status === 'active') markGuideDone();
});

function addLog(msg) {
  const log = $('bridge-log');
  const line = document.createElement('div');
  line.className = 'log-line new';
  line.textContent = `› ${msg}`;
  log.appendChild(line);
  log.scrollTop = log.scrollHeight;
  setTimeout(() => line.classList.remove('new'), 2000);
  while (log.children.length > 20) log.removeChild(log.firstChild);
}

// ── Start ──
initEmulatorStep();

// ── P2P Sharing ──
let currentMagnet = null;

window.electronAPI.onGameMagnet((magnet) => {
  if (!getSelectedGame()) {
    currentMagnet = magnet;
    $('p2p-download-section').classList.remove('hidden');
    $('pcsx2-hint').classList.add('hidden');
    $('netplay-guide').classList.add('hidden');
    $('btn-launch-pcsx2').classList.add('hidden');
  }
});

$('btn-p2p-download').addEventListener('click', () => {
  if (currentMagnet) {
    window.electronAPI.downloadFromHost(currentMagnet);
    $('btn-p2p-download').classList.add('hidden');
    $('p2p-progress-wrap').classList.remove('hidden');
  }
});

window.electronAPI.onTorrentProgress(({ pct, msg, done }) => {
  $('p2p-progress-fill').style.width = `${pct}%`;
  $('p2p-progress-text').textContent = msg;
  if (done) {
    setTimeout(async () => {
      $('p2p-download-section').classList.add('hidden');
      $('pcsx2-hint').classList.remove('hidden');
      $('netplay-guide').classList.remove('hidden');
      library = await window.electronAPI.libraryGet();
      renderLibrary();
      // Auto-select the newest game
      const newGame = library.games.sort((a,b) => b.addedAt - a.addedAt)[0];
      if (newGame) {
        library = await window.electronAPI.librarySelect(newGame.id);
        renderLibrary();
        syncSelectedGameUI();
        launchBridge(); // re-launch to trigger game launch
      }
    }, 2000);
  }
});
