/**
 * OpenAI Codex CLI 适配器
 *
 * 采集方式：
 * 1. 通过 codex app-server JSON-RPC 协议监听状态事件
 * 2. 通过 hooks.json 配置 session start/stop 钩子
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir, platform } from "node:os";

export class CodexAdapter {
  private home = homedir();
  private asmDir = join(this.home, ".asm");
  private hookDir = join(this.asmDir, "hooks", "codex");

  async install(): Promise<void> {
    mkdirSync(this.hookDir, { recursive: true });

    const isWindows = platform() === "win32";
    const daemonPid = join(this.home, ".asm", "daemon.pid").replace(/\\/g, "/");

    if (isWindows) {
      // PowerShell hook script — 使用绝对路径避免环境变量展开问题
      const eventsLog = join(this.home, ".asm", "events.log").replace(/\\/g, "/");
      const psScript = `# ASM Hook Handler for Codex CLI (Windows)
param([string]$Action, [string]$Extra = "")

# ── 自动启动 daemon ──
$pidFile = "${daemonPid}"
$daemonRunning = $false
if (Test-Path $pidFile) {
    $pid = Get-Content $pidFile -ErrorAction SilentlyContinue
    if ($pid) {
        try {
            $null = Get-Process -Id ([int]$pid) -ErrorAction Stop
            $daemonRunning = $true
        } catch {}
    }
}
if (-not $daemonRunning) {
    Start-Process -FilePath "npx" -ArgumentList "@aspect-spy/asm", "daemon", "--start" -WindowStyle Hidden -ErrorAction SilentlyContinue
}

$input_json = $input | Out-String
$timestamp = (Get-Date -Format "o")
$event_id = "$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())-$([System.Guid]::NewGuid().ToString().Substring(0,6))"
$event = @{
    eventId = $event_id
    agent = "codex"
    timestamp = $timestamp
    hookAction = $Action
    extra = $Extra
    rawData = ($input_json | ConvertFrom-Json -ErrorAction SilentlyContinue)
} | ConvertTo-Json -Depth 10 -Compress
$logFile = "${eventsLog}"
[System.IO.File]::AppendAllText($logFile, $event + [Environment]::NewLine, [System.Text.UTF8Encoding]::new($false))
`;
      writeFileSync(join(this.hookDir, "asm-hook.ps1"), psScript, "utf-8");
    } else {
      // Bash hook script
      const shScript = `#!/usr/bin/env bash
set -euo pipefail
ACTION="\${1:-unknown}"
EXTRA="\${2:-}"

# ── 自动启动 daemon ──
PID_FILE="$HOME/.asm/daemon.pid"
DAEMON_RUNNING=false
if [ -f "$PID_FILE" ]; then
    PID=$(cat "$PID_FILE" 2>/dev/null || echo "")
    if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
        DAEMON_RUNNING=true
    fi
fi
if [ "$DAEMON_RUNNING" = false ]; then
    (npx @aspect-spy/asm daemon --start >/dev/null 2>&1 &) || true
fi

INPUT_JSON=$(cat)
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")
EVENT_ID="$(date +%s)-$(head -c 4 /dev/urandom | od -An -tx1 | tr -d ' \\n' | head -c 8)"
echo "{\\"eventId\\":\\"$EVENT_ID\\",\\"agent\\":\\"codex\\",\\"timestamp\\":\\"$TIMESTAMP\\",\\"hookAction\\":\\"$ACTION\\",\\"extra\\":\\"$EXTRA\\",\\"rawData\\":$INPUT_JSON}" >> "$HOME/.asm/events.log"
`;
      writeFileSync(join(this.hookDir, "asm-hook.sh"), shScript, "utf-8");

      try {
        const { execSync } = await import("node:child_process");
        execSync(`chmod +x "${join(this.hookDir, "asm-hook.sh")}"`, { stdio: "ignore" });
      } catch { /* ignore */ }
    }

    // 生成 Codex hooks.json 配置模板
    const hooksConfig = {
      hooks: {
        SessionStart: [{ hooks: [{ type: "command", command: this.getHookCmd("session-start") }] }],
        Stop: [{ hooks: [{ type: "command", command: this.getHookCmd("stop") }] }],
      },
    };

    writeFileSync(
      join(this.hookDir, "hooks-config.json"),
      JSON.stringify(hooksConfig, null, 2),
      "utf-8"
    );

    // 提示用户手动配置 Codex hooks
    console.log(`\n    Codex CLI hooks 需要手动配置。`);
    console.log(`    配置文件模板已生成: ${join(this.hookDir, "hooks-config.json")}`);
    console.log(`    请将内容合并到 Codex 的 hooks 配置中。\n`);
  }

  async uninstall(): Promise<void> {
    // 清理 hook 脚本
    const { rmSync } = await import("node:fs");
    try {
      rmSync(this.hookDir, { recursive: true, force: true });
    } catch { /* ignore */ }
  }

  private getHookCmd(action: string): string {
    const isWindows = platform() === "win32";
    if (isWindows) {
      const hookScript = join(this.home, ".asm", "hooks", "codex", "asm-hook.ps1").replace(/\\/g, "/");
      return `powershell -NoProfile -ExecutionPolicy Bypass -File "${hookScript}" ${action}`;
    }
    return `"${join(this.home, ".asm", "hooks", "codex", "asm-hook.sh")}" ${action}`;
  }
}
