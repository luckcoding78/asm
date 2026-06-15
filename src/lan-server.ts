/**
 * ASM LAN Server — 局域网数据推送服务
 *
 * 纯数据 API，供移动端 APP 消费：
 * - GET /api/status     → 当前全局状态 (JSON)
 * - GET /api/agents     → Agent 列表 (JSON Array)
 * - GET /api/stream     → Server-Sent Events 实时推送
 * - GET /api/health     → 健康检查 + 服务发现
 * - GET /api/discovery  → 服务发现（返回服务名称和版本）
 *
 * 移动端 APP 通过 SSE 接收实时数据推送，自行渲染 UI。
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { networkInterfaces } from "node:os";
import { readFileSync, existsSync } from "node:fs";
import { STATUS_FILE, type GlobalState, type AgentSnapshot } from "./core/protocol.js";

// ── 类型 ──
interface LanServerOptions {
  port: number;
  host?: string;
}

// ── SSE 客户端管理 ──
type SSEClient = {
  id: number;
  response: ServerResponse;
};

let sseClients: SSEClient[] = [];
let sseClientIdCounter = 0;

// ── 获取局域网 IP ──
export function getLanIPs(): string[] {
  const ips: string[] = [];
  const nets = networkInterfaces();

  for (const name of Object.keys(nets)) {
    const net = nets[name];
    if (!net) continue;
    for (const info of net) {
      if (info.internal || info.family === "IPv6") continue;
      ips.push(info.address);
    }
  }
  return ips;
}

// ── 读取当前状态 ──
function readCurrentState(): GlobalState | null {
  if (!existsSync(STATUS_FILE)) return null;
  try {
    return JSON.parse(readFileSync(STATUS_FILE, "utf-8"));
  } catch {
    return null;
  }
}

// ── CORS 头 ──
function setAPIHeaders(res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("X-ASM-Service", "asm-lan-server");
  res.setHeader("X-ASM-Version", "0.1.0");
}

// ── JSON 响应 ──
function sendJSON(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

// ── 请求处理（纯数据 API）──
function handleRequest(req: IncomingMessage, res: ServerResponse): void {
  setAPIHeaders(res);

  // OPTIONS 预检
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const path = url.pathname;

  switch (path) {
    // ── 完整全局状态 ──
    case "/api/status": {
      const state = readCurrentState();
      sendJSON(res, state ?? {
        protocolVersion: "1.0.0",
        lastUpdated: new Date().toISOString(),
        agents: {},
      });
      return;
    }

    // ── Agent 列表（扁平数组，方便 APP 直接渲染列表）──
    case "/api/agents": {
      const state = readCurrentState();
      const agents: AgentSnapshot[] = state?.agents
        ? Object.values(state.agents)
        : [];
      sendJSON(res, {
        count: agents.length,
        agents,
        lastUpdated: state?.lastUpdated ?? new Date().toISOString(),
        protocolVersion: state?.protocolVersion ?? "1.0.0",
      });
      return;
    }

    // ── SSE 实时推送 ──
    case "/api/stream": {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      });

      const clientId = ++sseClientIdCounter;
      sseClients.push({ id: clientId, response: res });

      // 连接确认
      res.write(`event: connected\ndata: ${JSON.stringify({ clientId, server: "asm-lan-server", version: "0.1.0" })}\n\n`);

      // 立即发送当前状态快照
      const state = readCurrentState();
      if (state) {
        res.write(`event: state\ndata: ${JSON.stringify(state)}\n\n`);
      }

      // 心跳（30 秒）
      const heartbeat = setInterval(() => {
        res.write(`: heartbeat\n\n`);
      }, 30000);

      // 客户端断开
      req.on("close", () => {
        clearInterval(heartbeat);
        sseClients = sseClients.filter(c => c.id !== clientId);
      });
      return;
    }

    // ── 健康检查 ──
    case "/api/health": {
      sendJSON(res, {
        status: "ok",
        service: "asm-lan-server",
        version: "0.1.0",
        uptime: Math.floor(process.uptime()),
        sseClients: sseClients.length,
      });
      return;
    }

    // ── 服务发现（APP 可扫描局域网端口，通过此接口确认是 ASM 服务）──
    case "/api/discovery": {
      const state = readCurrentState();
      sendJSON(res, {
        service: "asm-lan-server",
        version: "0.1.0",
        protocolVersion: state?.protocolVersion ?? "1.0.0",
        agentCount: state?.agents ? Object.keys(state.agents).length : 0,
        endpoints: ["/api/status", "/api/agents", "/api/stream", "/api/health"],
      });
      return;
    }

    // ── 根路径也返回 JSON（不再有 HTML 页面）──
    default: {
      sendJSON(res, {
        service: "asm-lan-server",
        version: "0.1.0",
        endpoints: {
          status: "/api/status",
          agents: "/api/agents",
          stream: "/api/stream",
          health: "/api/health",
          discovery: "/api/discovery",
        },
      });
      return;
    }
  }
}

// ── 推送状态更新到所有 SSE 客户端 ──
export function broadcastStateUpdate(state: GlobalState): void {
  const payload = `event: state\ndata: ${JSON.stringify(state)}\n\n`;
  for (const client of sseClients) {
    try {
      client.response.write(payload);
    } catch {
      // 客户端已断开
    }
  }
}

// ── 启动 LAN 服务 ──
export function startLanServer(opts: LanServerOptions): Server {
  const server = createServer(handleRequest);

  const bindHost = opts.host || "0.0.0.0";
  server.listen(opts.port, bindHost, () => {
    const lanIPs = getLanIPs();
    console.log();

    if (bindHost === "0.0.0.0" && lanIPs.length > 0) {
      console.log(`  📡 LAN 数据服务已启动 (所有网络接口):`);
      for (const ip of lanIPs) {
        console.log(`     http://${ip}:${opts.port}`);
      }
      console.log();
      console.log(`  ⚠ 服务对所有网络接口可见。如在公共网络，请使用:`);
      console.log(`    asm daemon --lan-host 127.0.0.1  (仅本机)`);
    } else if (lanIPs.length > 0) {
      console.log(`  📡 LAN 数据服务已启动 (${bindHost}):`);
      for (const ip of lanIPs) {
        console.log(`     http://${ip}:${opts.port}`);
      }
    } else {
      console.log(`  📡 LAN 数据服务已启动: http://localhost:${opts.port}`);
    }

    console.log();
    console.log(`  📱 APP 连接 /api/stream 获取实时推送`);
    console.log(`  📋 数据接口: /api/status | /api/agents`);
    console.log();
  });

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(`  ⚠ 端口 ${opts.port} 已被占用，LAN 服务未启动`);
      console.error(`    请尝试: asm daemon --lan-port ${opts.port + 1}`);
    } else {
      console.error(`  ⚠ LAN 服务启动失败:`, err.message);
    }
  });

  return server;
}

// ── 停止 LAN 服务 ──
export function stopLanServer(server: Server): void {
  for (const client of sseClients) {
    try {
      client.response.end();
    } catch {}
  }
  sseClients = [];
  server.close();
}
