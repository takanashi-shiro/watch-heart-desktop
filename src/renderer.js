const HEART_RATE_SERVICE = 'heart_rate';
const HEART_RATE_MEASUREMENT = 'heart_rate_measurement';
const MAX_POINTS = 120;

const elements = {
  alwaysOnTop: document.querySelector('#always-on-top'),
  autoStart: document.querySelector('#auto-start'),
  checkUpdate: document.querySelector('#check-update'),
  installUpdate: document.querySelector('#install-update'),
  updateStatus: document.querySelector('#update-status'),
  statusDot: document.querySelector('#status-dot'),
  statusText: document.querySelector('#status-text'),
  deviceName: document.querySelector('#device-name'),
  heartPulse: document.querySelector('#heart-pulse'),
  bpm: document.querySelector('#bpm-value'),
  zone: document.querySelector('#zone-pill'),
  connect: document.querySelector('#connect-button'),
  disconnect: document.querySelector('#disconnect-button'),
  min: document.querySelector('#min-value'),
  avg: document.querySelector('#avg-value'),
  max: document.querySelector('#max-value'),
  canvas: document.querySelector('#heart-chart'),
  chartEmpty: document.querySelector('#chart-empty'),
  modal: document.querySelector('#device-modal'),
  deviceList: document.querySelector('#device-list'),
  cancelScan: document.querySelector('#cancel-scan')
};

const overlayControls = {
  visible: document.querySelector('#overlay-visible'),
  size: document.querySelector('#overlay-size'),
  sizeValue: document.querySelector('#overlay-size-value'),
  width: document.querySelector('#overlay-width'),
  widthValue: document.querySelector('#overlay-width-value'),
  passthrough: document.querySelector('#overlay-passthrough'),
  gameMode: document.querySelector('#game-mode')
};

const heartZoneControls = {
  warm: document.querySelector('#zone-warm-threshold'),
  high: document.querySelector('#zone-high-threshold'),
  danger: document.querySelector('#zone-danger-threshold'),
  alarm: document.querySelector('#zone-alarm-enabled')
};

const themeControls = {
  preset: document.querySelector('#overlay-theme-preset'),
  accent: document.querySelector('#theme-accent'),
  background: document.querySelector('#theme-background'),
  text: document.querySelector('#theme-text'),
  opacity: document.querySelector('#theme-opacity'),
  opacityValue: document.querySelector('#theme-opacity-value'),
  radius: document.querySelector('#theme-radius'),
  radiusValue: document.querySelector('#theme-radius-value'),
  fontScale: document.querySelector('#theme-font-scale'),
  fontScaleValue: document.querySelector('#theme-font-scale-value')
};

const THEME_PRESETS = {
  pulse: {
    accent: '#ff315d',
    background: '#0a0c12',
    text: '#f7f8fb',
    opacity: 88,
    blur: 16,
    radius: 18,
    fontScale: 100
  },
  neon: {
    accent: '#00e5ff',
    background: '#090021',
    text: '#f6f0ff',
    opacity: 82,
    blur: 20,
    radius: 20,
    fontScale: 104
  },
  ice: {
    accent: '#61a8ff',
    background: '#071522',
    text: '#edf7ff',
    opacity: 84,
    blur: 18,
    radius: 16,
    fontScale: 100
  },
  amber: {
    accent: '#ffb02e',
    background: '#180f05',
    text: '#fff8ec',
    opacity: 88,
    blur: 12,
    radius: 14,
    fontScale: 102
  },
  minimal: {
    accent: '#ffffff',
    background: '#000000',
    text: '#ffffff',
    opacity: 58,
    blur: 0,
    radius: 12,
    fontScale: 96
  }
};

const gameControls = {
  enabled: document.querySelector('#game-detection-enabled'),
  autoShow: document.querySelector('#game-auto-show'),
  autoHide: document.querySelector('#game-auto-hide'),
  status: document.querySelector('#active-game-status'),
  name: document.querySelector('#game-profile-name'),
  executable: document.querySelector('#game-profile-exe'),
  save: document.querySelector('#game-profile-save'),
  clear: document.querySelector('#game-session-clear'),
  sessions: document.querySelector('#game-session-list')
};

let bluetoothDevice;
let heartRateCharacteristic;
let reconnectTimer;
let reconnectAttempts = 0;
let intentionalDisconnect = false;
let samples = [];
let lastKnownDevices = [];
let lowResourceMode = false;
let syncingThemeControls = false;
let currentTheme = { preset: 'pulse', ...THEME_PRESETS.pulse };
let themeUpdateTimer;
let heartZoneSettings = readHeartZoneSettings();
let lastAlarmAt = 0;

function formatBpm(value) {
  return value == null ? '--' : String(value);
}

function formatDuration(ms) {
  const minutes = Math.max(1, Math.round(Number(ms || 0) / 60000));
  if (minutes < 60) return `${minutes} 分钟`;
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟`;
}

function renderGameState(state) {
  gameControls.enabled.checked = state.enabled !== false;
  gameControls.autoShow.checked = state.autoShow !== false;
  gameControls.autoHide.checked = state.autoHide !== false;
  gameControls.status.textContent = state.activeGame
    ? `正在记录：${state.activeGame.name} (${state.activeGame.executable})`
    : '当前未检测到游戏';
  if (state.activeGame) {
    gameControls.name.value = state.activeGame.name;
    gameControls.executable.value = state.activeGame.executable;
  }
  gameControls.sessions.replaceChildren();
  const sessions = [state.activeSession, ...(state.sessions || [])].filter(Boolean);
  if (!sessions.length) {
    const empty = document.createElement('span');
    empty.textContent = '暂无游戏场次记录';
    gameControls.sessions.append(empty);
    return;
  }
  for (const session of sessions.slice(0, 8)) {
    const row = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = `${session.endedAt ? '' : '进行中 · '}${session.gameName}`;
    const stats = document.createElement('span');
    stats.textContent =
      `${new Date(session.startedAt).toLocaleString()} · ${formatDuration(session.durationMs)} · ` +
      `平均 ${formatBpm(session.averageBpm)} · 最高 ${formatBpm(session.maxBpm)} BPM · ` +
      `危险 ${session.dangerEvents || 0} 次`;
    row.append(title, stats);
    gameControls.sessions.append(row);
  }
}

function setStatus(type, text) {
  elements.statusDot.className = `status-dot ${type || ''}`.trim();
  elements.statusText.textContent = text;
}

function setControls(connected) {
  elements.connect.disabled = connected;
  elements.disconnect.disabled = !connected && !bluetoothDevice;
}

function renderUpdateStatus(status) {
  const message = status?.message || '自动更新已启用';
  elements.updateStatus.textContent = message;
  elements.updateStatus.title = message;
  elements.checkUpdate.disabled = ['checking', 'downloading'].includes(status?.state);
  elements.installUpdate.classList.toggle('hidden', status?.state !== 'downloaded');
}

function readThemeControls() {
  return {
    preset: themeControls.preset.value,
    accent: themeControls.accent.value,
    background: themeControls.background.value,
    text: themeControls.text.value,
    opacity: Number(themeControls.opacity.value),
    radius: Number(themeControls.radius.value),
    fontScale: Number(themeControls.fontScale.value)
  };
}

function syncThemeControls(theme) {
  syncingThemeControls = true;
  currentTheme = { ...currentTheme, ...theme };
  themeControls.preset.value = currentTheme.preset || 'pulse';
  themeControls.accent.value = currentTheme.accent;
  themeControls.background.value = currentTheme.background;
  themeControls.text.value = currentTheme.text;
  themeControls.opacity.value = String(currentTheme.opacity);
  themeControls.opacityValue.textContent = `${Math.round(currentTheme.opacity)}%`;
  themeControls.radius.value = String(currentTheme.radius);
  themeControls.radiusValue.textContent = String(Math.round(currentTheme.radius));
  themeControls.fontScale.value = String(currentTheme.fontScale);
  themeControls.fontScaleValue.textContent = `${Math.round(currentTheme.fontScale)}%`;
  syncingThemeControls = false;
}

function publishTheme(theme, immediate = false) {
  currentTheme = { ...currentTheme, ...theme };
  themeControls.opacityValue.textContent = `${Math.round(currentTheme.opacity)}%`;
  themeControls.radiusValue.textContent = String(Math.round(currentTheme.radius));
  themeControls.fontScaleValue.textContent = `${Math.round(currentTheme.fontScale)}%`;
  clearTimeout(themeUpdateTimer);
  const send = () => window.desktop.setOverlayTheme(currentTheme);
  if (immediate) send();
  else themeUpdateTimer = setTimeout(send, 80);
}

function normalizeHeartZoneSettings(settings) {
  const warm = Math.min(180, Math.max(50, Number(settings?.warm) || 100));
  const high = Math.min(220, Math.max(warm + 5, Number(settings?.high) || 140));
  const danger = Math.min(240, Math.max(high + 5, Number(settings?.danger) || 170));
  return {
    warm,
    high,
    danger,
    alarm: Boolean(settings?.alarm)
  };
}

function readHeartZoneSettings() {
  try {
    return normalizeHeartZoneSettings(
      JSON.parse(localStorage.getItem('heartZoneSettings') || '{}')
    );
  } catch {
    return normalizeHeartZoneSettings({});
  }
}

function syncHeartZoneControls() {
  heartZoneControls.warm.value = String(heartZoneSettings.warm);
  heartZoneControls.high.value = String(heartZoneSettings.high);
  heartZoneControls.danger.value = String(heartZoneSettings.danger);
  heartZoneControls.alarm.checked = heartZoneSettings.alarm;
}

function saveHeartZoneSettings() {
  heartZoneSettings = normalizeHeartZoneSettings({
    warm: heartZoneControls.warm.value,
    high: heartZoneControls.high.value,
    danger: heartZoneControls.danger.value,
    alarm: heartZoneControls.alarm.checked
  });
  localStorage.setItem('heartZoneSettings', JSON.stringify(heartZoneSettings));
  syncHeartZoneControls();
}

function playDangerAlarm() {
  if (!heartZoneSettings.alarm || Date.now() - lastAlarmAt < 5000) return;
  lastAlarmAt = Date.now();
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return;
  const audio = new AudioContextClass();
  const oscillator = audio.createOscillator();
  const gain = audio.createGain();
  oscillator.type = 'sine';
  oscillator.frequency.setValueAtTime(880, audio.currentTime);
  oscillator.frequency.setValueAtTime(660, audio.currentTime + 0.16);
  gain.gain.setValueAtTime(0.0001, audio.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.16, audio.currentTime + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + 0.34);
  oscillator.connect(gain).connect(audio.destination);
  oscillator.start();
  oscillator.stop(audio.currentTime + 0.36);
  setTimeout(() => audio.close().catch(() => {}), 600);
}

function showModal() {
  elements.modal.classList.remove('hidden');
  const placeholder = document.createElement('div');
  placeholder.className = 'device-placeholder';
  placeholder.textContent = '正在搜索…';
  elements.deviceList.replaceChildren(placeholder);
}

function hideModal() {
  elements.modal.classList.add('hidden');
}

function renderDeviceList(devices) {
  lastKnownDevices = devices;
  elements.deviceList.replaceChildren();

  if (!devices.length) {
    const placeholder = document.createElement('div');
    placeholder.className = 'device-placeholder';
    placeholder.textContent = '尚未发现设备，请开启设备的蓝牙心率广播；扫描不到时可取消后启用兼容扫描';
    elements.deviceList.append(placeholder);
    return;
  }

  for (const device of devices) {
    const button = document.createElement('button');
    button.className = 'device-item';
    button.type = 'button';

    const name = document.createElement('span');
    name.textContent = device.name;
    const action = document.createElement('small');
    action.textContent = '连接';

    button.append(name, action);
    button.addEventListener('click', () => {
      window.desktop.selectBluetoothDevice(device.id);
      hideModal();
      setStatus('scanning', '正在连接');
    });
    elements.deviceList.append(button);
  }
}

function parseHeartRate(dataView) {
  if (!dataView || dataView.byteLength < 2) return null;
  const flags = dataView.getUint8(0);
  const usesUint16 = (flags & 0x01) !== 0;
  if (usesUint16 && dataView.byteLength < 3) return null;
  return usesUint16 ? dataView.getUint16(1, true) : dataView.getUint8(1);
}

function heartRateScanOptions() {
  return document.querySelector('#bluetooth-scan-all').checked
    ? { acceptAllDevices: true, optionalServices: [HEART_RATE_SERVICE] }
    : { filters: [{ services: [HEART_RATE_SERVICE] }] };
}

function zoneFor(bpm) {
  if (bpm >= heartZoneSettings.danger) return ['zone-danger', '危险区间', 'danger'];
  if (bpm >= heartZoneSettings.high) return ['zone-high', '高强度', 'high'];
  if (bpm >= heartZoneSettings.warm) return ['zone-warm', '活跃区间', 'warm'];
  if (bpm < 60) return ['zone-low', '低强度', 'low'];
  return ['zone-normal', '舒缓区间', 'normal'];
}

function updateHeartRate(bpm) {
  if (!Number.isFinite(bpm) || bpm <= 0 || bpm > 255) return;

  elements.bpm.textContent = String(bpm);
  elements.heartPulse.classList.add('active');
  elements.heartPulse.style.setProperty(
    '--beat-duration',
    `${Math.max(0.28, 60 / bpm)}s`
  );

  const [zoneClass, zoneLabel, zoneLevel] = zoneFor(bpm);
  elements.zone.className = `zone-pill ${zoneClass}`;
  elements.zone.textContent = zoneLabel;
  if (zoneLevel === 'danger') playDangerAlarm();

  samples.push({ bpm, time: Date.now() });
  if (samples.length > MAX_POINTS) samples.shift();

  const values = samples.map((sample) => sample.bpm);
  elements.min.textContent = String(Math.min(...values));
  elements.max.textContent = String(Math.max(...values));
  elements.avg.textContent = String(
    Math.round(values.reduce((sum, value) => sum + value, 0) / values.length)
  );
  elements.chartEmpty.classList.add('hidden');
  if (!document.hidden && !lowResourceMode) drawChart();
  window.desktop.updateHeartRate({
    bpm,
    connected: true,
    zone: zoneLabel,
    zoneLevel
  });
}

function onHeartRateChanged(event) {
  updateHeartRate(parseHeartRate(event.target.value));
}

async function connectGatt() {
  if (!bluetoothDevice) return;

  clearTimeout(reconnectTimer);
  setStatus('scanning', reconnectAttempts ? '正在重新连接' : '正在连接');

  try {
    heartRateCharacteristic?.removeEventListener('characteristicvaluechanged', onHeartRateChanged);
    heartRateCharacteristic = undefined;
    const server = await bluetoothDevice.gatt.connect();
    const service = await server.getPrimaryService(HEART_RATE_SERVICE);
    heartRateCharacteristic = await service.getCharacteristic(
      HEART_RATE_MEASUREMENT
    );
    heartRateCharacteristic.addEventListener(
      'characteristicvaluechanged',
      onHeartRateChanged
    );
    await heartRateCharacteristic.startNotifications();

    reconnectAttempts = 0;
    setStatus('connected', '已连接');
    setControls(true);
    window.desktop.updateHeartRate({ connected: true });
  } catch (error) {
    if (['NotFoundError', 'NotSupportedError', 'SecurityError'].includes(error.name)) {
      disconnect();
      setStatus('error', error.name === 'SecurityError'
        ? '无法访问心率服务，请重新扫描授权'
        : '设备未提供可用的标准蓝牙心率服务，请开启心率广播或选择其他设备');
      return;
    }
    scheduleReconnect(error);
  }
}

function scheduleReconnect(error) {
  clearTimeout(reconnectTimer);
  if (intentionalDisconnect || !bluetoothDevice) {
    setStatus('error', '连接已断开');
    return;
  }

  reconnectAttempts += 1;
  const delay = Math.min(15000, 1000 * 2 ** Math.min(reconnectAttempts - 1, 4));
  setStatus('error', `${Math.round(delay / 1000)} 秒后重连`);
  console.error('BLE connection failed:', error);
  reconnectTimer = setTimeout(connectGatt, delay);
}

function onGattDisconnected() {
  if (intentionalDisconnect) return;
  setControls(false);
  window.desktop.updateHeartRate({ connected: false });
  scheduleReconnect(new Error('GATT disconnected'));
}

async function requestAndConnect() {
  if (!navigator.bluetooth) {
    setStatus('error', '当前系统不支持蓝牙');
    return;
  }

  intentionalDisconnect = false;
  clearTimeout(reconnectTimer);
  showModal();
  setStatus('scanning', '正在扫描');

  try {
    const device = await navigator.bluetooth.requestDevice(heartRateScanOptions());

    if (bluetoothDevice && bluetoothDevice !== device) {
      bluetoothDevice.removeEventListener('gattserverdisconnected', onGattDisconnected);
      heartRateCharacteristic?.removeEventListener('characteristicvaluechanged', onHeartRateChanged);
      if (bluetoothDevice.gatt?.connected) bluetoothDevice.gatt.disconnect();
      heartRateCharacteristic = undefined;
    }
    bluetoothDevice = device;
    elements.deviceName.textContent = device.name || '蓝牙心率设备';
    bluetoothDevice.addEventListener('gattserverdisconnected', onGattDisconnected);
    setControls(false);
    await connectGatt();
  } catch (error) {
    hideModal();
    if (error.name === 'NotFoundError') {
      setStatus('', '已取消扫描');
    } else {
      setStatus('error', '扫描或连接失败');
      console.error('Bluetooth request failed:', error);
    }
  }
}

function disconnect() {
  intentionalDisconnect = true;
  clearTimeout(reconnectTimer);

  if (heartRateCharacteristic) {
    heartRateCharacteristic.removeEventListener(
      'characteristicvaluechanged',
      onHeartRateChanged
    );
  }
  bluetoothDevice?.removeEventListener('gattserverdisconnected', onGattDisconnected);
  if (bluetoothDevice?.gatt?.connected) bluetoothDevice.gatt.disconnect();

  heartRateCharacteristic = undefined;
  bluetoothDevice = undefined;
  reconnectAttempts = 0;
  elements.deviceName.textContent = '';
  elements.bpm.textContent = '--';
  elements.heartPulse.classList.remove('active');
  elements.zone.className = 'zone-pill zone-idle';
  elements.zone.textContent = '等待心率';
  setStatus('', '尚未连接');
  setControls(false);
  window.desktop.updateHeartRate({
    bpm: null,
    connected: false,
    zone: '等待心率',
    zoneLevel: 'idle'
  });
}

async function reconnectFromTray() {
  intentionalDisconnect = false;
  clearTimeout(reconnectTimer);
  if (bluetoothDevice) {
    if (bluetoothDevice.gatt?.connected && heartRateCharacteristic) {
      setStatus('connected', '已连接');
      return;
    }
    await connectGatt();
    return;
  }
  await requestAndConnect();
}

function drawChart() {
  const canvas = elements.canvas;
  const rect = canvas.getBoundingClientRect();
  const scale = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.floor(rect.width * scale));
  const height = Math.max(1, Math.floor(rect.height * scale));

  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }

  const ctx = canvas.getContext('2d');
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.clearRect(0, 0, rect.width, rect.height);

  const padding = 10;
  const chartWidth = rect.width - padding * 2;
  const chartHeight = rect.height - padding * 2;

  ctx.strokeStyle = 'rgba(255,255,255,0.055)';
  ctx.lineWidth = 1;
  for (let index = 0; index < 4; index += 1) {
    const y = padding + (chartHeight * index) / 3;
    ctx.beginPath();
    ctx.moveTo(padding, y);
    ctx.lineTo(rect.width - padding, y);
    ctx.stroke();
  }

  if (!samples.length) return;

  const points = samples.map((sample, index) => ({
    x:
      padding +
      (samples.length === 1 ? chartWidth / 2 : (chartWidth * index) / (MAX_POINTS - 1)),
    y: padding + chartHeight - ((sample.bpm - 40) / 180) * chartHeight
  }));

  const gradient = ctx.createLinearGradient(0, padding, 0, rect.height - padding);
  gradient.addColorStop(0, 'rgba(255,49,93,0.34)');
  gradient.addColorStop(1, 'rgba(255,49,93,0)');

  ctx.beginPath();
  ctx.moveTo(points[0].x, rect.height - padding);
  for (const point of points) ctx.lineTo(point.x, point.y);
  ctx.lineTo(points.at(-1).x, rect.height - padding);
  ctx.closePath();
  ctx.fillStyle = gradient;
  ctx.fill();

  ctx.beginPath();
  points.forEach((point, index) => {
    if (index === 0) ctx.moveTo(point.x, point.y);
    else ctx.lineTo(point.x, point.y);
  });
  ctx.strokeStyle = '#ff315d';
  ctx.lineWidth = 2.2;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.shadowColor = 'rgba(255,49,93,0.5)';
  ctx.shadowBlur = 8;
  ctx.stroke();
  ctx.shadowBlur = 0;
}

elements.connect.addEventListener('click', requestAndConnect);
elements.disconnect.addEventListener('click', disconnect);
elements.cancelScan.addEventListener('click', () => {
  window.desktop.cancelBluetoothSelection();
  hideModal();
  setStatus('', '已取消扫描');
});
elements.alwaysOnTop.addEventListener('change', (event) => {
  window.desktop.setAlwaysOnTop(event.target.checked);
});
elements.autoStart.addEventListener('change', (event) => {
  window.desktop.setAutoStart(event.target.checked);
});
elements.checkUpdate.addEventListener('click', () => {
  renderUpdateStatus({ state: 'checking', message: '正在检查更新…' });
  window.desktop.checkForUpdates();
});
elements.installUpdate.addEventListener('click', () => {
  renderUpdateStatus({ state: 'installing', message: '正在重启安装更新…' });
  window.desktop.installUpdate();
});
overlayControls.visible.addEventListener('change', (event) => {
  window.desktop.setOverlayVisible(event.target.checked);
});
overlayControls.size.addEventListener('input', (event) => {
  const value = Number(event.target.value);
  overlayControls.sizeValue.textContent = `${value}%`;
  window.desktop.setOverlayScale(value / 100);
});
overlayControls.width.addEventListener('input', (event) => {
  const value = Number(event.target.value);
  overlayControls.widthValue.textContent = String(value);
  window.desktop.setOverlayWidth(value);
});
overlayControls.passthrough.addEventListener('change', (event) => {
  window.desktop.setOverlayPassthrough(event.target.checked);
});
overlayControls.gameMode.addEventListener('change', (event) => {
  localStorage.setItem('gameMode', String(event.target.checked));
  window.desktop.setGameMode(event.target.checked);
});
function updateGameDetectionSettings() {
  window.desktop.setGameDetectionSettings({
    enabled: gameControls.enabled.checked,
    autoShow: gameControls.autoShow.checked,
    autoHide: gameControls.autoHide.checked
  });
}
gameControls.enabled.addEventListener('change', updateGameDetectionSettings);
gameControls.autoShow.addEventListener('change', updateGameDetectionSettings);
gameControls.autoHide.addEventListener('change', updateGameDetectionSettings);
gameControls.save.addEventListener('click', () => {
  const executable = gameControls.executable.value.trim();
  if (executable) {
    window.desktop.addCustomGame({
      executable,
      name: gameControls.name.value.trim() || executable
    });
  }
  window.desktop.saveCurrentGameProfile();
  gameControls.status.textContent = '已保存当前游戏悬浮条配置';
});
gameControls.clear.addEventListener('click', () => {
  window.desktop.clearGameSessions();
});
[
  heartZoneControls.warm,
  heartZoneControls.high,
  heartZoneControls.danger,
  heartZoneControls.alarm
].forEach((control) => {
  control.addEventListener('change', saveHeartZoneSettings);
});
themeControls.preset.addEventListener('change', (event) => {
  const preset = event.target.value;
  const theme = { preset, ...(THEME_PRESETS[preset] || currentTheme) };
  syncThemeControls(theme);
  publishTheme(theme, true);
});
[
  themeControls.accent,
  themeControls.background,
  themeControls.text,
  themeControls.opacity,
  themeControls.radius,
  themeControls.fontScale
].forEach((control) => {
  control.addEventListener('input', () => {
    if (syncingThemeControls) return;
    themeControls.preset.value = 'custom';
    publishTheme({ ...readThemeControls(), preset: 'custom' });
  });
});
window.desktop.onBluetoothDevices(renderDeviceList);
window.desktop.onAppSettings((settings) => {
  elements.autoStart.checked = settings.autoStart;
  elements.autoStart.disabled = settings.autoStartSupported === false;
  elements.autoStart.title = settings.autoStartSupported === false
    ? '当前平台不支持开机启动'
    : '';
});
window.desktop.onUpdateStatus(renderUpdateStatus);
window.desktop.onTrayHeartRateReconnect(reconnectFromTray);
window.desktop.onOverlaySettings((settings) => {
  const wasLowResourceMode = lowResourceMode;
  lowResourceMode = settings.gameMode;
  overlayControls.visible.checked = settings.visible;
  overlayControls.passthrough.checked = settings.passthrough;
  overlayControls.size.value = String(Math.round(settings.scale * 100));
  overlayControls.sizeValue.textContent = `${Math.round(settings.scale * 100)}%`;
  overlayControls.width.value = String(settings.width);
  overlayControls.widthValue.textContent = String(settings.width);
  overlayControls.gameMode.checked = settings.gameMode;
  syncThemeControls(settings.theme || currentTheme);
  if (wasLowResourceMode && !lowResourceMode) drawChart();
});
window.desktop.onGameState(renderGameState);
window.addEventListener('resize', drawChart);
syncHeartZoneControls();
drawChart();

const savedGameMode = localStorage.getItem('gameMode') === 'true';
overlayControls.gameMode.checked = savedGameMode;
window.desktop.setGameMode(savedGameMode);
