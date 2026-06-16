/**
 * Claude Code 适配器
 *
 * 安装方式：生成 Claude Code Plugin 文件，并注册到 Claude Code 的 settings.json
 * 采集方式：Plugin 的 Hooks 脚本将事件写入 ~/.asm/events.log
 * 消费方式：asm daemon 守护进程读取 events.log 并推送到 Status Engine
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync, copyFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir, platform } from "node:os";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export class ClaudeCodeAdapter {
  private home = homedir();
  private claudeDir = join(this.home, ".claude");
  private settingsFile = join(this.claudeDir, "settings.json");

  async install(): Promise<void> {
    // 1. 确保 ~/.claude 目录存在
    if (!existsSync(this.claudeDir)) {
      mkdirSync(this.claudeDir, { recursive: true });
    }

    // 2. 生成 hooks 脚本到 ~/.asm/hooks/claude-code/
    await this.generateHookScripts();

    // 3. 注入 hooks 配置到 settings.json
    await this.injectHooks();

    // 4. 生成 Plugin 文件（可选，用于 /plugin 安装方式）
    await this.generatePluginFiles();
  }

  async uninstall(): Promise<void> {
    // 从 settings.json 中移除 ASM 的 hooks
    if (existsSync(this.settingsFile)) {
      const settings = JSON.parse(readFileSync(this.settingsFile, "utf-8"));
      if (settings.hooks) {
        for (const [event, handlers] of Object.entries(settings.hooks)) {
          if (Array.isArray(handlers)) {
            settings.hooks[event] = handlers.filter(
              (h: any) => !JSON.stringify(h).includes("asm-hook")
            );
          }
        }
      }
      writeFileSync(this.settingsFile, JSON.stringify(settings, null, 2), "utf-8");
    }
  }

  // ── 生成 Hook 脚本 ──
  private async generateHookScripts(): Promise<void> {
    const hookDir = join(homedir(), ".asm", "hooks", "claude-code");
    mkdirSync(hookDir, { recursive: true });

    const isWindows = platform() === "win32";
    const home = homedir();
    const asmDir = join(home, ".asm");
    const hookPs1 = join(asmDir, "hooks", "claude-code", "asm-hook.ps1").replace(/\\/g, "/");
    const eventsLog = join(asmDir, "events.log").replace(/\\/g, "/");
    const daemonPid = join(asmDir, "daemon.pid").replace(/\\/g, "/");
    const ensureDaemon = join(asmDir, "ensure-daemon.js").replace(/\\/g, "/");

    // 生成 ensure-daemon.js 启动器（用 node 直接启动，避免 npx 弹窗）
    this.generateEnsureDaemon(ensureDaemon);

    if (isWindows) {
      const psScript = `# ASM Hook Handler for Claude Code (Windows)
# Ultra-fast: never blocks Claude Code
param([string]\$Action, [string]\$Extra = "")

try {
    # ── Auto-start daemon only on first hook (SessionStart) ──
    if (\$Action -eq "session-start") {
        \$pidFile = "${daemonPid}"
        \$needStart = \$true
        if (Test-Path \$pidFile) {
            try {
                \$pid = [int](Get-Content \$pidFile -Raw).Trim()
                \$proc = Get-Process -Id \$pid -ErrorAction Stop
                \$needStart = \$false
            } catch {}
        }
        if (\$needStart) {
            Start-Process node -ArgumentList "${ensureDaemon}" -WindowStyle Hidden -ErrorAction SilentlyContinue
        }
    }

    # ── Non-blocking stdin read (max 300ms) ──
    \$input_json = "{}"
    try {
        \$stdin = [Console]::In
        if (\$stdin.Peek() -ge 0) {
            \$sb = New-Object System.Text.StringBuilder
            \$deadline = (Get-Date).AddMilliseconds(300)
            while ((Get-Date) -lt \$deadline) {
                if (\$stdin.Peek() -ge 0) {
                    [void]\$sb.Append([char]\$stdin.Read())
                } else {
                    break
                }
            }
            \$raw = \$sb.ToString().Trim()
            if (\$raw.Length -gt 0) { \$input_json = \$raw }
        }
    } catch {}

    # ── Build and write event ──
    \$timestamp = (Get-Date -Format "o")
    \$ticks = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    \$guid = [System.Guid]::NewGuid().ToString().Substring(0,6)

    \$logLine = "{\`"eventId\`":\`"\${ticks}-\${guid}\`",\`"agent\`":\`"claude-code\`",\`"timestamp\`":\`"\${timestamp}\`",\`"hookAction\`":\`"\${Action}\`",\`"extra\`":\`"\${Extra}\`",\`"rawData\`":\${input_json}}"

    [System.IO.File]::AppendAllText("${eventsLog}", \$logLine + "\`n", [System.Text.UTF8Encoding]::new(\$false))
} catch {
    # Never block Claude Code
}
`;
      writeFileSync(join(hookDir, "asm-hook.ps1"), psScript, "utf-8");

      // BAT 包装器
      const batWrapper = `@echo off\r\npowershell -NoProfile -ExecutionPolicy Bypass -File "${hookPs1}" %*\r\n`;
      writeFileSync(join(hookDir, "asm-hook.bat"), batWrapper, "utf-8");
    } else {
      // Bash 版本（macOS / Linux）
      const shScript = `#!/usr/bin/env bash
# ASM Hook Handler for Claude Code
set -euo pipefail

ACTION="\${1:-unknown}"
EXTRA="\${2:-}"

# ── 自动启动 daemon（静默）──
node "${ensureDaemon}" 2>/dev/null &

# 读取 stdin
INPUT_JSON=$(cat)

# 生成事件（macOS 兼容）
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")
EVENT_ID="$(date +%s)-$(head -c 6 /dev/urandom | od -An -tx1 | tr -d ' \\n' | head -c 12)"

# 写入事件日志
echo "{\\"eventId\\":\\"$EVENT_ID\\",\\"agent\\":\\"claude-code\\",\\"timestamp\\":\\"$TIMESTAMP\\",\\"hookAction\\":\\"$ACTION\\",\\"extra\\":\\"$EXTRA\\",\\"rawData\\":$INPUT_JSON}" >> "$HOME/.asm/events.log"
`;
      writeFileSync(join(hookDir, "asm-hook.sh"), shScript, "utf-8");

      // 设置可执行权限
      try {
        execSync(`chmod +x "${join(hookDir, "asm-hook.sh")}"`, { stdio: "ignore" });
      } catch { /* 忽略权限错误 */ }
    }
  }

  // ── 生成 ensure-daemon.js 启动器 ──
  // 用 node 直接运行，检查 daemon 是否运行，没有则静默启动
  private generateEnsureDaemon(scriptPath: string): void {
    // 找到已安装的 asm CLI 入口文件
    const asmEntry = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "cli", "index.js").replace(/\\/g, "/");

    const script = `// ASM ensure-daemon — 静默检查并启动 daemon
// 由 hook 脚本调用，不弹窗，不阻塞
const { readFileSync, existsSync } = require("fs");
const { spawn } = require("child_process");
const { join } = require("path");

const home = process.env.HOME || process.env.USERPROFILE;
const pidFile = join(home, ".asm", "daemon.pid");

// 检查 daemon 是否已在运行
if (existsSync(pidFile)) {
  try {
    const pid = parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
    process.kill(pid, 0); // 发送信号 0 检查进程存在
    process.exit(0);      // daemon 在运行，直接退出
  } catch {
    // daemon 不存在，继续启动
  }
}

// 静默启动 daemon（detached + windowsHide，无弹窗）
const child = spawn(process.execPath, ["${asmEntry}", "daemon", "--start", "--quiet"], {
  detached: true,
  stdio: "ignore",
  windowsHide: true,
});
child.unref();
process.exit(0);
`;
    writeFileSync(scriptPath, script, "utf-8");
  }

  // ── 注入 Hooks 配置 ──
  private async injectHooks(): Promise<void> {
    const isWindows = platform() === "win32";
    // 用绝对路径 + 正斜杠（Windows 上 bash/PowerShell 都能识别）
    const hookScript = join(homedir(), ".asm", "hooks", "claude-code", "asm-hook.ps1").replace(/\\/g, "/");
    const hookCmd = isWindows
      ? `powershell -NoProfile -ExecutionPolicy Bypass -File "${hookScript}"`
      : `"${join(homedir(), ".asm", "hooks", "claude-code", "asm-hook.sh")}"`;

    const asmHooks = {
      SessionStart: [{
        hooks: [{ type: "command", command: `${hookCmd} session-start` }],
      }],
      UserPromptSubmit: [{
        hooks: [{ type: "command", command: `${hookCmd} prompt-submit` }],
      }],
      PreToolUse: [
        {
          matcher: "Edit|Write",
          hooks: [{ type: "command", command: `${hookCmd} tool-use editing` }],
        },
        {
          matcher: "Bash",
          hooks: [{ type: "command", command: `${hookCmd} tool-use bash-infer` }],
        },
        {
          matcher: "Grep|Glob|Read",
          hooks: [{ type: "command", command: `${hookCmd} tool-use searching` }],
        },
        {
          matcher: "*",
          hooks: [{ type: "command", command: `${hookCmd} tool-use generic` }],
        },
      ],
      PostToolUse: [{
        matcher: "*",
        hooks: [{ type: "command", command: `${hookCmd} tool-done` }],
      }],
      PostToolBatch: [{
        hooks: [{ type: "command", command: `${hookCmd} batch-done` }],
      }],
      PermissionRequest: [{
        hooks: [{ type: "command", command: `${hookCmd} permission-request` }],
      }],
      Stop: [{
        hooks: [{ type: "command", command: `${hookCmd} stop` }],
      }],
      Notification: [{
        hooks: [{ type: "command", command: `${hookCmd} notification` }],
      }],
      SubagentStart: [{
        hooks: [{ type: "command", command: `${hookCmd} subagent-start` }],
      }],
      SubagentStop: [{
        hooks: [{ type: "command", command: `${hookCmd} subagent-stop` }],
      }],
      TaskCreated: [{
        hooks: [{ type: "command", command: `${hookCmd} task-created` }],
      }],
      TaskCompleted: [{
        hooks: [{ type: "command", command: `${hookCmd} task-completed` }],
      }],
    };

    // 读取现有 settings.json
    let settings: Record<string, any> = {};
    if (existsSync(this.settingsFile)) {
      try {
        settings = JSON.parse(readFileSync(this.settingsFile, "utf-8"));
      } catch {
        settings = {};
      }
    }

    // 合并 hooks（保留用户已有的 hooks）
    if (!settings.hooks) {
      settings.hooks = {};
    }

    for (const [event, newHandlers] of Object.entries(asmHooks)) {
      if (!settings.hooks[event]) {
        settings.hooks[event] = newHandlers;
      } else {
        // 追加，但去重（检查是否已有 asm-hook 命令）
        const existingStr = JSON.stringify(settings.hooks[event]);
        for (const handler of newHandlers as any[]) {
          const handlerStr = JSON.stringify(handler);
          if (!existingStr.includes("asm-hook")) {
            settings.hooks[event].push(handler);
          }
        }
      }
    }

    writeFileSync(this.settingsFile, JSON.stringify(settings, null, 2), "utf-8");
  }

  // ── 生成 Plugin 文件（备用安装方式） ──
  private async generatePluginFiles(): Promise<void> {
    const home = homedir();
    const isWindows = platform() === "win32";
    const pluginDir = join(home, ".asm", "adapters", "claude-code", "plugin");
    mkdirSync(join(pluginDir, ".claude-plugin"), { recursive: true });
    mkdirSync(join(pluginDir, "hooks"), { recursive: true });
    mkdirSync(join(pluginDir, "scripts"), { recursive: true });
    mkdirSync(join(pluginDir, "skills", "asm-status"), { recursive: true });

    const eventsLog = join(home, ".asm", "events.log").replace(/\\/g, "/");

    // plugin.json
    writeFileSync(
      join(pluginDir, ".claude-plugin", "plugin.json"),
      JSON.stringify({
        name: "agent-status-monitor",
        displayName: "Agent Status Monitor",
        description: "通过 Hooks 采集 Agent 语义状态，推送通知和外部服务",
        version: "0.1.0",
        author: { name: "ASM Team" },
        license: "MIT",
        keywords: ["status", "monitor", "hooks", "notification"],
      }, null, 2),
      "utf-8"
    );

    // 根据平台选择 hook 命令格式
    const hookScript = isWindows
      ? join(pluginDir, "scripts", "hook-handler.ps1").replace(/\\/g, "/")
      : join(pluginDir, "scripts", "hook-handler.sh");
    const hookCmd = isWindows
      ? `powershell -NoProfile -ExecutionPolicy Bypass -File "${hookScript}"`
      : `"${hookScript}"`;

    // hooks/hooks.json
    writeFileSync(
      join(pluginDir, "hooks", "hooks.json"),
      JSON.stringify({
        hooks: {
          SessionStart: [{ hooks: [{ type: "command", command: `${hookCmd} session-start` }] }],
          UserPromptSubmit: [{ hooks: [{ type: "command", command: `${hookCmd} prompt-submit` }] }],
          PreToolUse: [
            { matcher: "Edit|Write", hooks: [{ type: "command", command: `${hookCmd} tool-use editing` }] },
            { matcher: "Bash", hooks: [{ type: "command", command: `${hookCmd} tool-use bash-infer` }] },
            { matcher: "Grep|Glob|Read", hooks: [{ type: "command", command: `${hookCmd} tool-use searching` }] },
            { matcher: "*", hooks: [{ type: "command", command: `${hookCmd} tool-use generic` }] },
          ],
          PermissionRequest: [{ hooks: [{ type: "command", command: `${hookCmd} permission-request` }] }],
          Stop: [{ hooks: [{ type: "command", command: `${hookCmd} stop` }] }],
          Notification: [{ hooks: [{ type: "command", command: `${hookCmd} notification` }] }],
          SubagentStart: [{ hooks: [{ type: "command", command: `${hookCmd} subagent-start` }] }],
          SubagentStop: [{ hooks: [{ type: "command", command: `${hookCmd} subagent-stop` }] }],
          TaskCreated: [{ hooks: [{ type: "command", command: `${hookCmd} task-created` }] }],
          TaskCompleted: [{ hooks: [{ type: "command", command: `${hookCmd} task-completed` }] }],
        },
      }, null, 2),
      "utf-8"
    );

    if (isWindows) {
      // PowerShell hook handler for Windows
      const psHandler = `# ASM Hook Handler — Claude Code Plugin (Windows)
param([string]$Action, [string]$Extra = "")
$input_json = $input | Out-String
$timestamp = (Get-Date -Format "o")
$event_id = "$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())-$([System.Guid]::NewGuid().ToString().Substring(0,6))"
$event = @{
    eventId = $event_id
    agent = "claude-code"
    timestamp = $timestamp
    hookAction = $Action
    extra = $Extra
    rawData = ($input_json | ConvertFrom-Json -ErrorAction SilentlyContinue)
} | ConvertTo-Json -Depth 10 -Compress
[System.IO.File]::AppendAllText("${eventsLog}", $event + [Environment]::NewLine, [System.Text.UTF8Encoding]::new($false))
`;
      writeFileSync(join(pluginDir, "scripts", "hook-handler.ps1"), psHandler, "utf-8");
    } else {
      // Bash hook handler for macOS/Linux
      const shHandler = `#!/usr/bin/env bash
# ASM Hook Handler — Claude Code Plugin
set -euo pipefail
ACTION="\${1:-unknown}"
EXTRA="\${2:-}"
INPUT_JSON=$(cat)
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")
EVENT_ID="$(date +%s)-$(head -c 4 /dev/urandom | od -An -tx1 | tr -d ' \\n' | head -c 8)"
echo "{\\"eventId\\":\\"$EVENT_ID\\",\\"agent\\":\\"claude-code\\",\\"timestamp\\":\\"$TIMESTAMP\\",\\"hookAction\\":\\"$ACTION\\",\\"extra\\":\\"$EXTRA\\",\\"rawData\\":$INPUT_JSON}" >> "$HOME/.asm/events.log"
`;
      writeFileSync(join(pluginDir, "scripts", "hook-handler.sh"), shHandler, "utf-8");
      try {
        execSync(`chmod +x "${join(pluginDir, "scripts", "hook-handler.sh")}"`, { stdio: "ignore" });
      } catch { /* ignore */ }
    }

    // skills/asm-status/SKILL.md
    writeFileSync(
      join(pluginDir, "skills", "asm-status", "SKILL.md"),
      `---
description: Query and display the current ASM status for all monitored agents
---

Read the file ~/.asm/status.json and display the current status of all monitored agents.
For each agent, show: base state, semantic action, display text, session name, and duration.
Format as a clean status table.
`,
      "utf-8"
    );
  }
}
