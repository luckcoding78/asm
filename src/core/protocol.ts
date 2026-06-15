/**
 * ASM Protocol — 统一状态数据协议
 *
 * 所有 Agent 适配器输出的状态事件都必须遵循此协议。
 * Status Engine 和消费端（桌面 App、移动 App）只依赖此协议，
 * 不需要关心数据来自哪个适配器。
 */

import { homedir } from "node:os";
import { join } from "node:path";

// ── 基础状态 ──
export type BaseState =
  | "idle"       // Agent 空闲，等待输入
  | "working"    // Agent 正在执行任务
  | "waiting"    // Agent 等待用户操作（权限确认、输入等）
  | "completed"  // 当前任务已完成
  | "error"      // 任务出错
  | "offline";   // Agent 未连接 / 已断开

// ── 语义动作 ──
export type SemanticAction =
  | "thinking"          // 思考推理中
  | "generating"        // 生成响应 / 代码
  | "editing"           // 编辑文件
  | "file-reading"      // 读取文件
  | "searching"         // 搜索代码
  | "testing"           // 运行测试
  | "git-operating"     // 执行 Git 操作
  | "tool-calling"      // 调用工具（通用）
  | "reviewing"         // 审查代码
  | "networking"        // 网络请求
  | "permission-waiting"// 等待权限确认
  | "subagent-running"  // 子 Agent 运行中
  | "input-waiting"     // 等待用户输入
  | "building"          // 构建项目
  | "deploying"         // 部署
  | "none";             // 无特定动作

// ── 支持的 Agent 类型 ──
export type AgentType =
  | "claude-code"
  | "codex"
  | "copilot"
  | "cursor"
  | "gemini"
  | "unknown";

// ── 状态事件（适配器 → Status Engine） ──
export interface StatusEvent {
  /** 事件唯一 ID */
  eventId: string;
  /** 来源 Agent 类型 */
  agent: AgentType;
  /** Agent 会话 ID */
  sessionId: string;
  /** 会话名称（用户可读） */
  sessionName?: string;
  /** 基础状态 */
  baseState: BaseState;
  /** 语义动作 */
  action: SemanticAction;
  /** 人类可读的显示文本 */
  displayText: string;
  /** 详细信息（如正在编辑的文件名） */
  detail?: string;
  /** 事件时间戳 ISO 8601 */
  timestamp: string;
  /** 当前状态已持续时长（秒） */
  durationSec?: number;
  /** 项目路径 */
  projectPath?: string;
  /** 适配器版本 */
  adapterVersion?: string;
}

// ── Agent 快照（Status Engine → 消费端） ──
export interface AgentSnapshot {
  /** Agent 类型 */
  agent: AgentType;
  /** 会话 ID */
  sessionId: string;
  /** 会话名称 */
  sessionName: string;
  /** 基础状态 */
  baseState: BaseState;
  /** 语义动作 */
  action: SemanticAction;
  /** 显示文本 */
  displayText: string;
  /** 详细信息 */
  detail?: string;
  /** 最后更新时间 */
  lastUpdated: string;
  /** 状态持续时长（秒） */
  durationSec: number;
  /** 项目路径 */
  projectPath?: string;
}

// ── 全局状态（Status Engine 持久化） ──
export interface GlobalState {
  /** 协议版本 */
  protocolVersion: string;
  /** 最后更新时间 */
  lastUpdated: string;
  /** 所有活跃 Agent 的快照 */
  agents: Record<string, AgentSnapshot>;
}

// ── 适配器配置 ──
export interface AdapterConfig {
  /** 适配器类型 */
  type: AgentType;
  /** 是否启用 */
  enabled: boolean;
  /** 适配器特定配置 */
  options?: Record<string, unknown>;
}

// ── ASM 全局配置 ──
export interface AsmConfig {
  /** 协议版本 */
  protocolVersion: string;
  /** 已启用的适配器 */
  adapters: AdapterConfig[];
  /** 通知配置 */
  notification: {
    enabled: boolean;
    platform: "auto" | "macos" | "windows" | "linux";
    triggers: NotificationTrigger[];
    quietHours?: {
      enabled: boolean;
      start: string;
      end: string;
    };
  };
  /** Webhook 推送配置 */
  webhook: {
    enabled: boolean;
    url: string;
    timeoutMs: number;
    retry: number;
  };
}

export interface NotificationTrigger {
  state: BaseState | `${BaseState}.${SemanticAction}`;
  title: string;
  sound: boolean;
  urgency?: "low" | "normal" | "critical";
  cooldownSec?: number;
}

// ── 常量 ──
export const PROTOCOL_VERSION = "1.0.0";
export const ASM_DIR = process.env.ASM_DIR || getDefaultAsmDir();
export const STATUS_FILE = join(ASM_DIR, "status.json");
export const CONFIG_FILE = join(ASM_DIR, "config.json");
export const EVENTS_LOG = join(ASM_DIR, "events.log");

function getDefaultAsmDir(): string {
  return join(homedir(), ".asm");
}

// ── 默认配置 ──
export function getDefaultConfig(): AsmConfig {
  return {
    protocolVersion: PROTOCOL_VERSION,
    adapters: [],
    notification: {
      enabled: true,
      platform: "auto",
      triggers: [
        { state: "completed", title: "任务完成", sound: true, urgency: "normal", cooldownSec: 5 },
        { state: "error", title: "任务出错", sound: true, urgency: "critical" },
        { state: "waiting.permission-waiting", title: "需要确认权限", sound: false, urgency: "normal" },
        { state: "waiting.input-waiting", title: "等待输入", sound: false, urgency: "low" },
      ],
    },
    webhook: {
      enabled: false,
      url: "",
      timeoutMs: 3000,
      retry: 2,
    },
  };
}

// ── 工具函数 ──
export function createEventId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function nowISO(): string {
  return new Date().toISOString();
}
