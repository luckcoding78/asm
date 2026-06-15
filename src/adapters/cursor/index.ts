/**
 * Cursor 适配器
 *
 * 采集方式：
 * 1. Cloud Agent: 通过 REST API + SSE 监听运行状态
 * 2. IDE 内 Agent: 通过文件监控 ~/.config/Cursor/ state.vscdb（兜底方案）
 *
 * 需要配置：Cursor API Key
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export class CursorAdapter {
  private home = homedir();
  private asmDir = join(this.home, ".asm");
  private adapterDir = join(this.asmDir, "adapters", "cursor");

  async install(): Promise<void> {
    mkdirSync(this.adapterDir, { recursive: true });

    // 生成配置模板
    const config = {
      type: "cursor",
      mode: "api",  // api | file-watch
      apiKey: "",   // 用户需填入 Cursor Dashboard API Key
      agentIds: [], // 要监控的 Cloud Agent ID 列表
      pollingIntervalMs: 3000,
      note: "请填入 Cursor API Key。获取方式：Cursor Dashboard → Integrations → Generate API Key",
    };

    writeFileSync(
      join(this.adapterDir, "config.json"),
      JSON.stringify(config, null, 2),
      "utf-8"
    );

    console.log(`\n    Cursor 适配器需要配置 API Key。`);
    console.log(`    配置文件: ${join(this.adapterDir, "config.json")}`);
    console.log(`    获取 Key: Cursor Dashboard → Integrations\n`);
  }

  async uninstall(): Promise<void> {
    const { rmSync } = await import("node:fs");
    try {
      rmSync(this.adapterDir, { recursive: true, force: true });
    } catch { /* ignore */ }
  }

  // ── Cloud Agent SSE 监听（daemon 使用） ──
  async streamAgentEvents(apiKey: string, agentId: string, runId: string): Promise<AsyncGenerator<any>> {
    const response = await fetch(
      `https://api.cursor.com/v1/agents/${agentId}/runs/${runId}/events`,
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: "text/event-stream",
        },
      }
    );

    if (!response.ok) {
      throw new Error(`Cursor API error: ${response.status}`);
    }

    // SSE 流解析
    const reader = response.body?.getReader();
    const decoder = new TextDecoder();

    async function* generate() {
      if (!reader) return;
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            try {
              yield JSON.parse(line.slice(6));
            } catch { /* skip malformed */ }
          }
        }
      }
    }

    return generate();
  }
}
