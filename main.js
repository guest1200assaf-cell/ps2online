const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const net = require('net');
const fs = require('fs');
const https = require('https');
const { spawn } = require('child_process');
const DiscordRPC = require('discord-rpc');

let mainWindow;
let relay = null;
let pcsx2Socket = null;
let localServer = null;

let torrentClient = null;
let activeTorrent = null;

async function getTorrentClient() {
  if (!torrentClient) {
    const { default: WebTorrent } = await import('webtorrent');
    torrentClient = new WebTorrent();
  }
  return torrentClient;
}

// ── INI Helper ──
function writeIni(filePath, data) {
  let content = '';
  for (const [section, params] of Object.entries(data)) {
    content += `[${section}]\n`;
    for (const [k, v] of Object.entries(params)) {
      content += `${k}=${v}\n`;
    }
    content += '\n';
  }
  fs.writeFileSync(filePath, content);
}

async function getSeven() {
  const { path7za } = await import('7zip-bin');
  const m = await import('node-7z');
  const extractFull = m.default ? m.default.extractFull : m.extractFull;
  return { path7za, extractFull };
}

async function getSocketIo() {
  const { io } = await import('socket.io-client');
  return io;
}

// ── Discord RPC ──
// ⚠️  استبدل هذا الـ ID بـ Application ID الخاص بك من: https://discord.com/developers/applications
const clientId = '1200000000000000000';
DiscordRPC.register(clientId);

let rpc = null;
let startTimestamp = null;

async function setDiscordActivity({ details, state, largeImageText }) {
  if (!rpc) {
    rpc = new DiscordRPC.Client({ transport: 'ipc' });
    startTimestamp = new Date(); // Set before login so it's ready when 'ready' fires
    rpc.on('ready', () => {
      rpc.setActivity({
        details: details || 'يتصفح المكتبة',
        state: state || 'في القائمة الرئيسية',
        startTimestamp,
        largeImageKey: 'ps2_logo',
        largeImageText: largeImageText || 'Assaf Station',
        instance: false,
      }).catch(() => {});
    });
    try {
      await rpc.login({ clientId }).catch(() => {});
    } catch (e) {
      return;
    }
  } else {
    rpc.setActivity({
      details: details || 'يتصفح المكتبة',
      state: state || 'في القائمة الرئيسية',
      startTimestamp,
      largeImageKey: 'ps2_logo',
      largeImageText: largeImageText || 'PS2 Online',
      instance: false,
    }).catch(() => {});
  }
}

// ── Platforms & Emulators registry ──
const PLATFORMS = {
  ps2: {
    id: 'ps2', name: 'PlayStation 2', short: 'PS2', icon: '🎮',
    extensions: ['.iso', '.bin', '.img', '.mdf', '.nrg', '.chd', '.cso'],
    emulator: 'pcsx2',
    netplay: true,
  },
  ps1: {
    id: 'ps1', name: 'PlayStation', short: 'PS1', icon: '🕹️',
    extensions: ['.bin', '.cue', '.iso', '.img', '.chd', '.pbp', '.ecm'],
    emulator: 'duckstation',
    netplay: true,
  },
  n64: {
    id: 'n64', name: 'Nintendo 64', short: 'N64', icon: '🎯',
    extensions: ['.n64', '.z64', '.v64', '.rom'],
    emulator: 'project64',
    netplay: false,
  },
  gamecube: {
    id: 'gamecube', name: 'GameCube', short: 'GC', icon: '🎲',
    extensions: ['.iso', '.gcm', '.gcz', '.rvz', '.wia', '.wbfs'],
    emulator: 'dolphin',
    netplay: false,
  },
  retro: {
    id: 'retro', name: 'Retro (SNES/NES/GBA)', short: 'Retro', icon: '🎰',
    extensions: ['.smc', '.sfc', '.nes', '.gba', '.gb', '.gbc', '.fds', '.unf', '.unif'],
    emulator: 'retroarch',
    netplay: false,
  },
};

const EMULATORS = {
  pcsx2: {
    id: 'pcsx2', name: 'PCSX2',
    githubRepo: 'PCSX2/pcsx2',
    assetMatch: (name) => /windows.*x64.*\.7z$/i.test(name) && !/symbols|debug/i.test(name),
    exeMatch: /pcsx2.*\.exe$/i,
    args: ({ iso, fullscreen }) => {
      const a = [];
      if (fullscreen) a.push('-fullscreen');
      a.push('-fastboot', '-batch');
      if (iso) a.push('--', iso);
      return a;
    },
  },
  duckstation: {
    id: 'duckstation', name: 'DuckStation',
    githubRepo: 'stenzek/duckstation',
    assetMatch: (name) => /windows-x64\.zip$/i.test(name) || /duckstation-windows-x64-release\.zip$/i.test(name),
    exeMatch: /duckstation-(qt|nogui)\.exe$/i,
    args: ({ iso, fullscreen }) => {
      const a = ['-batch'];
      if (fullscreen) a.push('-fullscreen');
      if (iso) a.push('--', iso);
      return a;
    },
  },
  project64: {
    id: 'project64', name: 'Project64',
    githubRepo: 'project64/project64',
    assetMatch: (name) => /\.zip$/i.test(name) && /win/i.test(name),
    exeMatch: /Project64\.exe$/i,
    args: ({ iso, fullscreen }) => {
      const a = [];
      if (fullscreen) a.push('--fullscreen');
      if (iso) a.push(iso);
      return a;
    },
    manualNote: 'لو فشل التحميل التلقائي، حمّل من: https://www.pj64-emu.com/',
  },
  dolphin: {
    id: 'dolphin', name: 'Dolphin',
    // Dolphin official builds aren't on GitHub releases. Provide manual fallback.
    customInstall: true,
    exeMatch: /Dolphin\.exe$/i,
    args: ({ iso, fullscreen }) => {
      const a = ['/b']; // batch mode (skip splash)
      if (iso) a.push('/e', iso);
      // Dolphin reads fullscreen pref from config; CLI flag varies by build
      return a;
    },
    manualNote: 'حمّل Dolphin من: https://dolphin-emu.org/download/',
  },
  retroarch: {
    id: 'retroarch', name: 'RetroArch',
    githubRepo: 'libretro/RetroArch',
    assetMatch: (name) => /RetroArch\.7z$/i.test(name) || /retroarch-win64.*\.7z$/i.test(name),
    exeMatch: /retroarch\.exe$/i,
    args: ({ iso, fullscreen, core }) => {
      const a = [];
      if (core) a.push('-L', core);
      if (fullscreen) a.push('-f');
      if (iso) a.push(iso);
      return a;
    },
    cores: {
      snes: 'snes9x_libretro.dll',
      nes:  'fceumm_libretro.dll',
      gba:  'mgba_libretro.dll',
      gb:   'gambatte_libretro.dll',
    },
    coreForFile: (filePath) => {
      const ext = path.extname(filePath).toLowerCase();
      if (['.smc', '.sfc'].includes(ext)) return 'snes9x_libretro.dll';
      if (['.nes', '.fds', '.unf', '.unif'].includes(ext)) return 'fceumm_libretro.dll';
      if (['.gba'].includes(ext)) return 'mgba_libretro.dll';
      if (['.gb', '.gbc'].includes(ext)) return 'gambatte_libretro.dll';
      return null;
    },
  },
};

function emulatorDir(emuId) {
  return path.join(app.getPath('userData'), 'emulators', emuId);
}

function findExeRecursive(dir, regex, depth = 0) {
  if (!fs.existsSync(dir) || depth > 5) return null;
  let entries;
  try { entries = fs.readdirSync(dir); } catch { return null; }
  for (const e of entries) {
    if (regex.test(e)) return path.join(dir, e);
  }
  for (const e of entries) {
    const full = path.join(dir, e);
    try {
      if (fs.statSync(full).isDirectory()) {
        const found = findExeRecursive(full, regex, depth + 1);
        if (found) return found;
      }
    } catch {}
  }
  return null;
}

function getEmuSubDir(emuId, subName) {
  const exePath = getEmulatorExe(emuId);
  if (!exePath) return null;
  const dir = path.dirname(exePath);
  const sub = path.join(dir, subName);
  if (!fs.existsSync(sub)) fs.mkdirSync(sub, { recursive: true });
  return sub;
}

function applyAutoControllerMapping(emuId) {
  if (emuId !== 'pcsx2') return;
  const inisDir = getEmuSubDir('pcsx2', 'inis');
  if (!inisDir) return;
  
  const lilyPadPath = path.join(inisDir, 'LilyPad.ini');
  // Generic XInput mapping for LilyPad (PCSX2 1.6/1.7)
  const mapping = {
    'General': { 'Keyboard API': 1, 'Mouse API': 1, 'DirectInput API': 1, 'XInput API': 1, 'DS4Windows API': 1 },
    'Pad 1': {
      'Device': 'XInput Pad 0',
      'Button 0': '0,1,16,1.000,0', // Cross
      'Button 1': '0,1,17,1.000,0', // Circle
      'Button 2': '0,1,18,1.000,0', // Square
      'Button 3': '0,1,19,1.000,0', // Triangle
      'Button 4': '0,1,12,1.000,0', // L1
      'Button 5': '0,1,13,1.000,0', // R1
      'Button 6': '0,1,14,1.000,0', // L2
      'Button 7': '0,1,15,1.000,0', // R2
      'Button 8': '0,1,10,1.000,0', // Select
      'Button 9': '0,1,11,1.000,0', // Start
      'Button 10': '0,1,8,1.000,0',  // L3
      'Button 11': '0,1,9,1.000,0',  // R3
      'Button 12': '0,1,0,1.000,0',  // Up
      'Button 13': '0,1,1,1.000,0',  // Down
      'Button 14': '0,1,2,1.000,0',  // Left
      'Button 15': '0,1,3,1.000,0',  // Right
      'Axis 0': '0,0,0,1.000,0',     // LX
      'Axis 1': '0,0,1,1.000,0',     // LY
      'Axis 2': '0,0,2,1.000,0',     // RX
      'Axis 3': '0,0,3,1.000,0',     // RY
    }
  };
  writeIni(lilyPadPath, mapping);
}

function getEmulatorExe(emuId) {
  const emu = EMULATORS[emuId];
  if (!emu) return null;
  const dir = emulatorDir(emuId);
  return findExeRecursive(dir, emu.exeMatch) || null;
}

function platformFromExtension(ext) {
  ext = String(ext).toLowerCase();
  // Specific extensions first (unique to one platform)
  if (['.smc', '.sfc'].includes(ext)) return 'retro';
  if (['.nes', '.fds', '.unf', '.unif'].includes(ext)) return 'retro';
  if (['.gba', '.gb', '.gbc'].includes(ext)) return 'retro';
  if (['.n64', '.z64', '.v64'].includes(ext)) return 'n64';
  if (['.gcm', '.gcz', '.rvz', '.wia', '.wbfs'].includes(ext)) return 'gamecube';
  if (['.cue', '.pbp', '.ecm'].includes(ext)) return 'ps1';
  if (['.cso'].includes(ext)) return 'ps2';
  // .iso .bin .chd .img .mdf .nrg are ambiguous → default ps2
  return 'ps2';
}

function allKnownExtensions() {
  return Array.from(new Set(Object.values(PLATFORMS).flatMap(p => p.extensions)));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 950,
    height: 750,
    minWidth: 600,
    minHeight: 500,
    resizable: true,
    frame: false,
    backgroundColor: '#000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.on('closed', () => {
    stopBridge();
    mainWindow = null;
  });

  setDiscordActivity({ state: 'يستكشف مكتبة الألعاب' });
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { 
  stopBridge();
  if (torrentClient) {
    torrentClient.destroy(() => app.quit());
  } else {
    app.quit();
  }
});

// ── Window controls ──
ipcMain.on('win-minimize', () => mainWindow?.minimize());
ipcMain.on('win-maximize', () => {
  if (mainWindow?.isMaximized()) mainWindow?.unmaximize();
  else mainWindow?.maximize();
});
ipcMain.on('win-close',    () => mainWindow?.close());

// ── App info ──
ipcMain.handle('get-app-version', () => app.getVersion());

// ── File picker ──
ipcMain.handle('pick-file', async (_, { title, filters }) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title,
    filters,
    properties: ['openFile'],
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('sync-memcard-host', async (_, emuId) => {
  if (emuId !== 'pcsx2') return null;
  const mcDir = getEmuSubDir('pcsx2', 'memcards');
  if (!mcDir) return null;
  const mcPath = path.join(mcDir, 'Mcd001.ps2');
  if (!fs.existsSync(mcPath)) return null;

  const tc = await getTorrentClient();
  return new Promise((resolve) => {
    tc.seed(mcPath, { name: 'Mcd001.ps2' }, (torrent) => {
      resolve(torrent.magnetURI);
    });
  });
});

ipcMain.handle('sync-memcard-guest', async (_, data) => {
  const { emuId, magnet } = data || {};
  if (emuId !== 'pcsx2') return false;
  const mcDir = getEmuSubDir('pcsx2', 'memcards');
  if (!mcDir) return false;
  const mcPath = path.join(mcDir, 'Mcd001.ps2');

  const tc = await getTorrentClient();
  return new Promise((resolve) => {
    tc.add(magnet, { path: app.getPath('temp') }, (torrent) => {
      torrent.on('done', () => {
        const downloaded = path.join(app.getPath('temp'), 'Mcd001.ps2');
        if (fs.existsSync(downloaded)) {
          fs.copyFileSync(downloaded, mcPath);
          resolve(true);
        } else {
          resolve(false);
        }
      });
    });
  });
});

// ── Generic launcher ──
function launchEmulator({ exePath, emuId, isoPath, fullscreen = true }) {
  const emu = EMULATORS[emuId];
  if (!exePath || !emu) return { ok: false, error: 'محاكي غير مهيّأ' };

  // Phase 3: Apply auto controller mapping
  applyAutoControllerMapping(emuId);

  const argOpts = { iso: isoPath, fullscreen };
  if (emuId === 'retroarch' && isoPath) {
    const coreFile = emu.coreForFile(isoPath);
    if (coreFile) {
      argOpts.core = path.join(path.dirname(exePath), 'cores', coreFile);
    }
  }
  const args = emu.args(argOpts);
  try {
    spawn(exePath, args, { detached: true, stdio: 'ignore', cwd: path.dirname(exePath) }).unref();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

ipcMain.on('launch-game', (_, { platformId, isoPath, fullscreen = true, exePathOverride }) => {
  const plat = PLATFORMS[platformId];
  if (!plat) return sendLog('منصة غير معروفة');
  const emuId = plat.emulator;
  const exePath = exePathOverride || getEmulatorExe(emuId);
  if (!exePath) return sendLog(`${EMULATORS[emuId].name} غير مثبّت`);
  const result = launchEmulator({ exePath, emuId, isoPath, fullscreen });
  if (result.ok) {
    sendLog(isoPath ? 'تم تشغيل اللعبة' : `تم تشغيل ${EMULATORS[emuId].name}`);
    setDiscordActivity({ 
      details: 'يلعب حالياً', 
      state: isoPath ? path.parse(isoPath).name : 'يستكشف المحاكي' 
    });
  } else {
    sendLog(`فشل التشغيل: ${result.error}`);
  }
});

// Legacy IPC for backwards compat (PS2 only)
ipcMain.on('launch-pcsx2', (_, { pcsx2Path, isoPath, fullscreen = true }) => {
  const exePath = pcsx2Path || getEmulatorExe('pcsx2');
  if (!exePath) return sendLog('PCSX2 غير مثبّت');
  const result = launchEmulator({ exePath, emuId: 'pcsx2', isoPath, fullscreen });
  if (result.ok) sendLog(isoPath ? 'تم تشغيل اللعبة' : 'تم تشغيل PCSX2');
  else sendLog(`فشل التشغيل: ${result.error}`);
});

// ── Game Library ──
const LIBRARY_FILE = path.join(app.getPath('userData'), 'library.json');
const ISO_EXTS = ['.iso', '.bin', '.img', '.mdf', '.nrg', '.chd', '.cso'];

function readLibrary() {
  try {
    if (!fs.existsSync(LIBRARY_FILE)) return { games: [], selectedId: null, gamesFolder: null };
    return JSON.parse(fs.readFileSync(LIBRARY_FILE, 'utf8'));
  } catch (_) {
    return { games: [], selectedId: null, gamesFolder: null };
  }
}

function writeLibrary(lib) {
  try { fs.writeFileSync(LIBRARY_FILE, JSON.stringify(lib, null, 2)); } catch (_) {}
}

function gameIdFromPath(p) {
  return Buffer.from(p).toString('base64').replace(/[/+=]/g, '').slice(0, 16);
}

function prettyName(filename) {
  return filename
    .replace(/\.(iso|bin|img|mdf|nrg|chd|cso)$/i, '')
    .replace(/[_.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function statSafe(p) {
  try { return fs.statSync(p); } catch { return null; }
}

function buildGameEntry(filePath, platformOverride) {
  const st = statSafe(filePath);
  if (!st || !st.isFile()) return null;
  const filename = path.basename(filePath);
  const platform = platformOverride || platformFromExtension(path.extname(filename));
  return {
    id: gameIdFromPath(filePath),
    path: filePath,
    name: prettyName(filename),
    filename,
    platform,
    size: st.size,
    addedAt: Date.now(),
    lastPlayed: null,
  };
}

ipcMain.handle('library-get', () => readLibrary());

ipcMain.handle('library-add-files', async (_, { platformId } = {}) => {
  const exts = platformId && PLATFORMS[platformId]
    ? PLATFORMS[platformId].extensions.map(e => e.slice(1))
    : allKnownExtensions().map(e => e.slice(1));
  const result = await dialog.showOpenDialog(mainWindow, {
    title: platformId ? `اختر ألعاب ${PLATFORMS[platformId].short}` : 'اختر ملفات الألعاب',
    filters: [{ name: 'Game Image', extensions: exts }],
    properties: ['openFile', 'multiSelections'],
  });
  if (result.canceled) return readLibrary();
  const lib = readLibrary();
  for (const fp of result.filePaths) {
    if (lib.games.some(g => g.path === fp)) continue;
    const entry = buildGameEntry(fp, platformId);
    if (entry) lib.games.push(entry);
  }
  writeLibrary(lib);
  return lib;
});

ipcMain.handle('library-scan-folder', async (_, { platformId } = {}) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'اختر مجلد الألعاب',
    properties: ['openDirectory'],
  });
  if (result.canceled) return readLibrary();
  const folder = result.filePaths[0];
  const lib = readLibrary();
  lib.gamesFolder = folder;
  const validExts = platformId && PLATFORMS[platformId]
    ? PLATFORMS[platformId].extensions
    : allKnownExtensions();

  function walk(dir, depth) {
    if (depth > 3) return;
    let entries;
    try { entries = fs.readdirSync(dir); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e);
      const st = statSafe(full);
      if (!st) continue;
      if (st.isDirectory()) walk(full, depth + 1);
      else if (validExts.includes(path.extname(e).toLowerCase())) {
        if (lib.games.some(g => g.path === full)) continue;
        const entry = buildGameEntry(full, platformId);
        if (entry) lib.games.push(entry);
      }
    }
  }
  walk(folder, 0);
  writeLibrary(lib);
  return lib;
});

ipcMain.handle('library-set-platform', (_, { id, platform }) => {
  const lib = readLibrary();
  const g = lib.games.find(x => x.id === id);
  if (g && PLATFORMS[platform]) { g.platform = platform; writeLibrary(lib); }
  return lib;
});

ipcMain.handle('platforms-info', () => {
  return Object.values(PLATFORMS).map(p => ({
    id: p.id,
    name: p.name,
    short: p.short,
    icon: p.icon,
    extensions: p.extensions,
    netplay: p.netplay,
    emulator: {
      id: p.emulator,
      name: EMULATORS[p.emulator].name,
      installed: !!getEmulatorExe(p.emulator),
      exePath: getEmulatorExe(p.emulator),
      manualNote: EMULATORS[p.emulator].manualNote || null,
      customInstall: !!EMULATORS[p.emulator].customInstall,
    },
  }));
});

ipcMain.handle('library-remove', (_, id) => {
  const lib = readLibrary();
  lib.games = lib.games.filter(g => g.id !== id);
  if (lib.selectedId === id) lib.selectedId = null;
  writeLibrary(lib);
  return lib;
});

ipcMain.handle('library-select', (_, id) => {
  const lib = readLibrary();
  if (id && !lib.games.some(g => g.id === id)) return lib;
  lib.selectedId = id;
  writeLibrary(lib);
  return lib;
});

ipcMain.handle('library-mark-played', (_, id) => {
  const lib = readLibrary();
  const g = lib.games.find(x => x.id === id);
  if (g) { g.lastPlayed = Date.now(); writeLibrary(lib); }
  return lib;
});

ipcMain.handle('library-rename', (_, { id, name }) => {
  const lib = readLibrary();
  const g = lib.games.find(x => x.id === id);
  if (g && name && name.trim()) { g.name = name.trim().slice(0, 60); writeLibrary(lib); }
  return lib;
});

ipcMain.handle('library-set-catalog-url', (_, url) => {
  const lib = readLibrary();
  lib.catalogUrl = (url || '').trim() || null;
  writeLibrary(lib);
  return lib;
});

// ── Store / Catalog ──
// Built-in default catalog — homebrew/free PS2 content only.
// Users can override by setting a custom catalog URL in settings.
const DEFAULT_CATALOG = {
  version: 1,
  name: 'Default Catalog',
  note: 'كتالوج محدود للألعاب المفتوحة. يمكنك تعيين رابط JSON خاص في الإعدادات.',
  games: [
    {
      id: "hw-ulaunchelf",
      name: "uLaunchELF",
      description: "مدير ملفات لأجهزة PS2",
      category: "Homebrew",
      url: "https://github.com/ps2dev/ps2sdk/releases/download/v1.2.0/uLaunchELF.zip", // رابط افتراضي كمثال
      size: 1048576 
    },
    {
      id: "hw-tetris",
      name: "Tetris PS2",
      description: "لعبة تيتريس كلاسيكية (مفتوحة المصدر)",
      category: "Homebrew",
      url: "https://example.com/tetris-ps2.iso", // رابط افتراضي كمثال
      size: 5000000
    }
  ],
};

const GAMES_DIR = path.join(app.getPath('userData'), 'games');
fs.mkdirSync(GAMES_DIR, { recursive: true });

function fetchJsonUrl(url) {
  return new Promise((resolve, reject) => {
    const follow = (u, depth = 0) => {
      if (depth > 5) return reject(new Error('Too many redirects'));
      const mod = u.startsWith('https') ? https : require('http');
      mod.get(u, { headers: { 'User-Agent': 'PS2Online-App' } }, (res) => {
        if ([301, 302, 307, 308].includes(res.statusCode)) {
          res.resume();
          return follow(res.headers.location, depth + 1);
        }
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
        let data = '';
        res.setEncoding('utf8');
        res.on('data', d => data += d);
        res.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch (e) { reject(new Error('JSON غير صالح')); }
        });
      }).on('error', reject);
    };
    follow(url);
  });
}

ipcMain.handle('catalog-fetch', async () => {
  const lib = readLibrary();
  const url = lib.catalogUrl;
  if (!url) return { ...DEFAULT_CATALOG, source: 'built-in' };
  try {
    const cat = await fetchJsonUrl(url);
    return { ...cat, source: 'remote', url };
  } catch (e) {
    return { ...DEFAULT_CATALOG, source: 'error', error: e.message };
  }
});

const ARCHIVE_EXTS = ['.7z', '.zip', '.rar', '.tar', '.gz'];

function safeFilename(s) {
  // Remove Windows-forbidden chars and control characters
  return String(s).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim().slice(0, 120) || 'game';
}

ipcMain.handle('catalog-download', async (_, { game }) => {
  if (!game || !game.url) return { success: false, error: 'رابط غير صالح' };
  const filename = safeFilename(game.filename || (game.name + path.extname(new URL(game.url).pathname)) || 'game.iso');
  const targetPath = path.join(GAMES_DIR, filename);

  const sendProgress = (pct, msg) => {
    mainWindow?.webContents.send('catalog-progress', { gameId: game.id, pct, msg });
  };

  try {
    sendProgress(1, 'جاري الاتصال...');
    await downloadFile(game.url, targetPath, (pct) => {
      sendProgress(Math.max(1, Math.floor(pct * 0.85)), `جاري التحميل... ${pct}%`);
    });

    let finalPath = targetPath;
    const ext = path.extname(filename).toLowerCase();
    if (ARCHIVE_EXTS.includes(ext)) {
      sendProgress(88, 'جاري فك الضغط...');
      const extractDir = path.join(GAMES_DIR, path.basename(filename, ext));
      fs.mkdirSync(extractDir, { recursive: true });
      await extractArchive(targetPath, extractDir);
      const isoFound = findFirstIso(extractDir);
      if (!isoFound) throw new Error('ما لقيت ISO داخل الأرشيف');
      try { fs.unlinkSync(targetPath); } catch (_) {}
      finalPath = isoFound;
    }

    sendProgress(96, 'جاري الإضافة للمكتبة...');
    const lib = readLibrary();
    if (!lib.games.some(g => g.path === finalPath)) {
      const entry = buildGameEntry(finalPath);
      if (entry) {
        if (game.name) entry.name = game.name;
        if (game.id)   entry.catalogId = game.id;
        lib.games.push(entry);
        writeLibrary(lib);
      }
    }

    sendProgress(100, 'اكتمل!');
    return { success: true, library: lib, path: finalPath };
  } catch (e) {
    try { fs.existsSync(targetPath) && fs.unlinkSync(targetPath); } catch (_) {}
    sendProgress(0, `فشل: ${e.message}`);
    return { success: false, error: e.message };
  }
});

function findFirstIso(dir, depth = 0) {
  if (depth > 4) return null;
  let entries;
  try { entries = fs.readdirSync(dir); } catch { return null; }
  for (const e of entries) {
    const full = path.join(dir, e);
    const st = statSafe(full);
    if (!st) continue;
    if (st.isFile() && ISO_EXTS.includes(path.extname(e).toLowerCase())) return full;
  }
  for (const e of entries) {
    const full = path.join(dir, e);
    const st = statSafe(full);
    if (st?.isDirectory()) {
      const found = findFirstIso(full, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

// ── Download & Install Emulators (generic) ──
function sendDownloadProgress(pct, msg, emuId) {
  mainWindow?.webContents.send('download-progress', { pct, msg, emuId });
}

function getLatestGithubRelease(repo) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.github.com',
      path: `/repos/${repo}/releases/latest`,
      headers: { 'User-Agent': 'PS2Online-App' },
    };
    https.get(options, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.assets) return resolve(parsed);
          // fall back to listing all releases (some repos have prereleases only)
          listGithubReleases(repo).then(resolve).catch(reject);
        } catch (e) { reject(new Error('فشل تحليل بيانات GitHub')); }
      });
    }).on('error', reject);
  });
}

function listGithubReleases(repo) {
  return new Promise((resolve, reject) => {
    https.get({
      hostname: 'api.github.com',
      path: `/repos/${repo}/releases?per_page=5`,
      headers: { 'User-Agent': 'PS2Online-App' },
    }, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try {
          const arr = JSON.parse(data);
          if (Array.isArray(arr) && arr.length > 0) resolve(arr[0]);
          else reject(new Error('لا يوجد إصدارات'));
        } catch (e) { reject(new Error('فشل تحليل GitHub')); }
      });
    }).on('error', reject);
  });
}

ipcMain.handle('emulator-get-installed', (_, emuId) => {
  return getEmulatorExe(emuId) || null;
});

async function installEmulator(emuId) {
  const emu = EMULATORS[emuId];
  if (!emu) return { success: false, error: 'محاكي غير معروف' };
  if (emu.customInstall) {
    return { success: false, error: 'يحتاج تثبيت يدوي', manualNote: emu.manualNote };
  }
  const dir = emulatorDir(emuId);
  try {
    sendDownloadProgress(2, 'جاري البحث عن أحدث إصدار...', emuId);
    const release = await getLatestGithubRelease(emu.githubRepo);
    const asset = (release.assets || []).find(a => emu.assetMatch(a.name));
    if (!asset) throw new Error('لم يُعثر على ملف Windows في الإصدار');

    const archivePath = path.join(app.getPath('temp'), asset.name);
    sendDownloadProgress(5, `جاري التحميل: ${asset.name}`, emuId);
    await downloadFile(asset.browser_download_url, archivePath, (pct) => {
      sendDownloadProgress(5 + Math.floor(pct * 0.8), `جاري التحميل... ${pct}%`, emuId);
    });

    sendDownloadProgress(86, 'جاري فك الضغط...', emuId);
    fs.mkdirSync(dir, { recursive: true });
    await extractArchive(archivePath, dir);

    sendDownloadProgress(95, 'جاري البحث عن المحاكي...', emuId);
    const exePath = findExeRecursive(dir, emu.exeMatch);
    if (!exePath) {
      const extracted = listFiles(dir, 2);
      throw new Error(`لم يُعثر على ${emu.name}.exe — الملفات المستخرجة: ${extracted}`);
    }

    try { fs.unlinkSync(archivePath); } catch (_) {}
    sendDownloadProgress(100, 'تم التثبيت بنجاح!', emuId);
    return { success: true, exePath };
  } catch (e) {
    sendDownloadProgress(0, `فشل التثبيت: ${e.message}`, emuId);
    return { success: false, error: e.message, manualNote: emu.manualNote };
  }
}

ipcMain.handle('emulator-install', (_, emuId) => installEmulator(emuId));

// ── Legacy handlers (PS2 only — kept for backward compat) ──
const PCSX2_DIR = emulatorDir('pcsx2');

ipcMain.handle('get-pcsx2-installed', () => getEmulatorExe('pcsx2') || null);
ipcMain.handle('install-pcsx2',       () => installEmulator('pcsx2'));

function downloadFile(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    const followRedirect = (u) => {
      const mod = u.startsWith('https') ? https : require('http');
      mod.get(u, { headers: { 'User-Agent': 'PS2Online-App' } }, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307 || res.statusCode === 308) {
          res.resume(); // drain response
          return followRedirect(res.headers.location);
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`HTTP ${res.statusCode}`));
        }
        const total = parseInt(res.headers['content-length'] || '0', 10);
        let received = 0;
        const file = fs.createWriteStream(dest);
        res.on('data', (chunk) => {
          received += chunk.length;
          file.write(chunk);
          if (total > 0) onProgress(Math.floor((received / total) * 100));
        });
        res.on('end', () => file.end(resolve));
        res.on('error', (e) => { file.destroy(); reject(e); });
      }).on('error', reject);
    };
    followRedirect(url);
  });
}

async function extractArchive(src, dest) {
  const { path7za, extractFull } = await getSeven();
  return new Promise((resolve, reject) => {
    const stream = extractFull(src, dest, {
      $bin: path7za,
      overwrite: 'a',
    });
    stream.on('end', resolve);
    stream.on('error', reject);
  });
}


function listFiles(dir, depth) {
  if (!fs.existsSync(dir) || depth < 0) return '(empty)';
  try {
    const entries = fs.readdirSync(dir);
    return entries.slice(0, 20).map(e => {
      const full = path.join(dir, e);
      try { return fs.statSync(full).isDirectory() ? `[${e}/]` : e; }
      catch { return e; }
    }).join(', ');
  } catch (e) { return `(error: ${e.message})`; }
}

// ── Bridge ──
function sendLog(msg)    { mainWindow?.webContents.send('bridge-log', msg); }
function sendStatus(s)   { mainWindow?.webContents.send('bridge-status', s); }

function stopBridge() {
  relay?.disconnect();       relay = null;
  pcsx2Socket?.destroy();    pcsx2Socket = null;
  localServer?.close();      localServer = null;
}

ipcMain.on('stop-bridge', stopBridge);

ipcMain.on('start-bridge', async (_, { role, serverUrl, roomCode, platformId, isoPath }) => {
  stopBridge();
  const BRIDGE_PORT = 7777;
  const code = roomCode.toUpperCase();

  if (role === 'host' && isoPath) {
    const tc = await getTorrentClient();
    if (activeTorrent) { tc.remove(activeTorrent); activeTorrent = null; }
    tc.seed(isoPath, { name: path.basename(isoPath) }, (torrent) => {
      activeTorrent = torrent.infoHash;
      if (relay && relay.connected) {
        relay.emit('relay-data', Buffer.from(`MAGNET:${torrent.magnetURI}`));
      }
    });

    // Phase 3: Seed Memory Card for PS2
    if (platformId === 'ps2') {
      const mcDir = getEmuSubDir('pcsx2', 'memcards');
      const mcPath = mcDir ? path.join(mcDir, 'Mcd001.ps2') : null;
      if (mcPath && fs.existsSync(mcPath)) {
        tc.seed(mcPath, { name: 'Mcd001.ps2' }, (mcTorrent) => {
          if (relay && relay.connected) {
            relay.emit('relay-data', Buffer.from(`MEMCARD:${mcTorrent.magnetURI}`));
          }
        });
      }
    }
  }

  setDiscordActivity({ 
    details: 'في غرفة أونلاين', 
    state: `يلعب ${isoPath ? path.parse(isoPath).name : 'مع صديق'}` 
  });

  sendLog('جاري الاتصال بالسيرفر...');
  sendStatus('connecting');

  const io = await getSocketIo();
  relay = io(serverUrl, { transports: ['websocket'] });

  relay.on('connect', async () => {
    sendLog('متصل — جاري الانضمام...');
    relay.emit('relay-join', { roomCode: code, role });
    // If magnet is ready before connect, send it now
    const tc = await getTorrentClient();
    if (role === 'host' && activeTorrent && tc.get(activeTorrent)) {
      relay.emit('relay-data', Buffer.from(`MAGNET:${tc.get(activeTorrent).magnetURI}`));
    }
  });
  relay.on('connect_error', (e) => { sendLog(`فشل الاتصال: ${e.message}`); sendStatus('error'); });
  relay.on('relay-error',   (e) => { sendLog(`خطأ: ${e.message}`); sendStatus('error'); });
  relay.on('relay-waiting', ()  => { sendLog('في انتظار اللاعب الآخر...'); sendStatus('waiting'); });
  relay.on('relay-ready',   ()  => {
    sendLog('اللاعب الآخر جاهز!');
    if (role === 'host') startHostBridge(BRIDGE_PORT);
    else                 startGuestBridge(BRIDGE_PORT);
  });
  relay.on('relay-peer-disconnected', () => { sendLog('اللاعب الآخر قطع الاتصال'); sendStatus('disconnected'); stopBridge(); });
  relay.on('disconnect', () => { sendLog('انقطع الاتصال بالسيرفر'); sendStatus('disconnected'); });
});

function startHostBridge(port) {
  sendLog(`الاتصال بالمحاكي على المنفذ ${port}...`);
  sendStatus('connecting-emulator');

  pcsx2Socket = net.createConnection({ host: '127.0.0.1', port });
  pcsx2Socket.setNoDelay(true);
  pcsx2Socket.on('connect', () => { sendLog('الجسر نشط!'); sendStatus('active'); });
  pcsx2Socket.on('data', (b) => relay?.emit('relay-data', b));
  relay.on('relay-data', (b) => {
    const d = Buffer.from(b);
    const s = d.toString('utf8', 0, 8);
    if (s.startsWith('MAGNET:') || s.startsWith('MEMCARD:')) return;
    if (!pcsx2Socket?.destroyed) pcsx2Socket.write(d);
  });
  pcsx2Socket.on('error', (e) => { sendLog(`المحاكي غير متاح — شغّله أولاً (Netplay > Host > port ${port})`); sendStatus('emulator-error'); });
  pcsx2Socket.on('close', () => { sendLog('المحاكي أغلق الاتصال'); sendStatus('disconnected'); });
}

function startGuestBridge(port) {
  const pending = [];
  relay.on('relay-data', async (b) => {
    const buf = Buffer.from(b);
    const str = buf.toString();
    if (str.startsWith('MAGNET:')) {
      mainWindow?.webContents.send('game-magnet', str.slice(7));
      return;
    }
    if (str.startsWith('MEMCARD:')) {
      const magnet = str.slice(8);
      sendLog('جاري مزامنة بطاقة الذاكرة...');
      const tc = await getTorrentClient();
      tc.add(magnet, { path: app.getPath('temp') }, (t) => {
        t.on('done', () => {
          const downloaded = path.join(app.getPath('temp'), 'Mcd001.ps2');
          const mcDir = getEmuSubDir('pcsx2', 'memcards');
          if (fs.existsSync(downloaded) && mcDir) {
            fs.copyFileSync(downloaded, path.join(mcDir, 'Mcd001.ps2'));
            sendLog('تمت مزامنة بطاقة الذاكرة ✓');
          }
        });
      });
      return;
    }
    if (pcsx2Socket && !pcsx2Socket.destroyed) pcsx2Socket.write(buf);
    else pending.push(buf);
  });

  localServer = net.createServer((client) => {
    if (pcsx2Socket) { client.destroy(); return; }
    pcsx2Socket = client;
    pcsx2Socket.setNoDelay(true);
    sendLog('المحاكي اتصل — الجسر نشط!');
    sendStatus('active');
    localServer.close();
    pending.forEach(d => pcsx2Socket.write(d));
    pending.length = 0;
    pcsx2Socket.on('data', (b) => relay?.emit('relay-data', b));
    pcsx2Socket.on('close', () => { sendLog('المحاكي أغلق'); sendStatus('disconnected'); });
    pcsx2Socket.on('error', () => pcsx2Socket.destroy());
  });

  localServer.listen(port, '127.0.0.1', () => {
    sendLog(`جاهز — افتح المحاكي ← Netplay ← Join ← 127.0.0.1:${port}`);
    sendStatus('waiting-emulator');
  });
  localServer.on('error', (e) => {
    sendLog(e.code === 'EADDRINUSE' ? `المنفذ ${port} مشغول` : `خطأ: ${e.message}`);
    sendStatus('error');
  });
}

ipcMain.on('download-from-host', async (_, magnetURI) => {
  const tc = await getTorrentClient();
  const dir = GAMES_DIR;
  tc.add(magnetURI, { path: dir }, (torrent) => {
    torrent.on('download', () => {
      const pct = Math.floor(torrent.progress * 100);
      const speed = (torrent.downloadSpeed / (1024 * 1024)).toFixed(1);
      mainWindow?.webContents.send('torrent-progress', { pct, msg: `جاري التحميل... ${pct}% (${speed} MB/s)` });
    });
    torrent.on('done', () => {
      mainWindow?.webContents.send('torrent-progress', { pct: 100, msg: 'اكتمل التحميل!', done: true });
      const file = torrent.files[0];
      if (file) {
        const finalPath = path.join(dir, file.name);
        const lib = readLibrary();
        if (!lib.games.some(g => g.path === finalPath)) {
          const entry = buildGameEntry(finalPath);
          if (entry) {
            lib.games.push(entry);
            writeLibrary(lib);
            mainWindow?.webContents.send('library-updated', lib); // For app.js to catch
          }
        }
      }
    });
  });
});
