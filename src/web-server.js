const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { RemoteHeartService } = require('./remote-heart-service');

const WEB_PORT = 32125;
const WEB_HOST = process.env.WATCH_HEART_WEB_HOST || '127.0.0.1';
const WEB_ROOT = __dirname;
const DATA_DIR = path.join(os.homedir(), '.watch-heart');
const REMOTE_SETTINGS_PATH = path.join(DATA_DIR, 'remote-users.json');

const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml'
};

fs.mkdirSync(DATA_DIR, { recursive: true });

let savedRemote = {};
try {
  savedRemote = JSON.parse(fs.readFileSync(REMOTE_SETTINGS_PATH, 'utf8'));
} catch {}

const eventClients = new Set();

function sendEvent(name, data) {
  const payload = `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of eventClients) client.write(payload);
}

const remoteHeart = new RemoteHeartService({
  saved: savedRemote,
  onSave: (settings) => {
    fs.writeFileSync(REMOTE_SETTINGS_PATH, JSON.stringify(settings, null, 2));
  },
  onChange: (state) => sendEvent('remote-users', state),
  onConnectionRequest: async () => true,
  sharing: false
});

function json(response, status, value) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  response.end(JSON.stringify(value));
}

function readBody(request, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('请求内容过大'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(new Error('JSON 格式无效'));
      }
    });
    request.on('error', reject);
  });
}

function serveStatic(request, response, pathname) {
  const requested = pathname === '/' ? '/index.html' : pathname;
  let decoded;
  try {
    decoded = decodeURIComponent(requested);
  } catch {
    response.writeHead(400).end('Bad Request');
    return;
  }

  const resolved = path.resolve(WEB_ROOT, `.${decoded}`);
  if (resolved !== WEB_ROOT && !resolved.startsWith(`${WEB_ROOT}${path.sep}`)) {
    response.writeHead(403).end('Forbidden');
    return;
  }

  fs.stat(resolved, (error, stat) => {
    if (error || !stat.isFile()) {
      response.writeHead(404).end('Not Found');
      return;
    }
    response.writeHead(200, {
      'Content-Type': MIME_TYPES[path.extname(resolved).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    fs.createReadStream(resolved).pipe(response);
  });
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url || '/', `http://${request.headers.host || WEB_HOST}`);

  if (request.method === 'GET' && url.pathname === '/api/config') {
    json(response, 200, {
      mode: 'web',
      port: WEB_PORT,
      platform: process.platform,
      features: {
        bluetooth: 'browser',
        remoteUsers: true,
        overlay: true
      }
    });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/remote-users') {
    json(response, 200, remoteHeart.snapshot());
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/remote-users') {
    try {
      const { action, data = {} } = await readBody(request);
      if (action === 'connect') await remoteHeart.connect(data);
      else if (action === 'edit') remoteHeart.edit(data.id, data);
      else if (action === 'remove') remoteHeart.remove(data.id);
      else if (action === 'disconnect-relay') remoteHeart.disconnectRelay();
      else if (action === 'share') await remoteHeart.setSharing(Boolean(data.enabled));
      else if (action !== 'get') throw new Error('未知操作');
      json(response, 200, { ok: true, state: remoteHeart.snapshot() });
    } catch (error) {
      json(response, 400, { ok: false, error: error.message });
    }
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/heart-rate') {
    try {
      const state = await readBody(request);
      remoteHeart.updateLocal(state);
      json(response, 200, { ok: true });
    } catch (error) {
      json(response, 400, { ok: false, error: error.message });
    }
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/events') {
    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    });
    response.write(': connected\n\n');
    eventClients.add(response);
    response.on('close', () => eventClients.delete(response));
    return;
  }

  if (request.method === 'GET' || request.method === 'HEAD') {
    serveStatic(request, response, url.pathname);
    return;
  }

  response.writeHead(405, { Allow: 'GET, HEAD, POST' }).end('Method Not Allowed');
});

remoteHeart.start();
server.listen(WEB_PORT, WEB_HOST, () => {
  console.log(`Watch Heart Web: http://${WEB_HOST}:${WEB_PORT}`);
});

function shutdown() {
  for (const client of eventClients) client.end();
  eventClients.clear();
  remoteHeart.stop();
  server.close(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
