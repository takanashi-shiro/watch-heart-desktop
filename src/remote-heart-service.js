const net = require('node:net');
const { WebSocket, WebSocketServer } = require('ws');

const PORT = 32123;
const PROTOCOL = 'watch-heart/1';
const RELAY_PROTOCOL = 'watch-heart-relay/1';
const DEFAULT_RELAY_PORT = 32124;
const RECONNECT_DELAY_MS = 2000;

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

function normalizeRelayServer(value) {
  let text = String(value || '').trim();
  if (!text) throw new Error('中继服务器地址不能为空');
  if (!text.startsWith('ws://') && !text.startsWith('wss://')) text = `ws://${text}`;
  try {
    const url = new URL(text);
    if (!url.port) url.port = String(DEFAULT_RELAY_PORT);
    url.pathname = '/';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    throw new Error('中继服务器地址无效');
  }
}

function normalizeRoomId(value) {
  const roomId = String(value || '').trim();
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(roomId)) {
    throw new Error('房间 ID 只能包含字母、数字、下划线和连字符，最长 64 个字符');
  }
  return roomId;
}

function normalizePeerId(value) {
  const peerId = String(value || '').trim();
  return /^[A-Za-z0-9_-]{1,64}$/.test(peerId) ? peerId : '';
}

function shortName(value, fallback) {
  return String(value || '').trim().slice(0, 40) || fallback;
}

function randomId(prefix) {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

function relayPeerId(server, roomId, peerId) {
  return `relay-peer:${server}:${roomId}:${peerId}`;
}

function parseLegacyRelayAddress(address) {
  if (typeof address !== 'string' || !address.startsWith('relay:')) return null;
  const value = address.slice('relay:'.length);
  const separator = value.lastIndexOf(':');
  if (separator <= 0) return null;
  try {
    return {
      relayServer: normalizeRelayServer(value.slice(0, separator)),
      roomId: normalizeRoomId(value.slice(separator + 1))
    };
  } catch {
    return null;
  }
}

class RemoteHeartService {
  constructor({
    saved = {},
    onChange = () => {},
    onSave = () => {},
    onConnectionRequest = null,
    sharing = true
  } = {}) {
    this.onChange = onChange;
    this.onSave = onSave;
    this.onConnectionRequest = onConnectionRequest;
    this.local = {
      id: 'local',
      name: shortName(saved.localName, '本机'),
      selected: saved.localSelected !== false,
      connected: false,
      bpm: null
    };
    this.users = new Map();
    this.pending = new Set();
    this.stopped = false;
    this.sharing = Boolean(sharing);
    this.shareError = '';
    this.server = null;
    this.broadcastInterval = null;

    const legacyRelay = Array.isArray(saved.users)
      ? saved.users.map((item) => parseLegacyRelayAddress(item.address)).find(Boolean)
      : null;
    const relaySaved = saved.relay && typeof saved.relay === 'object' ? saved.relay : {};
    const relayServer = relaySaved.server || legacyRelay?.relayServer || '';
    const relayRoomId = relaySaved.roomId || legacyRelay?.roomId || '';

    this.relay = {
      configured: Boolean(relayServer && relayRoomId),
      server: relayServer,
      roomId: relayRoomId,
      name: shortName(relaySaved.name, this.local.name),
      peerId: normalizePeerId(relaySaved.peerId) || randomId('peer'),
      ws: null,
      generation: 0,
      reconnectTimer: null,
      online: false,
      connecting: false,
      error: '',
      peers: new Map(),
      selections: saved.relaySelections && typeof saved.relaySelections === 'object'
        ? { ...saved.relaySelections }
        : {},
      nameOverrides: saved.relayNames && typeof saved.relayNames === 'object'
        ? { ...saved.relayNames }
        : {}
    };

    for (const item of Array.isArray(saved.users) ? saved.users : []) {
      if (!item || typeof item.address !== 'string' || item.address.startsWith('relay:')) continue;
      try {
        const address = endpoint(item.address);
        this.users.set(address.key, {
          id: address.key,
          address: address.key,
          name: shortName(item.name, address.key),
          selected: item.selected !== false,
          online: false,
          connected: false,
          bpm: null,
          type: 'direct'
        });
      } catch {}
    }
  }

  relaySnapshot() {
    return {
      configured: this.relay.configured,
      server: this.relay.server,
      roomId: this.relay.roomId,
      name: this.relay.name,
      peerId: this.relay.peerId,
      online: this.relay.online,
      connecting: this.relay.connecting,
      error: this.relay.error,
      peerCount: this.relay.peers.size + (this.relay.online ? 1 : 0)
    };
  }

  snapshot() {
    const stripInternal = (user) => {
      const copy = { ...user };
      delete copy._wsClient;
      delete copy._reconnectTimer;
      return copy;
    };
    const directUsers = Array.from(this.users.values(), stripInternal);
    const relayUsers = Array.from(this.relay.peers.values(), stripInternal);
    return {
      users: [{ ...this.local }, ...directUsers, ...relayUsers],
      relay: this.relaySnapshot(),
      sharing: this.sharing,
      shareError: this.shareError,
      port: PORT
    };
  }

  publish(save = false) {
    if (save) {
      this.onSave({
        localName: this.local.name,
        localSelected: this.local.selected,
        users: Array.from(this.users.values(), ({ address, name, selected }) => ({
          address,
          name,
          selected
        })),
        relay: {
          server: this.relay.server,
          roomId: this.relay.roomId,
          name: this.relay.name,
          peerId: this.relay.peerId
        },
        relaySelections: { ...this.relay.selections },
        relayNames: { ...this.relay.nameOverrides }
      });
    }
    this.onChange(this.snapshot());
  }

  updateLocal(state) {
    this.local.connected = Boolean(state.connected);
    this.local.bpm = this.local.connected && Number.isFinite(Number(state.bpm))
      ? Number(state.bpm)
      : null;
    this.publish();
    this.broadcast();
  }

  broadcast() {
    const payload = JSON.stringify({
      protocol: PROTOCOL,
      connected: this.local.connected,
      bpm: this.local.bpm
    });
    if (this.server) {
      for (const client of this.server.clients) {
        if (client.readyState === WebSocket.OPEN) client.send(payload);
      }
    }
    this.sendRelayHeartbeat();
  }

  handleRemoteMessage(client, data) {
    try {
      const message = JSON.parse(data);
      if (message.protocol !== PROTOCOL) return;
      for (const user of this.users.values()) {
        if (user._wsClient !== client) continue;
        Object.assign(user, {
          connected: Boolean(message.connected),
          bpm: message.connected ? Number(message.bpm) || null : null,
          online: true
        });
        this.publish();
        return;
      }
    } catch {}
  }

  async setSharing(enabled) {
    const next = Boolean(enabled);
    if (!next) {
      this.server?.close();
      this.server = null;
      this.sharing = false;
      this.shareError = '';
      if (this.broadcastInterval) {
        clearInterval(this.broadcastInterval);
        this.broadcastInterval = null;
      }
      this.publish();
      return;
    }
    if (this.server) return;

    this.shareError = '';
    const server = new WebSocketServer({ port: PORT, maxPayload: 16 * 1024 });
    server.on('connection', async (client) => {
      const address = client._socket?.remoteAddress || '未知';
      let accepted = true;
      if (this.onConnectionRequest) {
        try {
          accepted = await this.onConnectionRequest(address);
        } catch {
          accepted = false;
        }
      }
      if (!accepted) {
        client.close(1008, '连接未获授权');
        return;
      }
      client.on('message', (data) => this.handleRemoteMessage(client, data));
      client.on('close', () => {
        for (const user of this.users.values()) {
          if (user._wsClient !== client) continue;
          Object.assign(user, { online: false, connected: false, bpm: null });
          this.publish();
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
    this.broadcastInterval = setInterval(() => {
      if (!this.stopped) this.broadcast();
    }, 1000);
  }

  start() {
    if (this.sharing) this.setSharing(true);
    for (const user of this.users.values()) this.connectToRemote(user);
    if (this.relay.configured) this.openRelayConnection();
  }

  connectToRemote(user) {
    const ws = new WebSocket(`ws://${user.address}`, { maxPayload: 16 * 1024 });
    user._wsClient = ws;
    ws.on('open', () => {
      Object.assign(user, { online: true, error: '' });
      this.publish();
    });
    ws.on('message', (data) => this.handleRemoteMessage(ws, data));
    ws.on('close', () => {
      if (this.stopped || this.users.get(user.id) !== user) return;
      Object.assign(user, { online: false, connected: false, bpm: null });
      this.publish();
      clearTimeout(user._reconnectTimer);
      user._reconnectTimer = setTimeout(() => {
        if (!this.stopped && this.users.get(user.id) === user) this.connectToRemote(user);
      }, RECONNECT_DELAY_MS);
    });
    ws.on('error', (error) => {
      user.error = error.message;
      this.publish();
    });
  }

  async connect(data) {
    if (data.type === 'relay') return this.connectViaRelay(data);

    const address = endpoint(data.address);
    if (this.users.has(address.key) || this.pending.has(address.key)) {
      throw new Error('该地址已经添加或正在连接');
    }
    this.pending.add(address.key);
    try {
      const user = {
        id: address.key,
        address: address.key,
        name: shortName(data.name, address.key),
        selected: true,
        online: false,
        connected: false,
        bpm: null,
        type: 'direct'
      };
      this.users.set(user.id, user);
      this.publish(true);
      this.connectToRemote(user);
    } finally {
      this.pending.delete(address.key);
    }
  }

  connectViaRelay(data) {
    const server = normalizeRelayServer(data.relayServer);
    const roomId = normalizeRoomId(data.roomId);
    const name = shortName(data.name, this.local.name);

    this.closeRelaySocket();
    this.relay.peers.clear();
    this.relay.configured = true;
    this.relay.server = server;
    this.relay.roomId = roomId;
    this.relay.name = name;
    this.relay.online = false;
    this.relay.connecting = true;
    this.relay.error = '';
    this.local.name = name;
    this.publish(true);
    this.openRelayConnection();
  }

  relayUrl() {
    const url = new URL(this.relay.server);
    url.pathname = `/room/${encodeURIComponent(this.relay.roomId)}`;
    url.searchParams.set('peerId', this.relay.peerId);
    url.searchParams.set('name', this.relay.name);
    return url.toString();
  }

  openRelayConnection() {
    if (this.stopped || !this.relay.configured || this.relay.ws) return;

    const generation = ++this.relay.generation;
    this.relay.connecting = true;
    this.relay.error = '';
    const ws = new WebSocket(this.relayUrl(), { maxPayload: 64 * 1024 });
    this.relay.ws = ws;

    ws.on('open', () => {
      if (this.relay.generation !== generation || this.relay.ws !== ws) {
        ws.close();
        return;
      }
      this.relay.online = true;
      this.relay.connecting = false;
      this.relay.error = '';
      ws.send(JSON.stringify({
        type: 'hello',
        protocol: RELAY_PROTOCOL,
        peerId: this.relay.peerId,
        name: this.relay.name
      }));
      this.sendRelayHeartbeat();
      this.publish();
    });

    ws.on('message', (data) => {
      if (this.relay.generation !== generation || this.relay.ws !== ws) return;
      this.handleRelayMessage(data);
    });

    ws.on('error', (error) => {
      if (this.relay.generation !== generation || this.relay.ws !== ws) return;
      this.relay.error = error.message;
      this.publish();
    });

    ws.on('close', () => {
      if (this.relay.generation !== generation || this.relay.ws !== ws) return;
      this.relay.ws = null;
      this.relay.online = false;
      this.relay.connecting = false;
      for (const peer of this.relay.peers.values()) {
        peer.online = false;
        peer.connected = false;
        peer.bpm = null;
      }
      this.publish();
      clearTimeout(this.relay.reconnectTimer);
      if (!this.stopped && this.relay.configured) {
        this.relay.reconnectTimer = setTimeout(() => this.openRelayConnection(), RECONNECT_DELAY_MS);
      }
    });
  }

  closeRelaySocket() {
    clearTimeout(this.relay.reconnectTimer);
    this.relay.reconnectTimer = null;
    this.relay.generation += 1;
    const ws = this.relay.ws;
    this.relay.ws = null;
    this.relay.online = false;
    this.relay.connecting = false;
    if (ws) {
      try {
        ws.close();
      } catch {}
    }
  }

  upsertRelayPeer(peer) {
    const peerId = normalizePeerId(peer.peerId);
    if (!peerId || peerId === this.relay.peerId) return null;
    const id = relayPeerId(this.relay.server, this.relay.roomId, peerId);
    const existing = this.relay.peers.get(id) || {};
    const user = {
      ...existing,
      id,
      peerId,
      name: shortName(this.relay.nameOverrides[peerId] || peer.name, peerId),
      selected: this.relay.selections[peerId] !== false,
      online: peer.online !== false,
      connected: Boolean(peer.connected),
      bpm: peer.connected && Number.isFinite(Number(peer.bpm)) ? Number(peer.bpm) : null,
      type: 'relay-peer',
      address: `中继房间 ${this.relay.roomId}`
    };
    this.relay.peers.set(id, user);
    return user;
  }

  handleRelayMessage(data) {
    try {
      const message = JSON.parse(data);

      if (message.type === 'room-state' && Array.isArray(message.peers)) {
        const next = new Map();
        for (const peer of message.peers) {
          const user = this.upsertRelayPeer(peer);
          if (user) next.set(user.id, user);
        }
        this.relay.peers = next;
        this.publish();
        return;
      }

      if (message.type === 'heartbeat') {
        const user = this.upsertRelayPeer({
          ...message,
          online: true
        });
        if (user) this.publish();
        return;
      }

      if (message.type === 'peer-joined' || message.type === 'peer-left') {
        this.requestRelayRoomState();
        return;
      }

      if (message.type === 'error') {
        this.relay.error = shortName(message.message, '中继服务器返回错误');
        this.publish();
      }
    } catch {}
  }

  requestRelayRoomState() {
    if (this.relay.ws?.readyState === WebSocket.OPEN) {
      this.relay.ws.send(JSON.stringify({ type: 'room-state', protocol: RELAY_PROTOCOL }));
    }
  }

  sendRelayHeartbeat() {
    const ws = this.relay.ws;
    if (!this.relay.configured || !ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({
      type: 'heartbeat',
      protocol: RELAY_PROTOCOL,
      peerId: this.relay.peerId,
      name: this.relay.name,
      connected: this.local.connected,
      bpm: this.local.bpm,
      timestamp: Date.now()
    }));
  }

  edit(id, patch) {
    if (id === 'local') {
      if (typeof patch.name === 'string') {
        this.local.name = shortName(patch.name, this.local.name);
        this.relay.name = this.local.name;
        this.sendRelayHello();
      }
      if (typeof patch.selected === 'boolean') this.local.selected = patch.selected;
      this.publish(true);
      return;
    }

    const relayPeer = this.relay.peers.get(id);
    if (relayPeer) {
      if (typeof patch.name === 'string') {
        const name = shortName(patch.name, relayPeer.name);
        this.relay.nameOverrides[relayPeer.peerId] = name;
        relayPeer.name = name;
      }
      if (typeof patch.selected === 'boolean') {
        this.relay.selections[relayPeer.peerId] = patch.selected;
        relayPeer.selected = patch.selected;
      }
      this.publish(true);
      return;
    }

    const user = this.users.get(id);
    if (!user) throw new Error('用户不存在');
    if (typeof patch.name === 'string') user.name = shortName(patch.name, user.name);
    if (typeof patch.selected === 'boolean') user.selected = patch.selected;
    this.publish(true);
  }

  sendRelayHello() {
    if (this.relay.ws?.readyState === WebSocket.OPEN) {
      this.relay.ws.send(JSON.stringify({
        type: 'hello',
        protocol: RELAY_PROTOCOL,
        peerId: this.relay.peerId,
        name: this.relay.name
      }));
    }
    this.sendRelayHeartbeat();
  }

  disconnectRelay() {
    this.closeRelaySocket();
    this.relay.configured = false;
    this.relay.server = '';
    this.relay.roomId = '';
    this.relay.error = '';
    this.relay.peers.clear();
    this.publish(true);
  }

  remove(id) {
    const user = this.users.get(id);
    if (!user) throw new Error('用户不存在');
    clearTimeout(user._reconnectTimer);
    try {
      user._wsClient?.close();
    } catch {}
    this.users.delete(id);
    this.publish(true);
  }

  stop() {
    this.stopped = true;
    this.closeRelaySocket();
    for (const user of this.users.values()) {
      clearTimeout(user._reconnectTimer);
      try {
        user._wsClient?.close();
      } catch {}
    }
    this.server?.close();
    this.server = null;
    if (this.broadcastInterval) {
      clearInterval(this.broadcastInterval);
      this.broadcastInterval = null;
    }
  }
}

module.exports = {
  RemoteHeartService,
  endpoint,
  normalizeRelayServer,
  normalizeRoomId,
  PORT,
  PROTOCOL,
  RELAY_PROTOCOL
};
