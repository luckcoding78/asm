/**
 * Status Engine — 状态机引擎
 *
 * 核心职责：
 * 1. 接收适配器推送的 StatusEvent
 * 2. 执行状态转移逻辑（验证转移合法性）
 * 3. 更新 Agent 快照
 * 4. 判断是否需要发送通知
 * 5. 持久化到 status.json
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  type StatusEvent,
  type AgentSnapshot,
  type GlobalState,
  type BaseState,
  type AsmConfig,
  type NotificationTrigger,
  PROTOCOL_VERSION,
  STATUS_FILE,
  CONFIG_FILE,
  ASM_DIR,
  getDefaultConfig,
  nowISO,
} from "./protocol.js";
import { sendNotification } from "../notifier/desktop.js";
import { pushWebhook } from "../notifier/webhook.js";

// ── 合法状态转移表 ──
const VALID_TRANSITIONS: Record<BaseState, BaseState[]> = {
  idle: ["working", "offline"],
  working: ["working", "waiting", "completed", "error", "idle", "offline"],
  waiting: ["working", "idle", "completed", "error", "offline"],
  completed: ["idle", "working", "offline"],
  error: ["idle", "working", "offline"],
  offline: ["idle", "working"],
};

export class StatusEngine {
  private state: GlobalState;
  private config: AsmConfig;
  private lastNotifyTime: Map<string, number> = new Map();

  constructor() {
    this.state = this.loadState();
    this.config = this.loadConfig();
  }

  // ── 接收事件 ──
  processEvent(event: StatusEvent): { updated: boolean; shouldNotify: boolean } {
    const key = `${event.agent}:${event.sessionId}`;
    const prev = this.state.agents[key];
    const prevBaseState = prev?.baseState ?? "offline";

    // 验证状态转移合法性
    if (!this.isValidTransition(prevBaseState, event.baseState)) {
      console.error(
        `[StatusEngine] 非法状态转移: ${prevBaseState} → ${event.baseState} (${event.agent}:${event.sessionId})`
      );
      return { updated: false, shouldNotify: false };
    }

    // 构建新快照
    const snapshot: AgentSnapshot = {
      agent: event.agent,
      sessionId: event.sessionId,
      sessionName: event.sessionName ?? prev?.sessionName ?? event.sessionId.slice(0, 8),
      baseState: event.baseState,
      action: event.action,
      displayText: event.displayText,
      detail: event.detail,
      lastUpdated: event.timestamp,
      durationSec: event.durationSec ?? this.calcDuration(prev, event),
      projectPath: event.projectPath ?? prev?.projectPath,
    };

    // 更新状态
    this.state.agents[key] = snapshot;
    this.state.lastUpdated = nowISO();

    // 判断是否需要通知
    const shouldNotify = this.shouldNotify(event, prev);

    // 持久化
    this.saveState();

    // 发送通知
    if (shouldNotify) {
      this.doNotify(snapshot);
    }

    // Webhook 推送
    if (this.config.webhook.enabled) {
      pushWebhook(event, this.config.webhook).catch(err => {
        console.error("[StatusEngine] Webhook 推送失败:", err.message);
      });
    }

    return { updated: true, shouldNotify };
  }

  // ── 获取完整全局状态 ──
  getState(): GlobalState {
    return this.state;
  }

  // ── 获取当前所有 Agent 状态 ──
  getAllSnapshots(): AgentSnapshot[] {
    return Object.values(this.state.agents);
  }

  // ── 按 Agent 类型过滤 ──
  getByAgent(agentType: string): AgentSnapshot[] {
    return Object.values(this.state.agents).filter(s => s.agent === agentType);
  }

  // ── 清理过期会话（超过 30 分钟无更新标记为 offline） ──
  cleanup(staleThresholdMs: number = 30 * 60 * 1000): void {
    const now = Date.now();
    for (const [key, snapshot] of Object.entries(this.state.agents)) {
      const lastUpdate = new Date(snapshot.lastUpdated).getTime();
      if (now - lastUpdate > staleThresholdMs && snapshot.baseState !== "offline") {
        snapshot.baseState = "offline";
        snapshot.displayText = "离线（超时）";
        snapshot.lastUpdated = nowISO();
      }
    }
    this.saveState();
  }

  // ── 状态转移验证 ──
  private isValidTransition(from: BaseState, to: BaseState): boolean {
    return VALID_TRANSITIONS[from]?.includes(to) ?? false;
  }

  // ── 通知规则评估 ──
  private shouldNotify(event: StatusEvent, prev?: AgentSnapshot): boolean {
    if (!this.config.notification.enabled) return false;

    const fullState = `${event.baseState}.${event.action}`;
    const now = Date.now();

    for (const trigger of this.config.notification.triggers) {
      const matches = trigger.state === event.baseState || trigger.state === fullState;
      if (!matches) continue;

      // 冷却检查
      const cooldownKey = `${event.agent}:${event.sessionId}:${trigger.state}`;
      const lastNotify = this.lastNotifyTime.get(cooldownKey) ?? 0;
      const cooldownMs = (trigger.cooldownSec ?? 0) * 1000;
      if (now - lastNotify < cooldownMs) continue;

      // 避免重复通知同一状态
      if (prev?.baseState === event.baseState && prev?.action === event.action) continue;

      this.lastNotifyTime.set(cooldownKey, now);
      return true;
    }

    return false;
  }

  // ── 发送通知 ──
  private doNotify(snapshot: AgentSnapshot): void {
    const trigger = this.config.notification.triggers.find(
      t => t.state === snapshot.baseState || t.state === `${snapshot.baseState}.${snapshot.action}`
    );

    sendNotification({
      title: `ASM · ${snapshot.sessionName}`,
      body: `${snapshot.displayText}${snapshot.detail ? ` — ${snapshot.detail}` : ""}`,
      sound: trigger?.sound ?? false,
      urgency: trigger?.urgency ?? "normal",
      platform: this.config.notification.platform,
    }).catch(err => {
      console.error("[StatusEngine] 通知发送失败:", err.message);
    });
  }

  // ── 计算状态持续时长 ──
  private calcDuration(prev: AgentSnapshot | undefined, event: StatusEvent): number {
    if (!prev) return 0;
    if (prev.baseState === event.baseState && prev.action === event.action) {
      return prev.durationSec;
    }
    return 0;
  }

  // ── 持久化 ──
  private loadState(): GlobalState {
    if (existsSync(STATUS_FILE)) {
      try {
        return JSON.parse(readFileSync(STATUS_FILE, "utf-8"));
      } catch {
        // 文件损坏，重置
      }
    }
    return {
      protocolVersion: PROTOCOL_VERSION,
      lastUpdated: nowISO(),
      agents: {},
    };
  }

  private saveState(): void {
    if (!existsSync(dirname(STATUS_FILE))) {
      mkdirSync(dirname(STATUS_FILE), { recursive: true });
    }
    writeFileSync(STATUS_FILE, JSON.stringify(this.state, null, 2), "utf-8");
  }

  private loadConfig(): AsmConfig {
    if (existsSync(CONFIG_FILE)) {
      try {
        return JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
      } catch {
        // 配置文件损坏，使用默认
      }
    }
    const config = getDefaultConfig();
    if (!existsSync(dirname(CONFIG_FILE))) {
      mkdirSync(dirname(CONFIG_FILE), { recursive: true });
    }
    writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), "utf-8");
    return config;
  }
}
