import { listPendingSessions, saveSession } from "./idb";

export async function flushPendingSessions(): Promise<number> {
  const pending = await listPendingSessions();
  if (pending.length === 0) return 0;

  const payload = pending.map((s) => ({
    local_id: s.local_id,
    text_id: s.text_id,
    started_at_ms: s.started_at,
    finished_at_ms: s.finished_at!,
  }));

  const response = await fetch("/api/sync/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessions: payload }),
  });

  if (!response.ok) throw new Error(`Session sync failed: ${response.status}`);

  for (const s of pending) {
    await saveSession({ ...s, status: "uploaded" });
  }

  return pending.length;
}
