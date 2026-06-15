/**
 * ASM CLI — config 命令
 * 查看或修改 ASM 配置
 */

import pc from "picocolors";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { CONFIG_FILE, getDefaultConfig, type AsmConfig } from "../../core/protocol.js";

export async function configCommand(opts: { get?: string; set?: string }) {
  let config: AsmConfig;

  if (existsSync(CONFIG_FILE)) {
    config = JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
  } else {
    config = getDefaultConfig();
    writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), "utf-8");
  }

  if (opts.get) {
    const keys = opts.get.split(".");
    let value: any = config;
    for (const key of keys) {
      value = value?.[key];
    }
    if (value === undefined) {
      console.log(pc.dim(`  配置项 ${opts.get} 不存在。`));
    } else {
      console.log(`  ${pc.bold(opts.get)} = ${JSON.stringify(value)}`);
    }
    return;
  }

  if (opts.set) {
    const [key, ...valueParts] = opts.set.split("=");
    const value = valueParts.join("=");

    if (!key || value === undefined) {
      console.error(pc.red("  用法: asm config --set key=value"));
      return;
    }

    const keys = key.trim().split(".");
    let target: any = config;
    for (let i = 0; i < keys.length - 1; i++) {
      if (!target[keys[i]]) target[keys[i]] = {};
      target = target[keys[i]];
    }

    // 自动类型转换
    let parsedValue: any = value.trim();
    if (parsedValue === "true") parsedValue = true;
    else if (parsedValue === "false") parsedValue = false;
    else if (/^\d+$/.test(parsedValue)) parsedValue = Number(parsedValue);

    target[keys[keys.length - 1]] = parsedValue;

    writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), "utf-8");
    console.log(`  ${pc.green("✔")} ${key.trim()} = ${JSON.stringify(parsedValue)}`);
    return;
  }

  // 默认：显示完整配置
  console.log();
  console.log(pc.bold("  ASM 配置") + pc.dim(` (${CONFIG_FILE})`));
  console.log();
  console.log(JSON.stringify(config, null, 2));
  console.log();
}
