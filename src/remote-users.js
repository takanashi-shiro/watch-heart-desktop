const remoteList = document.querySelector("#remote-user-list");
const selectedHearts = document.querySelector("#selected-heart-rates");
const remoteMessage = document.querySelector("#remote-message");
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
  // Update relay status text (section visibility controlled by radio button)
  const relayUsers = state.users.filter(u => u.type === "relay");
  const relayStatusText = document.querySelector("#relay-status-text");
  const relayToggle = document.querySelector("#relay-toggle");
  if (relayUsers.length > 0) {
    const relayUser = relayUsers[0];
    relayStatusText.textContent = "中继服务器: " + relayUser.address + " - " + (relayUser.online ? "已连接" : "未连接");
    relayToggle.textContent = relayUser.online ? "断开连接" : "连接";
  } else {
    relayStatusText.textContent = "中继服务器: 未连接";
    relayToggle.textContent = "连接";
  }

  const local = state.users.find((user) => user.id === "local");
  if (local) document.querySelector("#local-user-name").textContent = local.name;
  if (state.shareError) remoteMessage.textContent = "共享失败：" + state.shareError;
  const ids = new Set(state.users.map((user) => user.id));
  for (const [id, row] of userRows) {
    if (!ids.has(id)) { row.container.remove(); userRows.delete(id); }
  }
  for (const user of state.users) {
    let row = userRows.get(user.id);
    if (!row) {
      const container = document.createElement("div");
      container.className = "remote-user-row";
      const selected = document.createElement("input");
      selected.type = "checkbox";
      selected.addEventListener("change", () => remoteAction("edit", { id: user.id, selected: selected.checked }));
      const name = document.createElement("input");
      name.maxLength = 40;
      name.setAttribute("aria-label", "用户名");
      name.addEventListener("change", () => remoteAction("edit", { id: user.id, name: name.value }));
      const status = document.createElement("span");
      container.append(selected, name, status);
      if (user.id !== "local") {
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "secondary-button";
        remove.textContent = "移除";
        remove.addEventListener("click", () => remoteAction("remove", { id: user.id }));
        container.append(remove);
      }
      row = { container, selected, name, status };
      userRows.set(user.id, row);
      remoteList.append(container);
    }
    row.selected.checked = user.selected;
    row.selected.setAttribute("aria-label", "显示 " + user.name + " 的心率");
    if (document.activeElement !== row.name) row.name.value = user.name;
    row.status.textContent = (user.address || "本机蓝牙") + " · " + (user.id !== "local" && !user.online ? "已断线，自动重连中" : user.connected ? "已连接" : "等待心率设备");
  }
  selectedHearts.replaceChildren();
  for (const user of state.users.filter((user) => user.selected)) {
    const card = document.createElement("div");
    card.className = "user-heart-card";
    const value = document.createElement("strong");
    value.textContent = (user.connected && user.bpm ? user.bpm : "--") + " BPM";
    const name = document.createElement("span");
    name.textContent = user.name;
    card.append(value, name);
    selectedHearts.append(card);
  }
  if (!selectedHearts.children.length) selectedHearts.textContent = "请选择要显示的用户";
}

document.querySelectorAll("input[name=\"connection-type\"]").forEach(radio => {
  radio.addEventListener("change", () => {
    const isRelay = document.querySelector("input[name=\"connection-type\"][value=\"relay\"]").checked;
    document.querySelector(".direct-connection-fields").style.display = isRelay ? "none" : "";
    document.querySelector(".relay-connection-fields").style.display = isRelay ? "" : "none";
    document.getElementById("remote-address").required = !isRelay;
    // Show/hide relay status section
    const relayStatus = document.querySelector("#relay-status");
    relayStatus.style.display = isRelay ? "block" : "none";
  });
});

document.querySelector("#remote-connect-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = document.querySelector("#remote-connect");
  button.disabled = true;
  remoteMessage.textContent = "正在连接…";
  const isRelay = document.querySelector("input[name=\"connection-type\"][value=\"relay\"]").checked;
  const data = {
    name: document.querySelector("#remote-name").value
  };
  if (isRelay) {
    data.type = "relay";
    data.relayServer = document.querySelector("#relay-server").value;
    data.roomId = document.querySelector("#relay-room").value;
  } else {
    data.type = "direct";
    data.address = document.querySelector("#remote-address").value;
  }
  const ok = await remoteAction("connect", data);
  if (ok) remoteMessage.textContent = "连接成功，已添加用户";
  button.disabled = false;
});

document.querySelector("#relay-toggle").addEventListener("click", () => { remoteAction("disconnect-relay", {}); });

window.desktop.onRemoteUsers(renderRemoteUsers);
remoteAction("get");
