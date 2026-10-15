const remoteList = document.querySelector('#remote-user-list');
const selectedHearts = document.querySelector('#selected-heart-rates');
const remoteMessage = document.querySelector('#remote-message');
const relayStatusText = document.querySelector('#relay-status-text');
const relayToggle = document.querySelector('#relay-toggle');
const remoteSubmit = document.querySelector('#remote-connect');
const relayServerInput = document.querySelector('#relay-server');
const relayRoomInput = document.querySelector('#relay-room');
const userRows = new Map();
let relayConfigured = false;

async function remoteAction(action, data) {
  try {
    const result = await window.desktop.remoteUsers(action, data);
    if (!result.ok) throw new Error(result.error);
    renderRemoteUsers(result.state);
    return true;
  } catch (error) {
    remoteMessage.textContent = error.message;
    return false;
  }
}

function statusFor(user, relay) {
  if (user.id === 'local') return '本机蓝牙';
  if (user.type === 'relay-peer') {
    if (!user.online) return `中继房间 ${relay.roomId || ''} · 已断线，自动重连中`;
    return `中继房间 ${relay.roomId || ''} · ${user.connected ? '已连接' : '等待心率'}`;
  }
  return `${user.address || '直连'} · ${user.online ? (user.connected ? '已连接' : '等待心率') : '已断线，自动重连中'}`;
}

function renderRelayStatus(relay = {}) {
  relayConfigured = Boolean(relay.configured);
  if (!relayConfigured) {
    relayStatusText.textContent = '中继房间: 未连接';
    relayToggle.textContent = '连接';
    relayToggle.disabled = true;
    return;
  }

  const server = relay.server ? relay.server.replace(/^wss?:\/\//, '') : '';
  const room = relay.roomId || '';
  const state = relay.online
    ? `已连接 · 房间内 ${relay.peerCount || 1} 人`
    : relay.connecting
      ? '连接中'
      : relay.error || '已断线，自动重连中';
  relayStatusText.textContent = `中继房间 ${room} @ ${server} - ${state}`;
  relayToggle.textContent = '断开房间';
  relayToggle.disabled = false;
}

function renderRemoteUsers(state) {
  const relay = state.relay || {};
  renderRelayStatus(relay);
  const local = state.users.find((user) => user.id === 'local');
  if (local) document.querySelector('#local-user-name').textContent = local.name;

  if (state.shareError) remoteMessage.textContent = `共享失败：${state.shareError}`;

  const ids = new Set(state.users.map((user) => user.id));
  for (const [id, row] of userRows) {
    if (!ids.has(id)) {
      row.container.remove();
      userRows.delete(id);
    }
  }

  for (const user of state.users) {
    let row = userRows.get(user.id);
    if (!row) {
      const container = document.createElement('div');
      container.className = 'remote-user-row';

      const selected = document.createElement('input');
      selected.type = 'checkbox';
      selected.addEventListener('change', () => {
        remoteAction('edit', { id: user.id, selected: selected.checked });
      });

      const name = document.createElement('input');
      name.maxLength = 40;
      name.setAttribute('aria-label', '用户名');
      name.addEventListener('change', () => {
        remoteAction('edit', { id: user.id, name: name.value });
      });

      const status = document.createElement('span');
      container.append(selected, name, status);

      if (user.id !== 'local' && user.type !== 'relay-peer') {
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'secondary-button';
        remove.textContent = '移除';
        remove.addEventListener('click', () => remoteAction('remove', { id: user.id }));
        container.append(remove);
      }

      row = { container, selected, name, status };
      userRows.set(user.id, row);
      remoteList.append(container);
    }

    row.selected.checked = user.selected;
    row.selected.setAttribute('aria-label', `显示 ${user.name} 的心率`);
    if (document.activeElement !== row.name) row.name.value = user.name;
    row.status.textContent = statusFor(user, relay);
  }

  selectedHearts.replaceChildren();
  const selectedUsers = state.users.filter((user) => user.selected);
  for (const user of selectedUsers) {
    const card = document.createElement('div');
    card.className = 'user-heart-card';
    const value = document.createElement('strong');
    value.textContent = `${user.connected && user.bpm ? user.bpm : '--'} BPM`;
    const name = document.createElement('span');
    name.textContent = user.name;
    card.append(value, name);
    selectedHearts.append(card);
  }
  if (!selectedHearts.children.length) selectedHearts.textContent = '请选择要显示的用户';
}

function syncConnectionType() {
  const isRelay = document.querySelector('input[name="connection-type"][value="relay"]').checked;
  document.querySelector('.direct-connection-fields').classList.toggle('hidden', isRelay);
  document.querySelector('.relay-connection-fields').classList.toggle('hidden', !isRelay);
  document.querySelector('#remote-address').required = !isRelay;
  relayServerInput.required = isRelay;
  relayRoomInput.required = isRelay;
  remoteSubmit.textContent = isRelay ? '加入房间' : '连接并添加用户';
}

document.querySelectorAll('input[name="connection-type"]').forEach((radio) => {
  radio.addEventListener('change', syncConnectionType);
});
syncConnectionType();

document.querySelector('#remote-connect-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  remoteSubmit.disabled = true;
  remoteMessage.textContent = '正在连接…';

  const isRelay = document.querySelector('input[name="connection-type"][value="relay"]').checked;
  const data = {
    name: document.querySelector('#remote-name').value
  };

  if (isRelay) {
    data.type = 'relay';
    data.relayServer = relayServerInput.value;
    data.roomId = relayRoomInput.value;
  } else {
    data.type = 'direct';
    data.address = document.querySelector('#remote-address').value;
  }

  const ok = await remoteAction('connect', data);
  if (ok) {
    remoteMessage.textContent = isRelay ? '已加入中继房间' : '连接成功，已添加用户';
  }
  remoteSubmit.disabled = false;
});

relayToggle.addEventListener('click', async () => {
  if (relayConfigured) {
    await remoteAction('disconnect-relay', {});
  } else {
    document.querySelector('input[name="connection-type"][value="relay"]').checked = true;
    syncConnectionType();
    relayServerInput.focus();
  }
});

window.desktop.onRemoteUsers(renderRemoteUsers);
remoteAction('get');
