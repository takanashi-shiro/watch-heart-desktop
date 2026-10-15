# Watch Heart

Watch Heart 是一个跨 Windows、macOS 和 Linux 的 BLE 心率接收与显示工具，可接收标准 BLE 心率设备或手机心率广播 App 的数据。它既可以通过 Electron 客户端启动，也可以作为独立 Web 应用启动。

## 功能

- 连接标准 BLE 心率设备
- 实时 BPM、最近 2 分钟趋势和最低/平均/最高值
- 可配置心率区间与危险区间声音提醒
- 游戏悬浮条：置顶、缩放、宽度、多用户 BPM 卡片和鼠标穿透
- 悬浮条预设主题与自定义颜色
- 多用户心率直连和中继连接
- Windows、macOS、Linux 客户端打包配置
- 独立 Web 模式，默认部署在 `32125` 端口
- 桌面客户端自动更新

天气、媒体读取和歌词功能已移除。

## 启动方式

安装依赖：

```bash
npm install
```

### 桌面客户端

```bash
npm run start:client
```

也可以使用：

```bash
npm start
```

桌面客户端提供托盘、开机启动、自动更新、游戏识别和原生悬浮窗。开机启动目前支持 Windows 与 macOS；Linux 会禁用该选项。

### 独立 Web

```bash
npm run start:web
```

启动后访问：

```text
http://127.0.0.1:32125
```

Web 启动固定使用 `32125` 端口。默认只监听 `127.0.0.1`；需要局域网访问时，可设置 `WATCH_HEART_WEB_HOST=0.0.0.0` 后启动。

Web 模式使用浏览器 Web Bluetooth：

- 推荐 Chrome 或 Edge
- 必须从 `localhost`、`127.0.0.1` 或 HTTPS 安全上下文访问
- macOS 首次使用时允许浏览器访问蓝牙
- Linux 需要系统蓝牙可用，并确保浏览器具有蓝牙权限

Web 模式支持心率连接、实时趋势、心率区间、Web 悬浮窗和多用户远程心率。Web 悬浮窗与客户端共用同一套悬浮条页面、主题、心率状态、缩放和宽度控件。浏览器无法提供原生窗口置顶和真正的鼠标穿透，因此这两项在 Web 模式中只保留同步设置与视觉状态。客户端专属的自动更新、开机启动、托盘、原生悬浮窗和游戏识别不在 Web 模式启用。

## 心率连接

1. 打开手表、心率带、臂带或手机 App 的标准 BLE 心率广播。
2. 点击“扫描并连接”。
3. 在设备选择窗口中选择设备。
4. 连接断开后，程序会自动尝试重连。

如果普通扫描找不到设备，可开启“兼容扫描”。设备最终仍需提供标准心率服务。

## 悬浮条

桌面客户端悬浮条是原生置顶窗口；Web 模式通过浏览器弹出窗口显示。

常用操作：

- 显示/隐藏：`Ctrl+Shift+H`
- 鼠标穿透后恢复操作：`Ctrl+Shift+L`
- 调整大小：使用悬浮条上的 − / ＋ 按钮

## 多用户远程心率

支持两种连接方式：

- 中继房间：多个客户端连接同一个服务器和房间 ID，服务器将房间内所有用户的实时心率广播给每个成员。
- 直连局域网 IP：IPv6 指定端口时使用 `[IPv6]:端口`。

中继服务器：

```text
ws://server.ip.test.com:32124
```

中继房间使用 WebSocket 地址：

```text
ws://server.ip.test.com:32124/room/<房间ID>?peerId=<节点ID>&name=<显示名称>
```

同一房间内的用户会分别显示在主界面、选中心率卡片和悬浮窗中；中继服务器只作为传输节点，不会被显示成一个用户。客户端会保存房间地址、房间 ID、本机显示名和用户选择，并在断线后自动重连。

直连共享使用 `32123` 端口，没有身份认证，只应在可信网络、VPN 或受控防火墙环境中使用。Web 模式默认不监听共享端口；需要共享时可通过远程用户接口开启。

## 打包

在目标平台生成未打包目录：

```bash
npm run pack
```

按平台构建：

```powershell
npm run dist:win
npm run dist:mac
npm run dist:linux
```

也可以使用：

```bash
npm run dist
```

`npm run dist` 根据当前运行平台选择目标。建议分别在 Windows、macOS、Linux 构建并验证对应安装包：

- Windows：NSIS 安装版、Portable
- macOS：DMG、ZIP
- Linux：AppImage、DEB

## 项目结构

```text
src/main.js                 Electron 主进程、窗口、托盘、自动更新
src/preload.js              桌面客户端安全 IPC 接口
src/renderer.js             主界面、蓝牙连接、图表和设置
src/game-service.js         跨平台游戏进程识别与场次统计
src/remote-heart-service.js 多用户直连、共享和中继连接
src/remote-users.js         多用户界面
src/index.html              主界面
src/web-server.js           独立 Web 服务，固定端口 32125
src/web-bridge.js           浏览器模式适配层
src/overlay.html            悬浮条页面
src/overlay.js              悬浮条逻辑
```

## 隐私说明

- BLE 心率数据默认只在本机处理。
- 多用户共享时，心率数据只发送给已连接的对端。
- Web 模式会在用户主目录的 `.watch-heart` 目录保存远程用户配置。
- 程序不会上传心率数据到统计服务。

## 许可证

MIT
