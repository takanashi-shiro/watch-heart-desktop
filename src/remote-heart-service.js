const http = require('node:http');
const net = require('node:net');
const { URL } = require('node:url');

const PORT = 32123;
const PATH = '/watch-heart/v1';

function endpoint(value) {
  const text = String(value || '').trim();
  const match = net.isIP(text) === 6 ? [text, text] :
    text.match(/^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/);
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

function readRemote(address) {
  return new Promise((resolve, reject) => {
    const request = http.get({
      hostname: address.host, port: address.port, path: PATH, timeout: 3000
    }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('error', reject);
      response.on('data', (chunk) => {
        body += chunk;
        if (body.length > 4096) request.destroy(new Error('响应过大'));
      });
      response.on('end', () => {
        try {
          const data = JSON.parse(body);
          if (response.statusCode !== 200 || data.protocol !== 'watch-heart/1' ||
              typeof data.connected !== 'boolean' ||
              (data.bpm !== null && (!Number.isInteger(data.bpm) || data.bpm < 1 || data.bpm > 255))) {
            throw new Error('对方不是兼容的心率共享服务');
          }
          resolve({ connected: data.connected, bpm: data.connected ? data.bpm : null });
        } catch (error) { reject(error); }
      });
    });
    const deadline = setTimeout(() => request.destroy(new Error('连接超时')), 4000);
    request.on('close', () => clearTimeout(deadline));
    request.on('timeout', () => request.destroy(new Error('连接超时')));
    request.on('error', reject);
  });
}

class RemoteHeartService {
  constructor({ saved = {}, onChange = () => {}, onSave = () => {} } = {}) {
    this.onChange = onChange;
    this.onSave = onSave;
    this.local = { id: 'local', name: saved.localName || '本机', selected: saved.localSelected !== false, connected: false, bpm: null };
    this.users = new Map();
    this.pending = new Set();
    this.stopped = false;
    this.sharing = false;
    this.shareError = '';
    for (const item of Array.isArray(saved.users) ? saved.users : []) {
      try {
        const address = endpoint(item.address);
        this.users.set(address.key, { id: address.key, address: address.key, name: String(item.name || address.key).slice(0, 40), selected: item.selected !== false, connected: false, online: false, bpm: null });
      } catch {}
    }
  }

  snapshot() {
    return { users: [{ ...this.local }, ...Array.from(this.users.values(), (user) => ({ ...user }))], sharing: this.sharing, shareError: this.shareError, port: PORT };
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
  }

  async connect(value, name) {
    const address = endpoint(value);
    if (this.users.has(address.key) || this.pending.has(address.key)) throw new Error('该地址已经添加或正在连接');
    this.pending.add(address.key);
    try {
      const state = await readRemote(address);
      if (this.stopped) throw new Error('服务已停止');
      const user = { id: address.key, address: address.key, name: String(name || address.key).trim().slice(0, 40) || address.key, selected: true, online: true, ...state };
      this.users.set(user.id, user);
      this.publish(true);
      this.poll(user);
    } finally { this.pending.delete(address.key); }
  }

  edit(id, patch) {
    const user = id === 'local' ? this.local : this.users.get(id);
    if (!user) throw new Error('用户不存在');
    if (typeof patch.name === 'string') user.name = patch.name.trim().slice(0, 40) || user.name;
    if (typeof patch.selected === 'boolean') user.selected = patch.selected;
    this.publish(true);
  }

  remove(id) {
    this.users.delete(id);
    this.publish(true);
  }

  async poll(user) {
    while (!this.stopped && this.users.get(user.id) === user) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      if (this.stopped || this.users.get(user.id) !== user) return;
      try {
        const state = await readRemote(endpoint(user.address));
        Object.assign(user, state, { online: true });
      } catch {
        Object.assign(user, { online: false, connected: false, bpm: null });
      }
      if (!this.stopped && this.users.get(user.id) === user) this.publish();
    }
  }

  start() {
    for (const user of this.users.values()) this.poll(user);
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
    const server = http.createServer((request, response) => {
      if (request.method !== 'GET' || request.url !== PATH) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify({ protocol: 'watch-heart/1', connected: this.local.connected, bpm: this.local.bpm }));
    });
    server.requestTimeout = 5000;
    server.headersTimeout = 5000;
    server.keepAliveTimeout = 1000;
    this.server = server;
    server.on('error', (error) => {
      if (this.server !== server) return;
      this.server = null;
      this.sharing = false;
      this.shareError = error.message;
      this.publish();
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      // Omitting host lets Node use dual-stack IPv6, with IPv4 fallback if unavailable.
      server.listen({ port: PORT, ipv6Only: false }, resolve);
    });
    if (this.server === server) this.sharing = true;
    this.publish();
  }

  stop() {
    this.stopped = true;
    this.server?.close();
  }
}

module.exports = { RemoteHeartService, endpoint, readRemote, PORT, PATH };
