// test
const {
  app,
  BrowserWindow,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  screen,
  session,
  Tray,
  dialog
} = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { autoUpdater } = require('electron-updater');

const { GameService } = require('./game-service');
const { RemoteHeartService } = require('./remote-heart-service');
let remoteHeart;

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();
app.on('second-instance', () => {
  if (app.isReady()) showMainWindow();
});

let mainWindow;
let overlayWindow;
let tray;
let bluetoothSelectionCallback;
let discoveredDevices = new Map();
let isQuitting = false;
let overlayScale = 1;
let overlayWidth = 580;
let overlayPassthrough = false;
let overlayPosition;
let settingsSaveTimer;
let overlayDestroyTimer;
let unlockShortcuts = [];
let overlayTheme = createDefaultOverlayTheme();
let gameMode = false;
let initialLaunchHidden = process.argv.includes('--hidden');
let updaterReady = false;
let gameService;
let applyingGameProfile = false;
const OVERLAY_MIN_SCALE = 0.5;
const OVERLAY_MAX_SCALE = 2;
const OVERLAY_MIN_WIDTH = 50;
const OVERLAY_MAX_WIDTH = 1000;
const OVERLAY_CONTENT_CHROME_HEIGHT = 66;
const OVERLAY_USER_ROW_HEIGHT = 59.25;
const OVERLAY_USER_ROW_GAP = 18;
const OVERLAY_THEMES = new Set([
  'pulse',
  'neon',
  'ice',
  'amber',
  'minimal',
  'custom'
]);
let overlayState = {
  bpm: null,
  zone: '等待心率',
  connected: false,
  users: []
};

function settingsPath() {
  return path.join(app.getPath('userData'), 'overlay-settings.json');
}

function overlayProfile() {
  const bounds = overlayWindow?.getBounds();
  return {
    scale: overlayScale,
    width: overlayWidth,
    x: bounds?.x ?? overlayPosition?.x,
    y: bounds?.y ?? overlayPosition?.y,
    theme: overlayTheme,
    gameMode,
    passthrough: overlayPassthrough
  };
}

function saveActiveGameProfile() {
  if (!applyingGameProfile) gameService?.saveProfile(overlayProfile());
}

function applyGameProfile(profile) {
  if (!profile) return;
  applyingGameProfile = true;
  setOverlayScale(profile.scale);
  setOverlayWidth(profile.width);
  setOverlayTheme(profile.theme);
  setGameMode(profile.gameMode);
  setOverlayPassthrough(profile.passthrough);
  if (Number.isInteger(profile.x) && Number.isInteger(profile.y)) {
    const window = createOverlayWindow();
    const bounds = window.getBounds();
    window.setBounds({ ...bounds, x: profile.x, y: profile.y }, false);
  }
  applyingGameProfile = false;
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function sanitizeHexColor(value, fallback) {
  const text = String(value || '').trim();
  return /^#[0-9a-f]{6}$/i.test(text) ? text : fallback;
}

function createDefaultOverlayTheme() {
  return {
    preset: 'pulse',
    accent: '#ff315d',
    background: '#0a0c12',
    text: '#f7f8fb',
    opacity: 88,
    blur: 16,
    radius: 18,
    fontScale: 100
  };
}

function normalizeOverlayTheme(theme) {
  const defaults = createDefaultOverlayTheme();
  const preset = OVERLAY_THEMES.has(theme?.preset) ? theme.preset : defaults.preset;
  return {
    preset,
    accent: sanitizeHexColor(theme?.accent, defaults.accent),
    background: sanitizeHexColor(theme?.background, defaults.background),
    text: sanitizeHexColor(theme?.text, defaults.text),
    opacity: clampNumber(theme?.opacity, 0, 100, defaults.opacity),
    blur: clampNumber(theme?.blur, 0, 28, defaults.blur),
    radius: clampNumber(theme?.radius, 8, 30, defaults.radius),
    fontScale: clampNumber(theme?.fontScale, 80, 130, defaults.fontScale)
  };
}

function overlayContentHeight(userCount, fontScale = overlayTheme.fontScale) {
  const normalizedUserCount = Math.max(1, Math.floor(Number(userCount) || 1));
  const rowCount = Math.max(1, Math.ceil(normalizedUserCount / 3));
  const normalizedFontScale = clampNumber(fontScale, 80, 130, 100) / 100;
  const rowHeight = OVERLAY_USER_ROW_HEIGHT +
    (rowCount - 1) * (OVERLAY_USER_ROW_HEIGHT + OVERLAY_USER_ROW_GAP);
  return Math.ceil(OVERLAY_CONTENT_CHROME_HEIGHT + rowHeight * normalizedFontScale);
}

function loadOverlaySettings() {
  try {
    const saved = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
    overlayScale = Math.min(
      OVERLAY_MAX_SCALE,
      Math.max(OVERLAY_MIN_SCALE, Number(saved.scale) || 1)
    );
    overlayWidth = Math.min(
      OVERLAY_MAX_WIDTH,
      Math.max(OVERLAY_MIN_WIDTH, Number(saved.width) || 580)
    );
    if (Number.isInteger(saved.x) && Number.isInteger(saved.y)) {
      const visible = screen.getAllDisplays().some(({ workArea }) => (
        saved.x >= workArea.x - 80 &&
        saved.x < workArea.x + workArea.width &&
        saved.y >= workArea.y - 40 &&
        saved.y < workArea.y + workArea.height
      ));
      if (visible) overlayPosition = { x: saved.x, y: saved.y };
    }
    overlayTheme = normalizeOverlayTheme(saved.theme);
  } catch {
    // First launch or invalid settings: use safe defaults.
  }
}

function saveOverlaySettings() {
  clearTimeout(settingsSaveTimer);
  settingsSaveTimer = setTimeout(() => {
    const bounds = overlayWindow?.getBounds();
    const data = {
      scale: overlayScale,
      width: overlayWidth,
      x: bounds?.x,
      y: bounds?.y,
      theme: overlayTheme
    };
    fs.writeFile(settingsPath(), JSON.stringify(data), () => {});
  }, 250);
}

function isMainSender(event) {
  return Boolean(mainWindow && event.sender === mainWindow.webContents);
}

function isOverlaySender(event) {
  return Boolean(overlayWindow && event.sender === overlayWindow.webContents);
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) createWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function isAutoStartSupported() {
  return ['win32', 'darwin'].includes(process.platform);
}

function isAutoStartEnabled() {
  if (!app.isPackaged || !isAutoStartSupported()) return false;
  return app.getLoginItemSettings({
    path: process.execPath,
    args: ['--hidden']
  }).openAtLogin;
}

function sendAppSettings() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('app-settings', {
    autoStart: isAutoStartEnabled(),
    autoStartSupported: isAutoStartSupported(),
    trayAvailable: Boolean(tray)
  });
}

function sendUpdateStatus(status) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('update-status', {
    state: String(status?.state || 'idle'),
    message: String(status?.message || '').slice(0, 160),
    version: status?.version ? String(status.version).slice(0, 40) : '',
    percent: Number.isFinite(Number(status?.percent))
      ? Math.round(Number(status.percent))
      : null
  });
}

function readableUpdateError(error) {
  const message = String(error?.message || error || '');
  if (/latest\.ya?ml|404|Cannot find/i.test(message)) {
    return '暂未发布可自动更新的安装包，请先在 GitHub Release 上传 latest.yml 和 Setup.exe';
  }
  if (/net::|ENOTFOUND|ECONN|timeout|TLS|SSL/i.test(message)) {
    return '网络连接失败，稍后再检查更新';
  }
  return `更新检查失败：${message.slice(0, 90)}`;
}

function setupAutoUpdater() {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('checking-for-update', () => {
    sendUpdateStatus({ state: 'checking', message: '正在检查更新…' });
  });
  autoUpdater.on('update-available', (info) => {
    sendUpdateStatus({
      state: 'available',
      message: `发现新版本 ${info.version}，正在下载…`,
      version: info.version
    });
  });
  autoUpdater.on('update-not-available', () => {
    sendUpdateStatus({ state: 'none', message: '当前已是最新版本' });
  });
  autoUpdater.on('download-progress', (progress) => {
    sendUpdateStatus({
      state: 'downloading',
      message: `正在下载更新 ${Math.round(progress.percent || 0)}%`,
      percent: progress.percent
    });
  });
  autoUpdater.on('update-downloaded', (info) => {
    sendUpdateStatus({
      state: 'downloaded',
      message: `新版本 ${info.version} 已下载，点击安装并重启`,
      version: info.version
    });
  });
  autoUpdater.on('error', (error) => {
    sendUpdateStatus({
      state: 'error',
      message: readableUpdateError(error)
    });
  });
  updaterReady = true;
}

function checkForUpdates(manual = false) {
  if (!app.isPackaged) {
    sendUpdateStatus({
      state: 'dev',
      message: '开发模式不检查更新，打包安装版后生效'
    });
    return;
  }
  if (!updaterReady) setupAutoUpdater();
  if (manual) sendUpdateStatus({ state: 'checking', message: '正在检查更新…' });
  autoUpdater.checkForUpdates().catch((error) => {
    sendUpdateStatus({
      state: 'error',
      message: readableUpdateError(error)
    });
  });
}

function setAutoStart(enabled) {
  if (app.isPackaged && isAutoStartSupported()) {
    try {
      app.setLoginItemSettings({
        openAtLogin: Boolean(enabled),
        path: process.execPath,
        args: ['--hidden']
      });
    } catch (error) {
      console.error('Auto-start setup failed:', error.message);
    }
  }
  sendAppSettings();
  rebuildTrayMenu();
}

function requestHeartRateReconnect() {
  showMainWindow();
  mainWindow.webContents.send('tray-heart-rate-reconnect');
}

function rebuildTrayMenu() {
  if (!tray || tray.isDestroyed()) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    {
      label: '打开 Watch Heart',
      click: showMainWindow
    },
    {
      label: overlayWindow?.isVisible() ? '隐藏游戏悬浮条' : '显示游戏悬浮条',
      click: () => setOverlayVisible(!overlayWindow?.isVisible())
    },
    {
      label: '重连心率',
      click: requestHeartRateReconnect
    },
    { type: 'separator' },
    {
      label: '开机启动',
      type: 'checkbox',
      checked: isAutoStartEnabled(),
      click: (item) => setAutoStart(item.checked)
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        isQuitting = true;
        app.quit();
      }
    }
  ]));
}

async function createTray() {
  if (tray && !tray.isDestroyed()) return tray;
  let icon;
  try {
    icon = await app.getFileIcon(process.execPath, { size: 'small' });
  } catch {}
  if (!icon || icon.isEmpty()) {
    icon = nativeImage.createFromPath(path.join(__dirname, 'tray-icon.png'));
  }
  if (!icon.isEmpty()) icon = icon.resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  tray.setToolTip('Watch Heart');
  tray.on('click', showMainWindow);
  tray.on('double-click', showMainWindow);
  rebuildTrayMenu();
  return tray;
}

function sendDeviceList() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send(
    'bluetooth-devices',
    [...discoveredDevices.values()].map(({ deviceId, deviceName }) => ({
      id: deviceId,
      name: deviceName || '未命名心率设备'
    }))
  );
}

function finishBluetoothSelection(deviceId = '') {
  if (!bluetoothSelectionCallback) return;
  const callback = bluetoothSelectionCallback;
  bluetoothSelectionCallback = undefined;
  const selectedId = discoveredDevices.has(deviceId) ? deviceId : '';
  discoveredDevices.clear();
  callback(selectedId);
}

function hardenWindow(window) {
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) event.preventDefault();
  });
}

function sendOverlayState() {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  overlayWindow.webContents.send('overlay-state', {
    ...overlayState,
    users: remoteHeart?.snapshot().users.filter((user) => user.selected)
  });
}

function sendOverlaySettings() {
  const settings = {
    visible: Boolean(overlayWindow?.isVisible()),
    passthrough: overlayPassthrough,
    scale: overlayScale,
    width: overlayWidth,
    unlockShortcuts,
    gameMode,
    theme: overlayTheme
  };
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('overlay-settings', settings);
  }
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send('overlay-settings', settings);
  }
  rebuildTrayMenu();
}

function createOverlayWindow() {
  clearTimeout(overlayDestroyTimer);
  if (overlayWindow && !overlayWindow.isDestroyed()) return overlayWindow;

  overlayWindow = new BrowserWindow({
    width: Math.round(overlayWidth * overlayScale),
    height: Math.round(overlayContentHeight(1) * overlayScale),
    minWidth: Math.round(OVERLAY_MIN_WIDTH * OVERLAY_MIN_SCALE),
    minHeight: Math.round(overlayContentHeight(1, 80) * OVERLAY_MIN_SCALE),
    maxWidth: Math.round(OVERLAY_MAX_WIDTH * OVERLAY_MAX_SCALE),
    maxHeight: screen.getPrimaryDisplay().workArea.height,
    ...(overlayPosition || {}),
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    hasShadow: false,
    skipTaskbar: true,
    show: false,
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, 'overlay-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: !app.isPackaged,
      navigateOnDragDrop: false,
      backgroundThrottling: false
    }
  });

  hardenWindow(overlayWindow);
  overlayWindow.setAlwaysOnTop(true, 'screen-saver');
  overlayWindow.loadFile(path.join(__dirname, 'overlay.html'));
  overlayWindow.webContents.once('did-finish-load', () => {
    overlayWindow.webContents.setZoomFactor(overlayScale);
    resizeOverlayWindow(overlayWindow);
    sendOverlayState();
    sendOverlaySettings();
  });
  overlayWindow.on('move', saveOverlaySettings);
  overlayWindow.on('moved', saveActiveGameProfile);
  overlayWindow.on('closed', () => {
    overlayWindow = undefined;
    overlayPassthrough = false;
    sendOverlaySettings();
    if (!mainWindow || mainWindow.isDestroyed()) app.quit();
  });
  return overlayWindow;
}

function setOverlayVisible(visible) {
  if (visible) {
    clearTimeout(overlayDestroyTimer);
    const window = createOverlayWindow();
    window.showInactive();
  } else {
    setOverlayPassthrough(false);
    if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.hide();
    clearTimeout(overlayDestroyTimer);
    overlayDestroyTimer = setTimeout(() => {
      if (overlayWindow && !overlayWindow.isDestroyed() && !overlayWindow.isVisible()) {
        overlayWindow.destroy();
      }
    }, 60000);
  }
  sendOverlaySettings();
}

function setOverlayPassthrough(enabled) {
  overlayPassthrough = Boolean(enabled);
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.setIgnoreMouseEvents(overlayPassthrough, { forward: true });
  }
  sendOverlaySettings();
  saveActiveGameProfile();
}

function setOverlayControlsInteractive(interactive) {
  if (!overlayPassthrough || !overlayWindow || overlayWindow.isDestroyed()) return;
  overlayWindow.setIgnoreMouseEvents(!interactive, { forward: true });
}

function setGameMode(enabled) {
  gameMode = Boolean(enabled);
  sendOverlaySettings();
  saveActiveGameProfile();
}

function setOverlayScale(scale) {
  overlayScale = Math.min(
    OVERLAY_MAX_SCALE,
    Math.max(OVERLAY_MIN_SCALE, Number(scale) || 1)
  );
  const window = createOverlayWindow();
  window.webContents.setZoomFactor(overlayScale);
  resizeOverlayWindow(window);
  saveOverlaySettings();
  sendOverlaySettings();
  saveActiveGameProfile();
}

function setOverlayWidth(width) {
  overlayWidth = Math.min(
    OVERLAY_MAX_WIDTH,
    Math.max(OVERLAY_MIN_WIDTH, Number(width) || 580)
  );
  const window = createOverlayWindow();
  resizeOverlayWindow(window);
  saveOverlaySettings();
  sendOverlaySettings();
  saveActiveGameProfile();
}

function setOverlayTheme(theme) {
  overlayTheme = normalizeOverlayTheme({ ...overlayTheme, ...(theme || {}) });
  resizeOverlayWindow(createOverlayWindow());
  saveOverlaySettings();
  sendOverlaySettings();
  saveActiveGameProfile();
}

function resizeOverlayWindow(window) {
  const current = window.getBounds();
  const width = Math.round(overlayWidth * overlayScale);
  const userCount = typeof remoteHeart === 'undefined' ? 1 :
    (remoteHeart?.snapshot().users.filter((user) => user.selected).length || 1);
  const height = Math.round(overlayContentHeight(userCount) * overlayScale);
  const display = screen.getDisplayMatching(current);
  const area = display.workArea;
  const centeredX = current.x + Math.round((current.width - width) / 2);
  const centeredY = current.y + Math.round((current.height - height) / 2);
  const x = Math.min(
    area.x + area.width - width,
    Math.max(area.x, centeredX)
  );
  const y = Math.min(
    area.y + area.height - height,
    Math.max(area.y, centeredY)
  );
  const nextHeight = Math.min(height, area.height);
  if (current.width !== width || current.height !== nextHeight) {
    window.setBounds({ x, y: Math.max(area.y, y), width, height: nextHeight }, false);
  }
}

function createWindow() {
  const showOnCreate = !initialLaunchHidden;
  initialLaunchHidden = false;
  mainWindow = new BrowserWindow({
    width: 980,
    height: 700,
    minWidth: 720,
    minHeight: 560,
    backgroundColor: '#090b10',
    title: 'Watch Heart',
    show: showOnCreate,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: !app.isPackaged,
      navigateOnDragDrop: false
    }
  });

  hardenWindow(mainWindow);
  mainWindow.webContents.on(
    'select-bluetooth-device',
    (event, deviceList, callback) => {
      event.preventDefault();
      bluetoothSelectionCallback = callback;
      for (const device of deviceList) {
        discoveredDevices.set(device.deviceId, device);
      }
      sendDeviceList();
    }
  );

  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    finishBluetoothSelection();
    mainWindow = undefined;
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  mainWindow.webContents.once('did-finish-load', () => {
    sendOverlaySettings();
    sendAppSettings();
    gameService?.emit();
  });
  mainWindow.on('show', () => {
    sendOverlaySettings();
    gameService?.emit();
  });
}

app.whenReady().then(async () => {
  loadOverlaySettings();
  const remoteSettingsPath = path.join(app.getPath('userData'), 'remote-users.json');
  let savedRemote = {};
  try { savedRemote = JSON.parse(fs.readFileSync(remoteSettingsPath, 'utf8')); } catch {}
  remoteHeart = new RemoteHeartService({
    saved: savedRemote || {},
    onSave: (settings) => {
      fs.writeFileSync(remoteSettingsPath, JSON.stringify(settings, null, 2));
    },
    onChange: (state) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('remote-users-state', state);
      if (overlayWindow && !overlayWindow.isDestroyed()) resizeOverlayWindow(overlayWindow);
      sendOverlayState();
    },
    onConnectionRequest: function(address) { return new Promise(function(resolve) { var win = mainWindow; if (win && !win.isDestroyed()) { dialog.showMessageBox(win, { type: "info", title: "连接请求", message: "设备 " + address + " 请求连接", detail: "是否允许对方连接并查看你的心率？", buttons: ["接受并共享心率", "拒绝"], defaultId: 0, cancelId: 2 }).then(function(result) { resolve(result.response === 0 || result.response === 1); }).catch(function() { resolve(true); }); } else { resolve(true); } }); }
  });
  remoteHeart.start();
  ipcMain.handle('remote-users', async (event, action, data = {}) => {
    if (!isMainSender(event)) return { ok: false, error: '不允许的调用' };
    try {
      if (action === 'connect') await remoteHeart.connect(data);
      else if (action === 'edit') remoteHeart.edit(data.id, data);
      else if (action === 'remove') remoteHeart.remove(data.id);
      else if (action === 'disconnect-relay') { remoteHeart.disconnectRelay(); } else if (action === 'share') await remoteHeart.setSharing(Boolean(data.enabled));
      else if (action !== 'get') throw new Error('未知操作');
      return { ok: true, state: remoteHeart.snapshot() };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });
  gameService = new GameService({
    userDataPath: app.getPath('userData'),
    onState: (state) => {
      if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) {
        mainWindow.webContents.send('game-state', state);
      }
    },
    onGameChanged: ({ previous, current }) => {
      if (previous) gameService.saveProfile(overlayProfile(), previous);
      applyGameProfile(gameService.profileFor(current));
      if (current && gameService.data.autoShow) setOverlayVisible(true);
      if (!current && gameService.data.autoHide) setOverlayVisible(false);
    }
  });

  session.defaultSession.setPermissionRequestHandler(
    (webContents, permission, callback) => {
      callback(
        (
          webContents === mainWindow?.webContents &&
          ['bluetooth', 'geolocation'].includes(permission)
        )
      );
    }
  );
  session.defaultSession.setPermissionCheckHandler(
    (webContents, permission) => (
      (
        webContents === mainWindow?.webContents &&
        ['bluetooth', 'geolocation'].includes(permission)
      )
    )
  );

  ipcMain.on('bluetooth-select', (event, deviceId) => {
    if (!isMainSender(event)) return;
    finishBluetoothSelection(deviceId);
  });

  ipcMain.on('bluetooth-cancel', (event) => {
    if (!isMainSender(event)) return;
    finishBluetoothSelection();
  });

  ipcMain.on('set-always-on-top', (event, enabled) => {
    if (!isMainSender(event)) return;
    mainWindow?.setAlwaysOnTop(Boolean(enabled));
  });

  ipcMain.on('set-auto-start', (event, enabled) => {
    if (!isMainSender(event)) return;
    setAutoStart(Boolean(enabled));
  });

  ipcMain.on('check-for-updates', (event) => {
    if (!isMainSender(event)) return;
    checkForUpdates(true);
  });

  ipcMain.on('install-update', (event) => {
    if (!isMainSender(event)) return;
    isQuitting = true;
    autoUpdater.quitAndInstall(false, true);
  });

  ipcMain.on('overlay-toggle', (event, visible) => {
    if (!isMainSender(event)) return;
    setOverlayVisible(Boolean(visible));
  });

  ipcMain.on('overlay-scale', (event, scale) => {
    if (!isMainSender(event)) return;
    setOverlayScale(scale);
  });

  ipcMain.on('overlay-width', (event, width) => {
    if (!isMainSender(event)) return;
    setOverlayWidth(width);
  });

  ipcMain.on('overlay-theme', (event, theme) => {
    if (!isMainSender(event)) return;
    setOverlayTheme(theme);
  });


  ipcMain.on('overlay-resize-step', (event, step) => {
    if (!isOverlaySender(event)) return;
    setOverlayScale(overlayScale + (Number(step) > 0 ? 0.1 : -0.1));
  });

  ipcMain.on('overlay-passthrough', (event, enabled) => {
    if (!isMainSender(event) && !isOverlaySender(event)) return;
    setOverlayPassthrough(Boolean(enabled));
  });

  ipcMain.on('overlay-interactive-region', (event, interactive) => {
    if (!isOverlaySender(event)) return;
    setOverlayControlsInteractive(Boolean(interactive));
  });

  ipcMain.on('game-mode', (event, enabled) => {
    if (!isMainSender(event)) return;
    setGameMode(enabled);
  });

  ipcMain.on('game-detection-settings', (event, settings) => {
    if (!isMainSender(event)) return;
    gameService.updateSettings(settings);
  });

  ipcMain.on('game-add-custom', (event, game) => {
    if (!isMainSender(event)) return;
    gameService.addCustom(game);
  });

  ipcMain.on('game-save-profile', (event) => {
    if (!isMainSender(event)) return;
    gameService.saveProfile(overlayProfile());
  });

  ipcMain.on('game-clear-sessions', (event) => {
    if (!isMainSender(event)) return;
    gameService.clearSessions();
  });

  ipcMain.on('overlay-close', (event) => {
    if (!isOverlaySender(event)) return;
    setOverlayVisible(false);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      mainWindow.focus();
    } else {
      app.quit();
    }
  });

  ipcMain.on('heart-rate-update', (event, state) => {
    if (!isMainSender(event)) return;
    const bpm = state?.bpm == null ? null : Number(state.bpm);
    overlayState = {
      ...overlayState,
      bpm: Number.isFinite(bpm) && bpm > 0 && bpm <= 255 ? bpm : null,
      connected: Boolean(state?.connected),
      zone: String(state?.zone || '').slice(0, 40),
      zoneLevel: String(state?.zoneLevel || 'idle').slice(0, 20)
    };
    if (overlayState.bpm) gameService.record(overlayState.bpm, overlayState.zoneLevel);
    remoteHeart.updateLocal(overlayState);
    sendOverlayState();
  });

  await createTray();
  createWindow();
  if (!gameService.data.defaultProfile) {
    gameService.data.defaultProfile = overlayProfile();
    gameService.save();
  }
  gameService.start();
  setupAutoUpdater();
  setTimeout(() => checkForUpdates(false), 5000);
  globalShortcut.register('CommandOrControl+Shift+H', () => {
    const shouldShow = !overlayWindow?.isVisible();
    setOverlayVisible(shouldShow);
    if (!shouldShow && mainWindow && !mainWindow.isVisible()) {
      mainWindow.show();
      mainWindow.focus();
    }
  });

  const unlockHandler = () => setOverlayPassthrough(false);
  unlockShortcuts = [
    'CommandOrControl+Shift+L',
    'CommandOrControl+Alt+Shift+L'
  ].filter((accelerator) => globalShortcut.register(accelerator, unlockHandler));
  sendOverlaySettings();

  app.on('activate', () => {
    showMainWindow();
  });
});

app.on('window-all-closed', () => {
  // Keep running in the notification area until the tray Exit command is used.
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  tray?.destroy();
  tray = undefined;
});

app.on('before-quit', () => {
  isQuitting = true;
  remoteHeart?.stop();
  clearTimeout(settingsSaveTimer);
  clearTimeout(overlayDestroyTimer);
  gameService?.stop();
});
