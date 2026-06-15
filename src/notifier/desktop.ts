/**
 * 跨平台桌面通知模块
 */

import { exec, execFile } from "node:child_process";
import { platform } from "node:os";

export interface NotifyOptions {
  title: string;
  body: string;
  sound?: boolean;
  urgency?: "low" | "normal" | "critical";
  platform?: "auto" | "macos" | "windows" | "linux";
}

export async function sendNotification(opts: NotifyOptions): Promise<void> {
  const plat = opts.platform === "auto" ? platform() : opts.platform;

  switch (plat) {
    case "darwin":
      return notifyMacOS(opts);
    case "win32":
      return notifyWindows(opts);
    case "linux":
      return notifyLinux(opts);
    default:
      console.error(`[Notifier] 不支持的平台: ${plat}`);
  }
}

function notifyMacOS(opts: NotifyOptions): Promise<void> {
  const sound = opts.sound ? `sound name "Glass"` : "";
  const script = `display notification "${escapeAppleScript(opts.body)}" with title "${escapeAppleScript(opts.title)}" ${sound}`;
  // 使用 execFile 避免 shell 单引号注入问题
  return execFilePromise("osascript", ["-e", script]);
}

function notifyWindows(opts: NotifyOptions): Promise<void> {
  // 使用 PowerShell BurntToast 或 fallback 到 MessageBox
  const psScript = `
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null

$template = @"
<toast>
    <visual>
        <binding template="ToastGeneric">
            <text>${escapeXml(opts.title)}</text>
            <text>${escapeXml(opts.body)}</text>
        </binding>
    </visual>
    ${opts.sound ? '<audio src="ms-winsoundevent:Notification.Default"/>' : '<audio silent="true"/>'}
</toast>
"@

$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$xml.LoadXml($template)
$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("ASM").Show($toast)
`;
  return execPromise(`powershell -NoProfile -Command "${psScript.replace(/\n/g, " ")}"`).catch(() => {
    // Fallback: 简单的 MessageBox
    return execPromise(
      `powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.MessageBox]::Show('${escapePS(opts.body)}', '${escapePS(opts.title)}')"`
    );
  });
}

function notifyLinux(opts: NotifyOptions): Promise<void> {
  const urgencyMap = { low: "low", normal: "normal", critical: "critical" };
  const urgency = urgencyMap[opts.urgency ?? "normal"];
  return execPromise(
    `notify-send -u ${urgency} -t 5000 "${escapeShell(opts.title)}" "${escapeShell(opts.body)}"`
  ).catch((err) => {
    // notify-send 可能未安装，静默处理
    console.error("[Notifier] Linux 通知失败（notify-send 可能未安装）:", err.message);
  });
}

function execPromise(cmd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    exec(cmd, { timeout: 5000 }, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function execFilePromise(file: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 5000 }, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function escapeAppleScript(str: string): string {
  return str.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function escapeXml(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapePS(str: string): string {
  return str.replace(/'/g, "''");
}

function escapeShell(str: string): string {
  return str.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\$/g, "\\$").replace(/`/g, "\\`");
}
