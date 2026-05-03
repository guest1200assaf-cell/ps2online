const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Window controls
  minimize: () => ipcRenderer.send('win-minimize'),
  maximize: () => ipcRenderer.send('win-maximize'),
  close:    () => ipcRenderer.send('win-close'),

  // Bridge
  startBridge: (opts) => ipcRenderer.send('start-bridge', opts),
  stopBridge:  ()     => ipcRenderer.send('stop-bridge'),

  // PCSX2 install / launch
  pickFile:          (opts) => ipcRenderer.invoke('pick-file', opts),
  launchPcsx2:       (opts) => ipcRenderer.send('launch-pcsx2', opts),
  installPcsx2:      ()     => ipcRenderer.invoke('install-pcsx2'),
  getPcsx2Installed: ()     => ipcRenderer.invoke('get-pcsx2-installed'),
  onDownloadProgress:(cb)   => ipcRenderer.on('download-progress', (_, d) => cb(d)),

  // Game library
  libraryGet:         ()    => ipcRenderer.invoke('library-get'),
  libraryAddFiles:    (platformId)   => ipcRenderer.invoke('library-add-files', { platformId }),
  libraryScanFolder:  (platformId)   => ipcRenderer.invoke('library-scan-folder', { platformId }),
  libraryRemove:      (id)  => ipcRenderer.invoke('library-remove', id),
  librarySelect:      (id)  => ipcRenderer.invoke('library-select', id),
  libraryMarkPlayed:  (id)  => ipcRenderer.invoke('library-mark-played', id),
  libraryRename:      (id, name) => ipcRenderer.invoke('library-rename', { id, name }),
  librarySetPlatform: (id, platform) => ipcRenderer.invoke('library-set-platform', { id, platform }),
  librarySetCatalogUrl: (url) => ipcRenderer.invoke('library-set-catalog-url', url),

  // Platforms / Emulators
  platformsInfo:        ()       => ipcRenderer.invoke('platforms-info'),
  emulatorInstall:      (emuId)  => ipcRenderer.invoke('emulator-install', emuId),
  emulatorGetInstalled: (emuId)  => ipcRenderer.invoke('emulator-get-installed', emuId),
  launchGame: (opts) => ipcRenderer.send('launch-game', opts),

  // Store / Catalog
  catalogFetch:    ()       => ipcRenderer.invoke('catalog-fetch'),
  catalogDownload: (game)   => ipcRenderer.invoke('catalog-download', { game }),
  onCatalogProgress: (cb)   => ipcRenderer.on('catalog-progress', (_, d) => cb(d)),

  // Events from main → renderer
  onBridgeLog:    (cb) => ipcRenderer.on('bridge-log',    (_, msg)    => cb(msg)),
  onBridgeStatus: (cb) => ipcRenderer.on('bridge-status', (_, status) => cb(status)),

  // P2P Torrent
  downloadFromHost: (magnet) => ipcRenderer.send('download-from-host', magnet),
  onGameMagnet:     (cb)     => ipcRenderer.on('game-magnet', (_, m) => cb(m)),
  onTorrentProgress:(cb)     => ipcRenderer.on('torrent-progress', (_, p) => cb(p)),
  onLibraryUpdated: (cb)     => ipcRenderer.on('library-updated', (_, lib) => cb(lib)),

  // Phase 3
  syncMemcardHost: (emuId) => ipcRenderer.invoke('sync-memcard-host', emuId),
  syncMemcardGuest: (data) => ipcRenderer.invoke('sync-memcard-guest', data),

  // App info
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
});
