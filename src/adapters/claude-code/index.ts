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
    // 用正斜杠的绝对路径（bash/PowerShell 都能识别）
    const hookPs1 = join(home, ".asm", "hooks", "claude-code", "asm-hook.ps1").replace(/\\/g, "/");
    const eventsLog = join(home, ".asm", "events.log").replace(/\\/g, "/");

    if (isWindows) {
      // PowerShell 版本（用绝对路径，避免 %USERPROFILE% 展开问题）
      const psScript = `# ASM Hook Handler for Claude Code (Windows)
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

$logFile = "${eventsLog}"
[System.IO.File]::AppendAllText($logFile, $event + [Environment]::NewLine, [System.Text.UTF8Encoding]::new($false))
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

# 读取 stdin
INPUT_JSON=$(cat)

# 生成事件
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")
EVENT_ID="$(date +%s%3N 2>/dev/null || date +%s)-$(head -c 6 /dev/urandom | xxd -p 2>/dev/null | head -c 6 || echo $RANDOM)"

# 写入事件日志（JSON Lines 格式）
echo "{\\"eventId\\":\\"$EVENT_ID\\",\\"agent\\":\\"claude-code\\",\\"timestamp\\":\\"$TIMESTAMP\\",\\"hookAction\\":\\"$ACTION\\",\\"extra\\":\\"$EXTRA\\",\\"rawData\\":$INPUT_JSON}" >> "$HOME/.asm/events.log"
`;
      writeFileSync(join(hookDir, "asm-hook.sh"), shScript, "utf-8");

      // 设置可执行权限
      try {
        execSync(`chmod +x "${join(hookDir, "asm-hook.sh")}"`, { stdio: "ignore" });
      } catch { /* 忽略权限错误 */ }
    }
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
    const pluginDir = join(homedir(), ".asm", "adapters", "claude-code", "plugin");
    mkdirSync(join(pluginDir, ".claude-plugin"), { recursive: true });
    mkdirSync(join(pluginDir, "hooks"), { recursive: true });
    mkdirSync(join(pluginDir, "scripts"), { recursive: true });
    mkdirSync(join(pluginDir, "skills", "asm-status"), { recursive: true });

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

    // hooks/hooks.json（引用 ${CLAUDE_PLUGIN_ROOT} 下的脚本）
    writeFileSync(
      join(pluginDir, "hooks", "hooks.json"),
      JSON.stringify({
        hooks: {
          SessionStart: [{ hooks: [{ type: "command", command: "${CLAUDE_PLUGIN_ROOT}/scripts/hook-handler.sh session-start" }] }],
          UserPromptSubmit: [{ hooks: [{ type: "command", command: "${CLAUDE_PLUGIN_ROOT}/scripts/hook-handler.sh prompt-submit" }] }],
          PreToolUse: [
            { matcher: "Edit|Write", hooks: [{ type: "command", command: "${CLAUDE_PLUGIN_ROOT}/scripts/hook-handler.sh tool-use editing" }] },
            { matcher: "Bash", hooks: [{ type: "command", command: "${CLAUDE_PLUGIN_ROOT}/scripts/hook-handler.sh tool-use bash-infer" }] },
            { matcher: "Grep|Glob|Read", hooks: [{ type: "command", command: "${CLAUDE_PLUGIN_ROOT}/scripts/hook-handler.sh tool-use searching" }] },
            { matcher: "*", hooks: [{ type: "command", command: "${CLAUDE_PLUGIN_ROOT}/scripts/hook-handler.sh tool-use generic" }] },
          ],
          PermissionRequest: [{ hooks: [{ type: "command", command: "${CLAUDE_PLUGIN_ROOT}/scripts/hook-handler.sh permission-request" }] }],
          Stop: [{ hooks: [{ type: "command", command: "${CLAUDE_PLUGIN_ROOT}/scripts/hook-handler.sh stop" }] }],
          Notification: [{ hooks: [{ type: "command", command: "${CLAUDE_PLUGIN_ROOT}/scripts/hook-handler.sh notification" }] }],
          SubagentStart: [{ hooks: [{ type: "command", command: "${CLAUDE_PLUGIN_ROOT}/scripts/hook-handler.sh subagent-start" }] }],
          SubagentStop: [{ hooks: [{ type: "command", command: "${CLAUDE_PLUGIN_ROOT}/scripts/hook-handler.sh subagent-stop" }] }],
          TaskCreated: [{ hooks: [{ type: "command", command: "${CLAUDE_PLUGIN_ROOT}/scripts/hook-handler.sh task-created" }] }],
          TaskCompleted: [{ hooks: [{ type: "command", command: "${CLAUDE_PLUGIN_ROOT}/scripts/hook-handler.sh task-completed" }] }],
        },
      }, null, 2),
      "utf-8"
    );

    // scripts/hook-handler.sh
    const handlerScript = `#!/usr/bin/env bash
# ASM Hook Handler — Claude Code Plugin 版本
set -euo pipefail
ACTION="\${1:-unknown}"
EXTRA="\${2:-}"
INPUT_JSON=$(cat)
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")
EVENT_ID="$(date +%s)-$(head -c 4 /dev/urandom | od -An -tx1 | head -c 8 | tr -d ' ')"
echo "{\\"eventId\\":\\"$EVENT_ID\\",\\"agent\\":\\"claude-code\\",\\"timestamp\\":\\"$TIMESTAMP\\",\\"hookAction\\":\\"$ACTION\\",\\"extra\\":\\"$EXTRA\\",\\"rawData\\":$INPUT_JSON}" >> "$HOME/.asm/events.log"
`;
    writeFileSync(join(pluginDir, "scripts", "hook-handler.sh"), handlerScript, "utf-8");

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
