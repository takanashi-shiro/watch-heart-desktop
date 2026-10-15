const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  remoteUsers: (action, data) => ipcRenderer.invoke('remote-users', action, data),
  onRemoteUsers: (handler) => {
    ipcRenderer.on('remote-users-state', (_event, state) => handler(state));
  },
  onBluetoothDevices: (handler) => {
    ipcRenderer.on('bluetooth-devices', (_event, devices) => handler(devices));
  },
  selectBluetoothDevice: (deviceId) => ipcRenderer.send('bluetooth-select', deviceId),
  cancelBluetoothSelection: () => ipcRenderer.send('bluetooth-cancel'),
  setAlwaysOnTop: (enabled) => ipcRenderer.send('set-always-on-top', enabled),
  setAutoStart: (enabled) => ipcRenderer.send('set-auto-start', enabled),
  onAppSettings: (handler) => {
    ipcRenderer.on('app-settings', (_event, settings) => handler(settings));
  },
  checkForUpdates: () => ipcRenderer.send('check-for-updates'),
  installUpdate: () => ipcRenderer.send('install-update'),
  onUpdateStatus: (handler) => {
    ipcRenderer.on('update-status', (_event, status) => handler(status));
  },
  onTrayHeartRateReconnect: (handler) => {
    ipcRenderer.on('tray-heart-rate-reconnect', () => handler());
  },
  setOverlayVisible: (visible) => ipcRenderer.send('overlay-toggle', visible),
  setOverlayScale: (scale) => ipcRenderer.send('overlay-scale', scale),
  setOverlayWidth: (width) => ipcRenderer.send('overlay-width', width),
  setOverlayTheme: (theme) => ipcRenderer.send('overlay-theme', theme),
  setOverlayPassthrough: (enabled) => ipcRenderer.send('overlay-passthrough', enabled),
  updateHeartRate: (state) => ipcRenderer.send('heart-rate-update', state),
  onOverlaySettings: (handler) => {
    ipcRenderer.on('overlay-settings', (_event, settings) => handler(settings));
  },
  setGameMode: (enabled) => ipcRenderer.send('game-mode', enabled),
  setGameDetectionSettings: (settings) => {
    ipcRenderer.send('game-detection-settings', settings);
  },
  addCustomGame: (game) => ipcRenderer.send('game-add-custom', game),
  saveCurrentGameProfile: () => ipcRenderer.send('game-save-profile'),
  clearGameSessions: () => ipcRenderer.send('game-clear-sessions'),
  onGameState: (handler) => {
    ipcRenderer.on('game-state', (_event, state) => handler(state));
  }
});
