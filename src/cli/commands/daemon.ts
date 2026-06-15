/**
 * ASM CLI — daemon 命令
 * 启动后台状态聚合守护进程，持续读取 events.log 并推送到 Status Engine
 */

import { existsSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { fork, type ChildProcess } from "node:child_process";
import pc from "picocolors";
import {
  ASM_DIR, EVENTS_LOG, STATUS_FILE, CONFIG_FILE,
  type StatusEvent, type BaseState, type SemanticAction,
  createEventId, nowISO, getDefaultConfig,
} from "../../core/protocol.js";
import { StatusEngine } from "../../core/engine.js";
import { startLanServer, broadcastStateUpdate, stopLanServer } from "../../lan-server.js";

const PID_FILE = join(ASM_DIR, "daemon.pid");

export async function daemonCommand(opts: { start?: boolean; stop?: boolean; lanPort?: number; lanHost?: string }) {
  if (opts.stop) {
    return stopDaemon();
  }

  // 默认行为：前台运行
  console.log();
  console.log(pc.bold("  ASM Daemon") + pc.dim(" — 状态聚合守护进程"));
  console.log(pc.dim("  监听 events.log，实时更新 Agent 状态。"));
  console.log(pc.dim("  按 Ctrl+C 停止。"));
  console.log();

  const engine = new StatusEngine();

  // 读取已有的 events.log 偏移量
  let lastOffset = 0;
  if (existsSync(EVENTS_LOG)) {
    lastOffset = statSync(EVENTS_LOG).size;
  }

  // 记录 PID
  writeFileSync(PID_FILE, String(process.pid), "utf-8");

  // 启动 LAN 服务
  const lanPort = opts.lanPort || 39527;
  const lanHost = opts.lanHost;  // undefined → 默认 0.0.0.0（局域网可访问）
  const lanServer = startLanServer({ port: lanPort, host: lanHost });

  // 启动文件监听循环
  console.log(pc.green("  ✔ Daemon 已启动") + pc.dim(` (PID: ${process.pid})`));

  const pollInterval = 1000; // 每秒检查一次

  const timer = setInterval(async () => {
    if (!existsSync(EVENTS_LOG)) return;

    const currentSize = statSync(EVENTS_LOG).size;
    if (currentSize <= lastOffset) return;

    // 读取完整内容，提取 lastOffset 之后的新增部分
    const allContent = readFileSync(EVENTS_LOG, "utf-8");
    const newContent = Buffer.from(allContent, "utf-8").subarray(lastOffset).toString("utf-8");

    // 按换行分割并去除 \r（兼容 Windows \r\n 和 Unix \n）
    const newLines = newContent.split("\n").map(l => l.trimEnd()).filter(Boolean);

    let newLinesProcessed = 0;

    for (const line of newLines) {
      try {
        const rawEvent = JSON.parse(line);
        const statusEvent = parseRawEvent(rawEvent);
        if (statusEvent) {
          const result = engine.processEvent(statusEvent);
          if (result.updated) {
            const icon = result.shouldNotify ? "🔔" : "  ";
            console.log(
              `  ${icon} ${pc.dim(statusEvent.timestamp.slice(11, 19))} ` +
              `${pc.bold(statusEvent.agent)} ` +
              `${statusColor(statusEvent.baseState)(statusEvent.displayText)}`
            );
            broadcastStateUpdate(engine.getState());
          }
          newLinesProcessed++;
        }
      } catch (err: any) {
        // 跳过格式错误的行
      }
    }

    lastOffset = currentSize;

    // 定期清理过期会话
    engine.cleanup();
  }, pollInterval);

  // 优雅退出
  const cleanup = () => {
    clearInterval(timer);
    stopLanServer(lanServer);
    try {
      unlinkSync(PID_FILE);
    } catch { /* ignore */ }
    console.log(pc.dim("\n  Daemon 已停止。"));
    process.exit(0);
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
}

// ── 解析原始 Hook 事件为 StatusEvent ──
function parseRawEvent(raw: any): StatusEvent | null {
  if (!raw || !raw.hookAction) return null;

  const sessionId = raw.rawData?.session_id ?? raw.sessionId ?? "unknown";
  const toolName = raw.rawData?.tool_name ?? "";
  const toolInput = raw.rawData?.tool_input ?? {};

  let baseState: BaseState = "idle";
  let action: SemanticAction = "none";
  let displayText = "";

  switch (raw.hookAction) {
    case "session-start":
      baseState = "idle";
      displayText = "会话已启动";
      break;

    case "prompt-submit":
      baseState = "working";
      action = "thinking";
      displayText = "正在分析需求";
      break;

    case "tool-use": {
      baseState = "working";
      const extra = raw.extra || "";

      if (extra === "editing") {
        action = "editing";
        displayText = "正在编辑文件";
      } else if (extra === "searching") {
        action = "searching";
        displayText = "正在搜索代码";
      } else if (extra === "bash-infer") {
        const cmd = (toolInput?.command ?? "").toLowerCase();
        if (cmd.includes("test") || cmd.includes("jest") || cmd.includes("pytest") || cmd.includes("vitest")) {
          action = "testing";
          displayText = "正在运行测试";
        } else if (cmd.includes("git")) {
          action = "git-operating";
          displayText = "正在执行 Git 操作";
        } else if (cmd.includes("curl") || cmd.includes("wget") || cmd.includes("fetch")) {
          action = "networking";
          displayText = "正在网络请求";
        } else if (cmd.includes("build") || cmd.includes("webpack") || cmd.includes("vite")) {
          action = "building";
          displayText = "正在构建项目";
        } else {
          action = "tool-calling";
          displayText = "正在执行命令";
        }
      } else {
        action = "tool-calling";
        displayText = `正在调用工具 ${toolName || ""}`.trim();
      }
      break;
    }

    case "tool-done":
      baseState = "working";
      action = "none";
      displayText = "工具执行完成";
      break;

    case "batch-done":
      baseState = "working";
      action = "none";
      displayText = "批量工具执行完成";
      break;

    case "permission-request":
      baseState = "waiting";
      action = "permission-waiting";
      displayText = "等待权限确认";
      break;

    case "stop":
      baseState = "completed";
      action = "none";
      displayText = "任务已完成";
      break;

    case "notification": {
      const matcher = raw.rawData?.matcher ?? "";
      if (matcher.includes("error") || matcher.includes("fail")) {
        baseState = "error";
        displayText = "发生错误";
      } else {
        baseState = "waiting";
        action = "input-waiting";
        displayText = "等待输入";
      }
      break;
    }

    case "subagent-start":
      baseState = "working";
      action = "subagent-running";
      displayText = "子 Agent 运行中";
      break;

    case "subagent-stop":
      baseState = "working";
      action = "none";
      displayText = "子 Agent 已完成";
      break;

    case "task-created":
      baseState = "working";
      action = "none";
      displayText = "任务已创建";
      break;

    case "task-completed":
      baseState = "completed";
      action = "none";
      displayText = "任务已完成";
      break;

    default:
      return null;
  }

  // 附加详细信息
  let detail: string | undefined;
  if (toolInput?.file_path) {
    detail = toolInput.file_path.split("/").pop();
  } else if (toolInput?.command) {
    detail = toolInput.command.slice(0, 60);
  }

  return {
    eventId: raw.eventId ?? createEventId(),
    agent: raw.agent ?? "unknown",
    sessionId,
    sessionName: raw.rawData?.session_name,
    baseState,
    action,
    displayText,
    detail,
    timestamp: raw.timestamp ?? nowISO(),
    projectPath: raw.rawData?.cwd,
    adapterVersion: "0.1.0",
  };
}

function statusColor(state: BaseState): (s: string) => string {
  switch (state) {
    case "working": return pc.red;
    case "waiting": return pc.yellow;
    case "completed": return pc.green;
    case "error": return pc.red;
    case "idle": return pc.dim;
    default: return pc.dim;
  }
}

function stopDaemon() {
  if (!existsSync(PID_FILE)) {
    console.log(pc.dim("  Daemon 未在运行。"));
    return;
  }

  const pid = readFileSync(PID_FILE, "utf-8").trim();
  try {
    process.kill(Number(pid), "SIGTERM");
    unlinkSync(PID_FILE);
    console.log(pc.green(`  ✔ Daemon 已停止 (PID: ${pid})`));
  } catch {
    console.log(pc.dim("  Daemon 进程已不存在。"));
  }
}
