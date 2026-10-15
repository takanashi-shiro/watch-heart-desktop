const net = require('node:net');
const { WebSocket, WebSocketServer } = require('ws');

const PORT = 32123;
const PROTOCOL = 'watch-heart/1';

function endpoint(value) {
  const text = String(value || '').trim();
  const match = text.match(/^(\[?[^:]+]?)(?::(\d+))?$/);
  if (!match) throw new Error('请输入 IPv4 或 IPv6 地址；IPv6 指定端口时请使用 [地址]:端口');
  let host = match[1].replace(/^\[|\]$/g, '');
  const port = Number(match[2] || PORT);
  if (!net.isIP(host) || port < 1 || port > 65535) throw new Error('IP 或端口无效');
  if (net.isIP(host) === 6) {
    const [ip, scope] = host.split('%');
    host = new URL(`http://[${ip}]`).hostname.slice(1, -1) + (scope ? `%${scope}` : '');
  }
  return { host, port, key: `${net.isIP(host) === 6 ? `[${host}]` : host}:${port}` };
}

function normalizeRelayServer(addr) {
  let text = String(addr).trim();
  if (!text) throw new Error('中继服务器地址不能为空');
  if (!text.startsWith('ws://') && !text.startsWith('wss://')) {
    text = 'ws://' + text;
  }
  try {
    const url = new URL(text);
    if (!url.port) url.port = '32124';
    return url.toString();
  } catch (e) {
    throw new Error('中继服务器地址无效: ' + addr);
  }
}

function parseRelayAddress(addr) {
  if (typeof addr !== 'string') return null;
  const idx = addr.indexOf('relay:');
  if (idx !== 0) return null;
  const afterPrefix = addr.slice(6);
  const roomIdx = afterPrefix.lastIndexOf(':');
  if (roomIdx <= 0) return null;
  return { relayServer: afterPrefix.slice(0, roomIdx), roomId: afterPrefix.slice(roomIdx + 1) };
}

class RemoteHeartService {
  constructor({ saved = {}, onChange = () => {}, onSave = () => {}, onConnectionRequest = null } = {}) {
    this.onChange = onChange;
    this.onSave = onSave;
    this.onConnectionRequest = onConnectionRequest;
    this.local = { id: 'local', name: saved.localName || '本机', selected: saved.localSelected !== false, connected: false, bpm: null };
    this.users = new Map();
    this.pending = new Set();
    this.stopped = false;
    this.sharing = true;
    this.shareError = '';
    this.server = null;
    this.broadcastInterval = null;
    this.sharingClients = new Set();
    for (const item of Array.isArray(saved.users) ? saved.users : []) {
      try {
        if (typeof item.address === 'string' && item.address.startsWith('relay:')) {
          this.users.set(item.address, { id: item.address, address: item.address, name: String(item.name || item.address).slice(0, 40), selected: item.selected !== false, connected: false, online: false, bpm: null, type: 'relay' });
        } else {
          const address = endpoint(item.address);
          this.users.set(address.key, { id: address.key, address: address.key, name: String(item.name || address.key).slice(0, 40), selected: item.selected !== false, connected: false, online: false, bpm: null });
        }
      } catch {}
    }
  }

  snapshot() {
    const users = Array.from(this.users.values()).map((user) => { const { _wsClient, ...rest } = user; return rest; }); return { users: [{ ...this.local }, ...users], sharing: this.sharing, shareError: this.shareError, port: PORT };
  }

  publish(save = false) {
    if (save) this.onSave({
      localName: this.local.name, localSelected: this.local.selected,
      users: Array.from(this.users.values(), ({ address, name, selected }) => ({ address, name, selected }))
    });
    this.onChange(this.snapshot());
  }

  updateLocal(state) {
    this.local.connected = Boolean(state.connected);
    this.local.bpm = this.local.connected ? state.bpm : null;
    this.publish();
    this.broadcast();
  }

  broadcast() {
    if (!this.server) return;
    const payload = JSON.stringify({ protocol: PROTOCOL, connected: this.local.connected, bpm: this.local.bpm });
    this.server.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    });
  }

  handleRemoteMessage(client, data) {
    try {
      const message = JSON.parse(data);
      if (message.protocol !== PROTOCOL) return;
      let user = null;
      for (const [key, u] of this.users) {
        if (u._wsClient === client) {
          user = u;
          break;
        }
      }
      if (!user) return;
      Object.assign(user, { connected: message.connected, bpm: message.connected ? message.bpm : null, online: true });
      this.publish();
    } catch {}
  }

  async setSharing(enabled) {
    if (!enabled) {
      this.server?.close();
      this.server = null;
      this.sharing = false;
      this.publish();
      return;
    }
    if (this.server) return;
    this.shareError = '';
    const server = new WebSocketServer({ port: PORT });
    server.on('connection', async (client) => {
      const address = client._socket?.remoteAddress || '未知';
      let accepted = true;
      if (this.onConnectionRequest) {
        try {
          accepted = await this.onConnectionRequest(address);
        } catch (e) {
          accepted = false;
        }
      }
      if (!accepted) {
        client.close();
        return;
      }
      client.on('message', (data) => {
        this.handleRemoteMessage(client, data);
      });
      client.on('close', () => {
        for (const user of this.users.values()) {
          if (user._wsClient === client) {
            Object.assign(user, { online: false, connected: false, bpm: null });
            this.publish();
          }
        }
      });
    });
    server.on('error', (error) => {
      if (this.server !== server) return;
      this.server = null;
      this.sharing = false;
      this.shareError = error.message;
      this.publish();
    });
    this.server = server;
    this.sharing = true;
    this.publish();

    if (this.broadcastInterval) clearInterval(this.broadcastInterval);
    this.broadcastInterval = setInterval(() => {
      if (!this.stopped) this.broadcast();
    }, 1000);
  }

  start() {
    if (this.sharing) {
      this.setSharing(true);
    }
    for (const user of this.users.values()) {
      if (user.type === 'relay') {
        const parsed = parseRelayAddress(user.address);
        if (parsed) this.connectToRelay(user, parsed.relayServer, parsed.roomId);
      } else {
        this.connectToRemote(user);
      }
    }
  }

  connectToRemote(user) {
    const ws = new WebSocket(`ws://${user.address}`);
    user._wsClient = ws;
    ws.on('open', () => {
      Object.assign(user, { online: true });
      this.publish();
    });
    ws.on('message', (data) => {
      try {
        const message = JSON.parse(data);
        if (message.protocol === PROTOCOL) {
          Object.assign(user, { connected: message.connected, bpm: message.connected ? message.bpm : null, online: true });
        }
      } catch {}
    });
    ws.on('close', () => {
      if (!this.stopped) {
        Object.assign(user, { online: false, connected: false, bpm: null });
        this.publish();
        setTimeout(() => {
          if (!this.stopped) this.connectToRemote(user);
        }, 2000);
      }
    });
    ws.on('error', () => {});
  }

  async connect(data) {
    if (data.type === 'relay') {
      return this.connectViaRelay(data);
    }
    const address = endpoint(data.address);
    if (this.users.has(address.key) || this.pending.has(address.key)) throw new Error('该地址已经添加或正在连接');
    this.pending.add(address.key);
    try {
      const user = { id: address.key, address: address.key, name: String(data.name || address.key).trim().slice(0, 40) || address.key, selected: true, online: true, connected: false, bpm: null };
      this.users.set(user.id, user);
      this.publish(true);
      this.connectToRemote(user);
    } finally { this.pending.delete(address.key); }
  }

  connectViaRelay(data) {
    const relayServer = normalizeRelayServer(data.relayServer);
    const relayKey = 'relay:' + relayServer + ':' + data.roomId;
    if (this.users.has(relayKey)) throw new Error('该中继连接已添加');
    const user = { id: relayKey, address: relayKey, name: String(data.name || data.roomId).trim().slice(0, 40) || data.roomId, selected: true, online: true, connected: false, bpm: null, type: 'relay' };
    this.users.set(relayKey, user);
    this.publish(true);
    this.connectToRelay(user, relayServer, data.roomId);
  }

  connectToRelay(user, relayServer, roomId) {
    const url = new URL(relayServer);
    url.pathname = '/room/' + roomId;
    url.searchParams.set('peerId', user.id);
    const ws = new WebSocket(url.toString());
    user._wsClient = ws;
    ws.on('open', () => {
      Object.assign(user, { online: true });
      this.publish();
    });
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data);
        if (msg.type === 'heartbeat') {
          if (msg.peerId) {
            const peer = this.users.get(msg.peerId);
            if (peer) {
              peer._lastHeartbeat = Date.now();
              Object.assign(peer, { connected: msg.connected, bpm: msg.connected ? msg.bpm : null, online: true });
            }
          }
          this.publish();
      }
      } catch {}
    });
    ws.on('close', () => {
      if (!this.stopped) {
        Object.assign(user, { online: false, connected: false, bpm: null });
        this.publish();
      }
    });
    ws.on('error', () => {});
  }

  edit(id, patch) {
    const user = id === 'local' ? this.local : this.users.get(id);
    if (!user) throw new Error('用户不存在');
    if (typeof patch.name === 'string') user.name = patch.name.trim().slice(0, 40) || user.name;
    if (typeof patch.selected === 'boolean') user.selected = patch.selected;
    this.publish(true);
  }

  disconnectRelay() {
    let relayUser = null;
    for (const user of this.users.values()) {
      if (user.type === "relay") { relayUser = user; break; }
    }
    if (relayUser && relayUser._wsClient) {
      relayUser._wsClient.close();
    }
    if (relayUser) {
      this.users.delete(relayUser.id);
      this.publish(true);
    }
  }

  remove(id) {
    this.users.delete(id);
    this.publish(true);
  }

  broadcastToRelay() {
    const now = Date.now();
    for (const user of this.users.values()) {
      if (user.type === 'relay-peer' && user._lastHeartbeat && now - user._lastHeartbeat > 10000) {
        // Peer is stale, remove
        this.users.delete(user.id);
        this.publish();
      }
      if (user.type === 'relay' && user._wsClient && user._wsClient.readyState === WebSocket.OPEN) {
        user._wsClient.send(JSON.stringify({ type: 'heartbeat', connected: this.local.connected, bpm: this.local.bpm, peerId: 'local' }));
      }
    }
  }

  stop() {
    this.stopped = true;
    this.server?.close();
    this.server = null;
    if (this.broadcastInterval) {
      clearInterval(this.broadcastInterval);
      this.broadcastInterval = null;
    this.sharingClients = new Set();
    }
  }
}

module.exports = { RemoteHeartService, endpoint, PORT };
