/**
 * Environment-aware API wrappers.
 *
 * In Tauri context (desktop app):   uses @tauri-apps/api/core invoke()
 *                                   and @tauri-apps/plugin-dialog confirm()
 * In browser context (HTTP server): POSTs to /api/invoke/:command
 *                                   and uses window.confirm()
 */

type InvokeArgs = Record<string, unknown>;

// Match Tauri's wire convention: convert camelCase JS arg keys to snake_case
// for the Rust side. Recurses into plain objects and arrays so nested payloads
// (e.g. ManualLogInput) are converted too.
function camelToSnake(key: string): string {
  return key.replace(/[A-Z]/g, (m) => "_" + m.toLowerCase());
}

function convertKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(convertKeys);
  if (value && typeof value === "object" && value.constructor === Object) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[camelToSnake(k)] = convertKeys(v);
    }
    return out;
  }
  return value;
}

export async function invoke<T>(command: string, args?: InvokeArgs): Promise<T> {
  if (typeof window !== "undefined" && (window as any).__TAURI__) {
    const { invoke: tauriInvoke } = await import("@tauri-apps/api/core");
    return tauriInvoke<T>(command, args);
  }

  const body = convertKeys(args ?? {});
  const response = await fetch(`/api/invoke/${command}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
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
