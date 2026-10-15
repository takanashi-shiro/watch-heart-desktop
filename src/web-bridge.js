(() => {
  const isOverlay = window.location.pathname.endsWith('/overlay.html');
  const existing = isOverlay ? window.overlay : window.desktop;
  if (existing) return;

  document.documentElement.classList.add('web-mode');
  const channel = 'BroadcastChannel' in window
    ? new BroadcastChannel('watch-heart-web')
    : null;
  const handlers = new Map();
  const overlayKey = 'watchHeart.web.overlay';
  const defaultOverlaySettings = {
    visible: false,
    passthrough: false,
    scale: 1,
    width: 580,
    unlockShortcuts: ['Ctrl+Shift+H', 'Ctrl+Shift+L'],
    gameMode: false,
    theme: {
      preset: 'pulse',
      accent: '#ff315d',
      background: '#0a0c12',
      text: '#f7f8fb',
      opacity: 88,
      blur: 16,
      radius: 18,
      fontScale: 100
    }
  };

  function loadJson(key, fallback) {
    try {
      return { ...fallback, ...JSON.parse(localStorage.getItem(key) || '{}') };
    } catch {
      return { ...fallback };
    }
  }

  function emit(event, data) {
    for (const handler of handlers.get(event) || []) handler(data);
  }

  function subscribe(event, handler) {
    const list = handlers.get(event) || [];
    list.push(handler);
    handlers.set(event, list);
  }

  function post(message) {
    channel?.postMessage(message);
  }

  async function remoteUsers(action, data = {}) {
    const response = await fetch('/api/remote-users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, data })
    });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.error || '远程用户操作失败');
    if (result.state) applyRemoteState(result.state);
    return result;
  }

  async function refreshRemoteUsers() {
    try {
      const response = await fetch('/api/remote-users');
      const state = await response.json();
      applyRemoteState(state);
      return state;
    } catch (error) {
      console.error('Remote user refresh failed:', error);
      return null;
    }
  }

  if (isOverlay) {
    document.documentElement.classList.add('web-overlay');
    let overlaySettings = loadJson(overlayKey, defaultOverlaySettings);
    let overlayState = {
      bpm: null,
      zone: '等待心率',
      zoneLevel: 'idle',
      connected: false,
      users: []
    };

    channel?.addEventListener('message', (event) => {
      if (event.data?.type === 'overlay-settings') {
        overlaySettings = { ...overlaySettings, ...event.data.settings };
        emit('overlay-settings', overlaySettings);
      }
      if (event.data?.type === 'overlay-state') {
        overlayState = event.data.state;
        emit('overlay-state', overlayState);
      }
      if (event.data?.type === 'overlay-sync-request') {
        post({ type: 'overlay-settings', settings: overlaySettings });
        post({ type: 'overlay-state', state: overlayState });
      }
    });

    window.overlay = {
      onState: (handler) => subscribe('overlay-state', handler),
      onSettings: (handler) => subscribe('overlay-settings', handler),
      resizeStep: (step) => {
        const nextScale = Math.min(2, Math.max(0.5, Number(overlaySettings.scale || 1) + (Number(step) > 0 ? 0.1 : -0.1)));
        overlaySettings.scale = Math.round(nextScale * 10) / 10;
        localStorage.setItem(overlayKey, JSON.stringify(overlaySettings));
        post({ type: 'overlay-settings', settings: overlaySettings });
        emit('overlay-settings', overlaySettings);
      },
      setPassthrough: (enabled) => {
        overlaySettings.passthrough = Boolean(enabled);
        localStorage.setItem(overlayKey, JSON.stringify(overlaySettings));
        post({ type: 'overlay-settings', settings: overlaySettings });
        emit('overlay-settings', overlaySettings);
      },
      setControlsInteractive: () => {},
      close: () => {
        post({ type: 'overlay-closed' });
        window.close();
      }
    };

    queueMicrotask(() => post({ type: 'overlay-sync-request' }));
    return;
  }

  let overlaySettings = loadJson(overlayKey, defaultOverlaySettings);
  let overlayState = {
    bpm: null,
    zone: '等待心率',
    zoneLevel: 'idle',
    connected: false,
    users: []
  };
  let overlayWindow = null;

  function overlaySize(settings = overlaySettings) {
    return {
      width: Math.round(settings.width * settings.scale),
      height: Math.round(96 * settings.scale)
    };
  }

  function resizeOverlayWindow() {
    // The popup sizes itself from its viewport so browser chrome stays accounted for.
  }

  function saveOverlaySettings(patch = {}) {
    overlaySettings = { ...overlaySettings, ...patch };
    localStorage.setItem(overlayKey, JSON.stringify(overlaySettings));
    post({ type: 'overlay-settings', settings: overlaySettings });
    emit('overlay-settings', overlaySettings);
    resizeOverlayWindow();
  }

  function saveOverlayState() {
    post({ type: 'overlay-state', state: overlayState });
  }

  channel?.addEventListener('message', (event) => {
    if (event.data?.type === 'overlay-settings') {
      overlaySettings = { ...overlaySettings, ...event.data.settings };
      emit('overlay-settings', overlaySettings);
    }
    if (event.data?.type === 'overlay-state') {
      overlayState = event.data.state;
      saveOverlayState();
    }
    if (event.data?.type === 'overlay-closed') {
      overlayWindow = null;
      saveOverlaySettings({ visible: false });
    }
    if (event.data?.type === 'overlay-sync-request') {
      post({ type: 'overlay-settings', settings: overlaySettings });
      post({ type: 'overlay-state', state: overlayState });
    }
  });

  const remoteSource = 'EventSource' in window ? new EventSource('/api/events') : null;
  remoteSource?.addEventListener('remote-users', (event) => {
    applyRemoteState(JSON.parse(event.data));
  });

  function applyRemoteState(state) {
    emit('remote-users-state', state);
    overlayState = {
      ...overlayState,
      users: state.users.filter((user) => user.selected)
    };
    saveOverlayState();
  }

  window.desktop = {
    remoteUsers,
    onRemoteUsers: (handler) => {
      subscribe('remote-users-state', handler);
      refreshRemoteUsers();
    },
    onBluetoothDevices: (handler) => subscribe('bluetooth-devices', handler),
    selectBluetoothDevice: () => {},
    cancelBluetoothSelection: () => {},
    setAlwaysOnTop: () => {},
    setAutoStart: () => {},
    onAppSettings: (handler) => {
      handler({ autoStart: false, autoStartSupported: false, trayAvailable: false });
    },
    checkForUpdates: () => {},
    installUpdate: () => {},
    onUpdateStatus: (handler) => {
      handler({ state: 'web', message: 'Web 模式由浏览器管理' });
    },
    onTrayHeartRateReconnect: (handler) => subscribe('tray-heart-rate-reconnect', handler),
    setOverlayVisible: (visible) => {
      const show = Boolean(visible);
      if (show && (!overlayWindow || overlayWindow.closed)) {
        const { width, height } = overlaySize();
        overlayWindow = window.open(
          './overlay.html',
          'watch-heart-overlay',
          `popup=yes,width=${width},height=${height}`
        );
      }
      if (!show && overlayWindow && !overlayWindow.closed) overlayWindow.close();
      saveOverlaySettings({ visible: show && Boolean(overlayWindow && !overlayWindow.closed) });
    },
    setOverlayScale: (scale) => saveOverlaySettings({ scale: Math.min(2, Math.max(0.5, Number(scale) || 1)) }),
    setOverlayWidth: (width) => saveOverlaySettings({ width: Math.min(1000, Math.max(50, Number(width) || 580)) }),
    setOverlayTheme: (theme) => saveOverlaySettings({ theme: { ...overlaySettings.theme, ...theme } }),
    setOverlayPassthrough: (enabled) => saveOverlaySettings({ passthrough: Boolean(enabled) }),
    updateHeartRate: (state) => {
      overlayState = {
        ...overlayState,
        bpm: state?.bpm == null ? null : Number(state.bpm),
        connected: Boolean(state?.connected),
        zone: String(state?.zone || '').slice(0, 40),
        zoneLevel: String(state?.zoneLevel || 'idle').slice(0, 20)
      };
      saveOverlayState();
      fetch('/api/heart-rate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(overlayState)
      }).catch((error) => console.error('Heart rate sync failed:', error));
    },
    onOverlaySettings: (handler) => {
      subscribe('overlay-settings', handler);
      handler(overlaySettings);
    },
    setGameMode: (enabled) => saveOverlaySettings({ gameMode: Boolean(enabled) }),
    setGameDetectionSettings: () => {},
    addCustomGame: () => {},
    saveCurrentGameProfile: () => {},
    clearGameSessions: () => {},
    onGameState: (handler) => {
      handler({
        enabled: false,
        autoShow: false,
        autoHide: false,
        activeGame: null,
        activeSession: null,
        sessions: []
      });
    }
  };

  queueMicrotask(() => {
    emit('overlay-settings', overlaySettings);
    refreshRemoteUsers();
  });
})();
