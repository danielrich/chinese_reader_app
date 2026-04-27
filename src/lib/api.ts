/**
 * HTTP API wrapper. POSTs to the Linux server's /api/invoke/:command endpoint.
 *
 * Match the Tauri wire convention by converting camelCase JS arg keys to
 * snake_case so the Rust dispatch handler finds the fields it expects.
 */

type InvokeArgs = Record<string, unknown>;

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
  return window.confirm(message);
}
