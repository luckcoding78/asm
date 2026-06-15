/**
 * ASM CLI — install 命令
 *
 * 统一安装入口：检测系统上已安装的 Agent，让用户选择要启用哪些，
 * 然后调用对应适配器的 install() 方法完成安装。
 *
 * 用户无论装的是哪个 Agent，都是同一行命令：
 *   npx @aspect-spy/asm install
 */

import prompts from "prompts";
import pc from "picocolors";
import { existsSync } from "node:fs";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import {
  ASM_DIR, CONFIG_FILE, getDefaultConfig,
  type AgentType, type AsmConfig,
} from "../../core/protocol.js";
import { ClaudeCodeAdapter } from "../../adapters/claude-code/index.js";
import { CodexAdapter } from "../../adapters/codex/index.js";
import { CopilotAdapter } from "../../adapters/copilot/index.js";
import { CursorAdapter } from "../../adapters/cursor/index.js";

// ── 适配器注册表 ──
interface AdapterMeta {
  type: AgentType;
  name: string;
  description: string;
  detectFn: () => boolean;
  installFn: () => Promise<void>;
}

const ADAPTERS: AdapterMeta[] = [
  {
    type: "claude-code",
    name: "Claude Code",
    description: "通过 Hooks 采集状态（支持语义动作推断）",
    detectFn: () => detectClaudeCode(),
    installFn: () => new ClaudeCodeAdapter().install(),
  },
  {
    type: "codex",
    name: "OpenAI Codex CLI",
    description: "通过 app-server / hooks 采集状态",
    detectFn: () => detectCodex(),
    installFn: () => new CodexAdapter().install(),
  },
  {
    type: "copilot",
    name: "GitHub Copilot",
    description: "通过 Copilot SDK / REST API 轮询状态",
    detectFn: () => detectCopilot(),
    installFn: () => new CopilotAdapter().install(),
  },
  {
    type: "cursor",
    name: "Cursor",
    description: "通过 Cloud Agents API / 文件监控采集",
    detectFn: () => detectCursor(),
    installFn: () => new CursorAdapter().install(),
  },
];

// ── Agent 检测函数 ──

const isWindows = platform() === "win32";
const NULL_STDERR = isWindows ? "2>nul" : "2>/dev/null";

function detectClaudeCode(): boolean {
  try {
    execSync(`claude --version ${NULL_STDERR}`, { stdio: "ignore" });
    return true;
  } catch {
    const home = homedir();
    return existsSync(join(home, ".claude")) ||
           existsSync(join(home, ".claude", "settings.json"));
  }
}

function detectCodex(): boolean {
  try {
    execSync(`codex --version ${NULL_STDERR}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function detectCopilot(): boolean {
  try {
    const result = execSync(`code --list-extensions ${NULL_STDERR}`, {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return result.toLowerCase().includes("copilot");
  } catch {
    return false;
  }
}

function detectCursor(): boolean {
  const home = homedir();
  const plat = platform();
  if (plat === "darwin") {
    return existsSync(join(home, "Library/Application Support/Cursor"));
  } else if (plat === "win32") {
    return existsSync(join(process.env.APPDATA || "", "Cursor"));
  } else {
    return existsSync(join(home, ".config/Cursor"));
  }
}

// ── install 命令主逻辑 ──

export async function installCommand(opts: { agent?: string }) {
  console.log();
  console.log(pc.bold("  Agent Status Monitor") + pc.dim(" — 统一安装"));
  console.log(pc.dim("  检测你系统上已安装的 AI Agent，选择要启用的适配器。"));
  console.log();

  // 确保 ~/.asm 目录存在
  if (!existsSync(ASM_DIR)) {
    mkdirSync(ASM_DIR, { recursive: true });
  }

  // 1. 检测已安装的 Agent
  console.log(pc.dim("  正在检测已安装的 Agent..."));
  console.log();

  const detected: AdapterMeta[] = [];
  const notDetected: AdapterMeta[] = [];

  for (const adapter of ADAPTERS) {
    const found = adapter.detectFn();
    if (found) {
      detected.push(adapter);
      console.log(`  ${pc.green("●")} ${pc.bold(adapter.name)} ${pc.green("已检测到")}`);
    } else {
      notDetected.push(adapter);
      console.log(`  ${pc.dim("○")} ${pc.dim(adapter.name)} ${pc.dim("未检测到")}`);
    }
  }

  console.log();

  // 2. 如果指定了 --agent，直接安装
  if (opts.agent) {
    const adapter = ADAPTERS.find(a => a.type === opts.agent);
    if (!adapter) {
      console.error(pc.red(`  未知 Agent 类型: ${opts.agent}`));
      console.log(`  可用类型: ${ADAPTERS.map(a => a.type).join(", ")}`);
      process.exit(1);
    }
    await runInstall(adapter);
    return;
  }

  // 3. 让用户选择
  if (detected.length === 0) {
    console.log(pc.yellow("  未检测到任何已安装的 Agent。"));
    console.log(pc.dim("  你可以选择手动安装（适配器可能无法正常工作）："));
  }

  const choices = [
    ...detected.map(a => ({ title: `${a.name} ${pc.green("(已检测)")}`, value: a.type, description: a.description })),
    ...notDetected.map(a => ({ title: `${a.name} ${pc.dim("(未检测)")}`, value: a.type, description: a.description })),
  ];

  const response = await prompts({
    type: "multiselect",
    name: "agents",
    message: "选择要启用的适配器（空格选择，回车确认）",
    choices,
    initial: detected.map((_, i) => i) as any,
    hint: "- 空格选择/取消，回车确认 -",
  });

  if (!response.agents || response.agents.length === 0) {
    console.log(pc.dim("\n  未选择任何适配器，已取消。"));
    process.exit(0);
  }

  // 4. 依次安装选中的适配器
  console.log();
  const selectedTypes = response.agents as AgentType[];

  for (const type of selectedTypes) {
    const adapter = ADAPTERS.find(a => a.type === type);
    if (adapter) {
      await runInstall(adapter);
    }
  }

  // 5. 更新配置文件
  updateConfig(selectedTypes);

  // 6. 安装完成
  console.log();
  console.log(pc.green("  ✔ 安装完成！"));
  console.log();
  console.log(`  查看状态：${pc.bold("asm status")}`);
  console.log(`  启动守护：${pc.bold("asm daemon --start")}`);
  console.log(`  修改配置：${pc.bold("asm config")}`);
  console.log();
}

async function runInstall(adapter: AdapterMeta) {
  console.log(pc.dim(`  正在安装 ${adapter.name} 适配器...`));
  try {
    await adapter.installFn();
    console.log(`  ${pc.green("✔")} ${adapter.name} ${pc.green("已安装")}`);
  } catch (err: any) {
    console.error(`  ${pc.red("✘")} ${adapter.name} ${pc.red("安装失败")}: ${err.message}`);
  }
}

function updateConfig(selectedTypes: AgentType[]) {
  let config: AsmConfig;

  if (existsSync(CONFIG_FILE)) {
    config = JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
  } else {
    config = getDefaultConfig();
  }

  // 更新适配器列表
  for (const type of selectedTypes) {
    const existing = config.adapters.find(a => a.type === type);
    if (!existing) {
      config.adapters.push({ type, enabled: true });
    } else {
      existing.enabled = true;
    }
  }

  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), "utf-8");
}
