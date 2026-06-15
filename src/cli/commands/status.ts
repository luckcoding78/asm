/**
 * ASM CLI — status 命令
 * 实时显示所有 Agent 的状态
 */

import pc from "picocolors";
import { existsSync, readFileSync } from "node:fs";
import { STATUS_FILE, type GlobalState, type BaseState } from "../../core/protocol.js";

const STATE_COLORS: Record<BaseState, (s: string) => string> = {
  idle: pc.dim,
  working: pc.red,
  waiting: pc.yellow,
  completed: pc.green,
  error: (s: string) => pc.bold(pc.red(s)),
  offline: pc.dim,
};

const STATE_ICONS: Record<BaseState, string> = {
  idle: "○",
  working: "●",
  waiting: "◐",
  completed: "✔",
  error: "✘",
  offline: "·",
};

const STATE_LABELS: Record<BaseState, string> = {
  idle: "空闲",
  working: "工作中",
  waiting: "等待中",
  completed: "已完成",
  error: "出错",
  offline: "离线",
};

export async function statusCommand() {
  if (!existsSync(STATUS_FILE)) {
    console.log(pc.dim("\n  暂无状态数据。请先运行 asm install 安装适配器。\n"));
    return;
  }

  let state: GlobalState;
  try {
    state = JSON.parse(readFileSync(STATUS_FILE, "utf-8"));
  } catch {
    console.log(pc.red("\n  状态文件损坏，请重新安装。\n"));
    return;
  }

  const agents = Object.values(state.agents);

  if (agents.length === 0) {
    console.log(pc.dim("\n  暂无活跃的 Agent 会话。\n"));
    return;
  }

  console.log();
  console.log(pc.bold("  Agent Status Monitor"));
  console.log(pc.dim(`  最后更新: ${state.lastUpdated}`));
  console.log();

  // 按 Agent 类型分组显示
  const grouped: Record<string, typeof agents> = {};
  for (const snapshot of agents) {
    if (!grouped[snapshot.agent]) grouped[snapshot.agent] = [];
    grouped[snapshot.agent].push(snapshot);
  }

  for (const [agentType, sessions] of Object.entries(grouped)) {
    console.log(`  ${pc.bold(agentDisplayName(agentType))}`);
    console.log(pc.dim(`  ${"─".repeat(40)}`));

    for (const s of sessions) {
      const colorFn = STATE_COLORS[s.baseState] ?? pc.dim;
      const icon = STATE_ICONS[s.baseState] ?? "·";
      const label = STATE_LABELS[s.baseState] ?? s.baseState;

      console.log(
        `    ${colorFn(icon)} ${pc.bold(s.sessionName || s.sessionId.slice(0, 8))}` +
        `  ${colorFn(label)}` +
        `  ${pc.dim(s.displayText)}` +
        (s.detail ? `  ${pc.dim(s.detail)}` : "") +
        `  ${pc.dim(formatDuration(s.durationSec))}`
      );
    }

    console.log();
  }
}

function agentDisplayName(type: string): string {
  const names: Record<string, string> = {
    "claude-code": "Claude Code",
    "codex": "OpenAI Codex",
    "copilot": "GitHub Copilot",
    "cursor": "Cursor",
    "gemini": "Gemini",
  };
  return names[type] ?? type;
}

function formatDuration(sec: number): string {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${sec % 60}s`;
  return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
}
