const usersElement = document.querySelector('#overlay-users');
const lockButton = document.querySelector('#overlay-lock');
const controlsElement = document.querySelector('.overlay-controls');
const zoneClasses = ['zone-low', 'zone-normal', 'zone-warm', 'zone-high', 'zone-danger'];

let passthroughEnabled = false;
let controlsInteractive = false;
let gameMode = false;
let currentSettings = {};
let currentUsers = [];
let lastUsersKey = '';
let lastWebWindowSize = '';

const DEFAULT_THEME = {
  preset: 'pulse',
  accent: '#ff315d',
  background: '#0a0c12',
  text: '#f7f8fb',
  opacity: 88,
  blur: 16,
  radius: 18,
  fontScale: 100
};

function hexToRgb(hex) {
  const value = String(hex || '').replace('#', '');
  if (!/^[0-9a-f]{6}$/i.test(value)) return '10, 12, 18';
  return [
    parseInt(value.slice(0, 2), 16),
    parseInt(value.slice(2, 4), 16),
    parseInt(value.slice(4, 6), 16)
  ].join(', ');
}

function applyTheme(theme = {}) {
  const merged = { ...DEFAULT_THEME, ...theme };
  const root = document.documentElement;
  root.style.setProperty('--overlay-accent', merged.accent);
  root.style.setProperty('--overlay-bg-rgb', hexToRgb(merged.background));
  root.style.setProperty('--overlay-text', merged.text);
  root.style.setProperty('--overlay-opacity', String((merged.opacity ?? 88) / 100));
  root.style.setProperty('--overlay-radius', `${merged.radius ?? 18}px`);
  root.style.setProperty('--overlay-font-scale', String((merged.fontScale ?? 100) / 100));
}

function applyHeartZone(level) {
  for (const className of zoneClasses) document.body.classList.remove(className);
  const normalized = String(level || 'idle').toLowerCase();
  const className = zoneClasses.find((name) => name.endsWith(normalized));
  if (className) document.body.classList.add(className);
}

function overlayContentHeight(userCount, fontScale) {
  const normalizedUserCount = Math.max(1, Math.floor(Number(userCount) || 1));
  const rowCount = Math.max(1, Math.ceil(normalizedUserCount / 3));
  const normalizedFontScale = Math.min(1.3, Math.max(0.8, Number(fontScale) || 1));
  const rowHeight = 59.25 + (rowCount - 1) * 77.25;
  return Math.ceil(66 + rowHeight * normalizedFontScale);
}

function resizeWebWindow(width, height) {
  const sizeKey = `${width}x${height}`;
  if (sizeKey === lastWebWindowSize) return;
  lastWebWindowSize = sizeKey;
  requestAnimationFrame(() => {
    try {
      const deltaWidth = width - window.innerWidth;
      const deltaHeight = height - window.innerHeight;
      if (deltaWidth || deltaHeight) window.resizeBy(deltaWidth, deltaHeight);
    } catch {}
  });
}

function applyOverlayLayout() {
  const userCount = Math.max(1, currentUsers.length);
  const fontScale = Math.min(1.3, Math.max(0.8, Number(currentSettings.theme?.fontScale) / 100 || 1));
  const contentHeight = overlayContentHeight(userCount, fontScale);
  const root = document.documentElement;
  root.style.setProperty('--overlay-user-count', String(userCount));
  root.style.setProperty('--overlay-user-columns', `repeat(${Math.min(3, userCount)}, minmax(0, 1fr))`);
  root.style.setProperty('--overlay-content-height', `${contentHeight}px`);

  if (!document.documentElement.classList.contains('web-overlay')) return;
  const scale = Math.min(2, Math.max(0.5, Number(currentSettings.scale) || 1));
  const width = Math.min(1000, Math.max(50, Number(currentSettings.width) || 580));
  root.style.setProperty('--overlay-width', `${width}px`);
  root.style.setProperty('--overlay-scale', String(scale));
  root.style.setProperty('--overlay-scaled-width', `${Math.round(width * scale)}px`);
  root.style.setProperty('--overlay-scaled-height', `${Math.round(contentHeight * scale)}px`);
  resizeWebWindow(Math.round(width * scale), Math.round(contentHeight * scale));
}

function renderUsers(users, state = {}) {
  const normalized = Array.isArray(users) && users.length
    ? users
    : [{
        id: 'local',
        name: '本机',
        connected: Boolean(state.connected),
        bpm: state.bpm == null ? null : Number(state.bpm)
      }];
  const key = JSON.stringify(normalized.map(({ id, name, connected, bpm }) => ({ id, name, connected, bpm })));
  if (key === lastUsersKey) return;
  lastUsersKey = key;
  currentUsers = normalized;
  usersElement.replaceChildren();

  for (const user of normalized) {
    const card = document.createElement('div');
    card.className = `overlay-user${user.connected && user.bpm ? ' active' : ''}`;

    const bpm = document.createElement('strong');
    bpm.className = 'overlay-user-bpm';
    bpm.textContent = user.connected && user.bpm ? String(user.bpm) : '--';

    const name = document.createElement('span');
    name.className = 'overlay-user-name';
    name.textContent = user.name || '用户';
    name.title = user.name || '用户';

    card.append(bpm, name);
    usersElement.append(card);
  }
  applyOverlayLayout();
}

function updateHeartRate(state) {
  renderUsers(state.users, state);
  applyHeartZone(state.users && state.users.length > 1 ? 'idle' : state.zoneLevel || 'idle');
}

window.overlay.onState((state) => {
  updateHeartRate(state);
});

window.overlay.onSettings((settings) => {
  currentSettings = settings;
  applyTheme(settings.theme);
  applyOverlayLayout();

  passthroughEnabled = Boolean(settings.passthrough);
  if (!passthroughEnabled) controlsInteractive = false;
  lockButton.classList.toggle('active', passthroughEnabled);
  lockButton.setAttribute('aria-pressed', String(passthroughEnabled));
  lockButton.title = passthroughEnabled ? '取消鼠标穿透' : '开启鼠标穿透';

  gameMode = Boolean(settings.gameMode);
  document.body.classList.toggle('game-mode', gameMode);
});

document.querySelector('#overlay-smaller').addEventListener('click', () => {
  window.overlay.resizeStep(-1);
});
document.querySelector('#overlay-larger').addEventListener('click', () => {
  window.overlay.resizeStep(1);
});
lockButton.addEventListener('click', () => {
  window.overlay.setPassthrough(!passthroughEnabled);
});
document.querySelector('#overlay-close').addEventListener('click', () => {
  window.overlay.close();
});

document.addEventListener('mousemove', (event) => {
  if (!passthroughEnabled) return;
  const bounds = controlsElement.getBoundingClientRect();
  const interactive =
    event.clientX >= bounds.left &&
    event.clientX <= bounds.right &&
    event.clientY >= bounds.top &&
    event.clientY <= bounds.bottom;
  if (interactive === controlsInteractive) return;
  controlsInteractive = interactive;
  window.overlay.setControlsInteractive(interactive);
});

document.addEventListener('mouseleave', () => {
  if (!passthroughEnabled || !controlsInteractive) return;
  controlsInteractive = false;
  window.overlay.setControlsInteractive(false);
});
