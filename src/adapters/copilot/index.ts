/**
 * GitHub Copilot 适配器
 *
 * 采集方式：
 * 1. Cloud Agent: 通过 REST API 轮询任务状态
 * 2. IDE 内 Agent: 暂无直接方案（预留接口）
 *
 * 需要配置：GitHub Token + 仓库信息
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export class CopilotAdapter {
  private home = homedir();
  private asmDir = join(this.home, ".asm");
  private adapterDir = join(this.asmDir, "adapters", "copilot");

  async install(): Promise<void> {
    mkdirSync(this.adapterDir, { recursive: true });

    // 生成配置模板
    const config = {
      type: "copilot",
      mode: "polling",  // polling | sdk
      githubToken: "",  // 用户需填入 PAT 或 OAuth token
      repos: [],        // [{ owner: "user", repo: "my-project" }]
      pollingIntervalMs: 5000,
      note: "请填入 GitHub Token 和要监控的仓库。Token 需要 Copilot 权限。",
    };

    writeFileSync(
      join(this.adapterDir, "config.json"),
      JSON.stringify(config, null, 2),
      "utf-8"
    );

    console.log(`\n    Copilot 适配器需要配置 GitHub Token。`);
    console.log(`    配置文件: ${join(this.adapterDir, "config.json")}`);
    console.log(`    获取 Token: GitHub Settings → Developer settings → Personal access tokens\n`);
  }

  async uninstall(): Promise<void> {
    const { rmSync } = await import("node:fs");
    try {
      rmSync(this.adapterDir, { recursive: true, force: true });
    } catch { /* ignore */ }
  }

  // ── Cloud Agent 轮询（daemon 使用） ──
  async pollCloudAgent(token: string, owner: string, repo: string): Promise<any[]> {
    const response = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/copilot/agents/tasks`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
        },
      }
    );

    if (!response.ok) {
      throw new Error(`Copilot API error: ${response.status}`);
    }

    return response.json();
  }
}
