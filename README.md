# ASM — Agent Status Monitor

> AI 编程 Agent 的统一状态监控系统。实时采集 Claude Code、Codex、Copilot、Cursor 等 Agent 的运行状态，通过桌面端和移动端展示交通灯式状态指示。

## 快速开始

```bash
# 安装
npm install -g @aspect-spy/asm

# 或免安装直接使用
npx @aspect-spy/asm install
```

### 三步启动

```bash
# 1. 安装适配器（自动检测已安装的 Agent，选择要启用的）
asm install

# 2. 启动守护进程（后台持续采集状态 + 启动局域网数据服务）
asm daemon

# 3. 查看实时状态
asm status
```

## 支持的 Agent

| Agent | 采集方式 | 状态 |
|-------|---------|------|
| Claude Code | Hooks 事件驱动 | ✔ 已实现 |
| OpenAI Codex | app-server / hooks | ✔ 已实现 |
| GitHub Copilot | REST API 轮询 | ✔ 已实现 |
| Cursor | Cloud API + 文件监控 | ✔ 已实现 |

## 统一状态模型

所有 Agent 的状态都映射到同一个模型：

- **6 种基础状态**: idle / working / waiting / completed / error / offline
- **12+ 种语义动作**: editing / testing / searching / thinking / building / git-operating 等

无论数据来自哪个 Agent，消费端（桌面 App、移动 App）只看统一格式。

## 架构

```
AI Agent (Claude Code / Codex / Copilot / Cursor)
    │
    │  Hooks 事件
    ▼
~/.asm/events.log  (JSON Lines)
    │
    │  asm daemon 持续读取
    ▼
StatusEngine  (状态机引擎)
    │
    ├──▶ ~/.asm/status.json  ──▶ 桌面端 (Electron 系统托盘)
    │
    └──▶ LAN Server (HTTP + SSE) ──▶ 移动端 (Expo APP)
```

## 组件

### Plugin / CLI (`@aspect-spy/asm`)

核心命令行工具，包含适配器安装、守护进程、状态查询。

```bash
npm install -g @aspect-spy/asm
```

### 桌面端 (`asm-desktop`)

Electron 系统托盘应用，交通灯颜色实时反映 Agent 状态。

```bash
cd asm-desktop
npm install && npm run build
# Windows: start.bat
# macOS/Linux: ./start.sh
```

### 移动端 (`asm-mobile`)

Expo (React Native) APP，通过局域网 SSE 实时接收状态推送。

```bash
cd asm-mobile
npm install
npx expo start
```

## 命令参考

| 命令 | 说明 |
|------|------|
| `asm install` | 交互式安装（检测 Agent + 选择适配器） |
| `asm install --agent claude-code` | 直接安装指定适配器 |
| `asm status` | 查看所有 Agent 实时状态 |
| `asm daemon` | 启动守护进程（含 LAN 数据服务） |
| `asm daemon --lan-port 8080` | 自定义 LAN 服务端口 |
| `asm daemon --stop` | 停止守护进程 |
| `asm uninstall` | 卸载适配器 |
| `asm config` | 查看配置 |
| `asm config --set notification.enabled=true` | 修改配置 |

## 局域网数据 API

Daemon 启动后自动在 `0.0.0.0:19527` 开启数据服务，供移动端 APP 消费：

| 端点 | 说明 |
|------|------|
| `GET /api/status` | 完整全局状态 JSON |
| `GET /api/agents` | Agent 列表（扁平数组） |
| `GET /api/stream` | SSE 实时推送 |
| `GET /api/health` | 健康检查 |
| `GET /api/discovery` | 服务发现 |

## 适配器安装细节

以 Claude Code 为例，`asm install` 会：

1. 生成 Hook 脚本到 `~/.asm/hooks/claude-code/`
2. 注入 hooks 配置到 `~/.claude/settings.json`
3. 生成 Plugin 文件到 `~/.asm/adapters/claude-code/plugin/`

Claude Code 运行时，Hooks 自动将事件写入 `~/.asm/events.log`，由 `asm daemon` 消费。

## 配置

配置文件位于 `~/.asm/config.json`：

```json
{
  "adapters": [
    { "type": "claude-code", "enabled": true }
  ],
  "notification": {
    "enabled": true,
    "platform": "auto",
    "triggers": [
      { "state": "completed", "title": "任务完成", "sound": true },
      { "state": "error", "title": "任务出错", "sound": true, "urgency": "critical" },
      { "state": "waiting.permission-waiting", "title": "需要确认权限", "sound": false }
    ]
  },
  "webhook": {
    "enabled": false,
    "url": "https://your-server/api/status"
  }
}
```

## 开发

```bash
git clone https://github.com/aspect-spy/asm.git
cd asm
npm install
npm run dev -- install    # 开发模式运行 install 命令
npm run build             # 构建
```

## License

MIT
