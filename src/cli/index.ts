#!/usr/bin/env node

/**
 * ASM CLI — Agent Status Monitor 统一命令行工具
 *
 * 用法:
 *   asm install     交互式安装（检测 Agent + 选择适配器）
 *   asm status       查看当前所有 Agent 状态
 *   asm daemon       启动后台状态聚合守护进程
 *   asm uninstall    卸载指定适配器
 *   asm config       查看 / 修改配置
 */

import { parseArgs } from "node:util";
import { installCommand } from "./commands/install.js";
import { statusCommand } from "./commands/status.js";
import { daemonCommand } from "./commands/daemon.js";
import { uninstallCommand } from "./commands/uninstall.js";
import { configCommand } from "./commands/config.js";

const HELP = `
  asm — Agent Status Monitor v0.1.0

  USAGE
    asm <command> [options]

  COMMANDS
    install       安装适配器（自动检测已安装的 Agent）
    uninstall     卸载已安装的适配器
    status        查看所有 Agent 实时状态
    daemon        启动后台状态聚合守护进程
    config        查看或修改配置

  OPTIONS
    -h, --help    显示帮助信息
    -v, --version 显示版本号

  EXAMPLES
    asm install              交互式安装
    asm install --agent claude-code   直接安装 Claude Code 适配器
    asm status               查看实时状态
    asm daemon --start       启动守护进程
    asm daemon --lan-port 8080  指定 LAN 服务端口
`;

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
      agent: { type: "string" },
      start: { type: "boolean" },
      stop: { type: "boolean" },
      get: { type: "string" },
      set: { type: "string" },
      "lan-port": { type: "string" },
    },
  });

  if (values.help || positionals.length === 0) {
    console.log(HELP);
    process.exit(0);
  }

  if (values.version) {
    console.log("0.1.0");
    process.exit(0);
  }

  const command = positionals[0];

  switch (command) {
    case "install":
      await installCommand({ agent: values.agent });
      break;
    case "uninstall":
      await uninstallCommand({ agent: values.agent });
      break;
    case "status":
      await statusCommand();
      break;
    case "daemon":
      await daemonCommand({ start: values.start, stop: values.stop, lanPort: values["lan-port"] ? Number(values["lan-port"]) : undefined });
      break;
    case "config":
      await configCommand({ get: values.get, set: values.set });
      break;
    default:
      console.error(`未知命令: ${command}\n运行 asm --help 查看可用命令。`);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error("ASM Error:", err.message || err);
  process.exit(1);
});
