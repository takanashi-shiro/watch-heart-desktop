const remoteList = document.querySelector('#remote-user-list');
const selectedHearts = document.querySelector('#selected-heart-rates');
const remoteMessage = document.querySelector('#remote-message');
const sharingInput = document.querySelector('#remote-sharing');
const userRows = new Map();

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

function renderRemoteUsers(state) {
  sharingInput.checked = state.sharing;
  const local = state.users.find((user) => user.id === 'local');
  if (local) document.querySelector('#local-user-name').textContent = local.name;
  if (state.shareError) remoteMessage.textContent = `共享失败：${state.shareError}`;
  const ids = new Set(state.users.map((user) => user.id));
  for (const [id, row] of userRows) {
    if (!ids.has(id)) { row.container.remove(); userRows.delete(id); }
  }
  for (const user of state.users) {
    let row = userRows.get(user.id);
    if (!row) {
      const container = document.createElement('div');
      container.className = 'remote-user-row';
      const selected = document.createElement('input');
      selected.type = 'checkbox';
      selected.addEventListener('change', () => remoteAction('edit', { id: user.id, selected: selected.checked }));
      const name = document.createElement('input');
      name.maxLength = 40;
      name.setAttribute('aria-label', '用户名');
      name.addEventListener('change', () => remoteAction('edit', { id: user.id, name: name.value }));
      const status = document.createElement('span');
      container.append(selected, name, status);
      if (user.id !== 'local') {
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
    row.status.textContent = `${user.address || '本机蓝牙'} · ${user.id !== 'local' && !user.online ? '已断线，自动重连中' : user.connected ? '已连接' : '等待心率设备'}`;
  }
  selectedHearts.replaceChildren();
  for (const user of state.users.filter((user) => user.selected)) {
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

document.querySelector('#remote-connect-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = document.querySelector('#remote-connect');
  button.disabled = true;
  remoteMessage.textContent = '正在连接…';
  const ok = await remoteAction('connect', {
    address: document.querySelector('#remote-address').value,
    name: document.querySelector('#remote-name').value
  });
  if (ok) remoteMessage.textContent = '连接成功，已添加用户';
  button.disabled = false;
});
sharingInput.addEventListener('change', async () => {
  sharingInput.disabled = true;
  const enabled = sharingInput.checked;
  remoteMessage.textContent = '';
  if (!await remoteAction('share', { enabled })) sharingInput.checked = false;
  sharingInput.disabled = false;
});
window.desktop.onRemoteUsers(renderRemoteUsers);
remoteAction('get');
