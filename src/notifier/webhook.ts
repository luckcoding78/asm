/**
 * Webhook 推送模块
 */

import type { StatusEvent } from "../core/protocol.js";

interface WebhookConfig {
  url: string;
  timeoutMs: number;
  retry: number;
}

export async function pushWebhook(
  event: StatusEvent,
  config: WebhookConfig
): Promise<void> {
  if (!config.url) return;

  const body = JSON.stringify({
    eventId: event.eventId,
    agent: event.agent,
    sessionId: event.sessionId,
    sessionName: event.sessionName,
    baseState: event.baseState,
    action: event.action,
    displayText: event.displayText,
    detail: event.detail,
    timestamp: event.timestamp,
    durationSec: event.durationSec,
    projectPath: event.projectPath,
  });

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= config.retry; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), config.timeoutMs);

      const response = await fetch(config.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (response.ok) return;

      lastError = new Error(`HTTP ${response.status}: ${response.statusText}`);
    } catch (err: any) {
      lastError = err;
      // 指数退避
      if (attempt < config.retry) {
        await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt)));
      }
    }
  }

  throw lastError ?? new Error("Webhook 推送失败");
}
