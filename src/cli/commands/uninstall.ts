/**
 * ASM CLI — uninstall 命令
 */

import prompts from "prompts";
import pc from "picocolors";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { CONFIG_FILE, type AsmConfig, type AgentType } from "../../core/protocol.js";
import { ClaudeCodeAdapter } from "../../adapters/claude-code/index.js";
import { CodexAdapter } from "../../adapters/codex/index.js";
import { CopilotAdapter } from "../../adapters/copilot/index.js";
import { CursorAdapter } from "../../adapters/cursor/index.js";

const ADAPTER_UNINSTALLERS: Record<AgentType, () => Promise<void>> = {
  "claude-code": () => new ClaudeCodeAdapter().uninstall(),
  "codex": () => new CodexAdapter().uninstall(),
  "copilot": () => new CopilotAdapter().uninstall(),
  "cursor": () => new CursorAdapter().uninstall(),
  "gemini": async () => {},
  "unknown": async () => {},
};

export async function uninstallCommand(opts: { agent?: string }) {
  if (!existsSync(CONFIG_FILE)) {
    console.log(pc.dim("\n  未找到 ASM 配置，似乎未安装过。\n"));
    return;
  }

  const config: AsmConfig = JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
  const installed = config.adapters.filter(a => a.enabled);

  if (installed.length === 0) {
    console.log(pc.dim("\n  没有已安装的适配器。\n"));
    return;
  }

  let toUninstall: AgentType[];

  if (opts.agent) {
    toUninstall = [opts.agent as AgentType];
  } else {
    const response = await prompts({
      type: "multiselect",
      name: "agents",
      message: "选择要卸载的适配器",
      choices: installed.map(a => ({
        title: a.type,
        value: a.type,
      })),
    });

    toUninstall = response.agents || [];
  }

  if (toUninstall.length === 0) {
    console.log(pc.dim("\n  未选择任何适配器。"));
    return;
  }

  for (const type of toUninstall) {
    const uninstaller = ADAPTER_UNINSTALLERS[type];
    if (uninstaller) {
      try {
        await uninstaller();
        console.log(`  ${pc.green("✔")} ${type} ${pc.green("已卸载")}`);
      } catch (err: any) {
        console.error(`  ${pc.red("✘")} ${type} ${pc.red("卸载失败")}: ${err.message}`);
      }
    }

    // 更新配置
    config.adapters = config.adapters.filter(a => a.type !== type);
  }

  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), "utf-8");
  console.log();
}
