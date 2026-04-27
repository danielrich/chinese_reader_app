/**
 * Environment-aware API wrappers.
 *
 * In Tauri context (desktop app):   uses @tauri-apps/api/core invoke()
 *                                   and @tauri-apps/plugin-dialog confirm()
 * In browser context (HTTP server): POSTs to /api/invoke/:command
 *                                   and uses window.confirm()
 */

type InvokeArgs = Record<string, unknown>;

export async function invoke<T>(command: string, args?: InvokeArgs): Promise<T> {
  if (typeof window !== "undefined" && (window as any).__TAURI__) {
    const { invoke: tauriInvoke } = await import("@tauri-apps/api/core");
    return tauriInvoke<T>(command, args);
  }

  const response = await fetch(`/api/invoke/${command}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(args ?? {}),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Command ${command} failed (${response.status}): ${text}`);
  }

  const text = await response.text();
  if (text === "" || text === "null") {
    return null as unknown as T;
  }
  return JSON.parse(text) as T;
}

export async function confirm(message: string): Promise<boolean> {
  if (typeof window !== "undefined" && (window as any).__TAURI__) {
    const { confirm: tauriConfirm } = await import("@tauri-apps/plugin-dialog");
    return tauriConfirm(message);
  }
  return window.confirm(message);
}
