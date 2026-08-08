type StatusKind = "preparing" | "ready" | "unavailable";

interface ShellVerification {
  buildId?: string;
  verified: boolean;
  reason?: string;
  activeReleaseId?: string;
  locallyPresentReleaseIds?: string[];
  diagnostics?: unknown;
}

interface OfflineDiagnostics {
  lastLaunchTime: number;
  onlineAtLaunch: boolean;
  controlled: boolean;
  serviceWorkerScriptUrl?: string;
  serviceWorkerState?: string;
  appBuildId?: string;
  activeReleaseId?: string;
  locallyPresentReleaseIds?: string[];
  lastSuccessfulShellVerificationTime?: number;
  lastError?: { name: string; message: string; at: number };
  persistentStorage?: boolean;
  workerDiagnostics?: unknown;
}

const STORAGE_KEY = "chinese-reader-offline-diagnostics-v1";

function readDiagnostics(): OfflineDiagnostics {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as OfflineDiagnostics | null;
    if (parsed) return parsed;
  } catch {
    // Replace malformed local diagnostics.
  }
  return {
    lastLaunchTime: Date.now(),
    onlineAtLaunch: navigator.onLine,
    controlled: Boolean(navigator.serviceWorker?.controller),
  };
}

function writeDiagnostics(fields: Partial<OfflineDiagnostics>): OfflineDiagnostics {
  const value = { ...readDiagnostics(), ...fields };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  return value;
}

function describeError(error: unknown): { name: string; message: string; at: number } {
  if (error instanceof Error) return { name: error.name, message: error.message, at: Date.now() };
  return { name: "Error", message: String(error), at: Date.now() };
}

async function sendWorkerMessage<T>(type: string): Promise<T> {
  const controller = navigator.serviceWorker.controller;
  if (!controller) throw new Error("This page is not controlled by a service worker yet.");
  return await new Promise<T>((resolve, reject) => {
    const channel = new MessageChannel();
    const timer = window.setTimeout(() => reject(new Error(`${type} timed out`)), 3_000);
    channel.port1.onmessage = (event) => {
      window.clearTimeout(timer);
      if (event.data?.ok) resolve(event.data.value as T);
      else reject(new Error(event.data?.error ?? `${type} failed`));
    };
    controller.postMessage({ type }, [channel.port2]);
  });
}

async function readStorageStatus(): Promise<string> {
  if (!navigator.storage) return "Storage persistence unsupported";
  const parts: string[] = [];
  if (navigator.storage.persisted) {
    const persisted = await navigator.storage.persisted();
    writeDiagnostics({ persistentStorage: persisted });
    parts.push(persisted ? "Persistent storage granted" : "Persistence not granted");
  } else {
    parts.push("Storage persistence unsupported");
  }
  if (navigator.storage.estimate) {
    const { usage, quota } = await navigator.storage.estimate();
    if (typeof usage === "number" && typeof quota === "number" && quota > 0) {
      const usedMb = (usage / 1024 / 1024).toFixed(1);
      const quotaMb = (quota / 1024 / 1024).toFixed(0);
      parts.push(`${usedMb} MB of ${quotaMb} MB used`);
    }
  }
  return parts.join(" · ");
}

export async function requestOfflineStoragePersistence(): Promise<boolean | null> {
  if (!navigator.storage?.persist) return null;
  const granted = await navigator.storage.persist();
  writeDiagnostics({ persistentStorage: granted });
  window.dispatchEvent(new CustomEvent("offline-storage-changed"));
  return granted;
}

export function initializeOfflineStatus(container: HTMLElement): void {
  container.innerHTML = `
    <div class="offline-status-copy">
      <strong id="offline-status-state">Preparing offline launch</strong>
      <span id="offline-status-reason">Checking the installed app shell…</span>
      <span id="offline-storage-state"></span>
    </div>
    <div class="offline-status-actions">
      <button id="offline-retry-btn" type="button" class="btn-secondary">Retry setup</button>
      <button id="offline-copy-btn" type="button" class="btn-secondary">Copy diagnostics</button>
    </div>
  `;

  const state = container.querySelector<HTMLElement>("#offline-status-state")!;
  const reason = container.querySelector<HTMLElement>("#offline-status-reason")!;
  const storage = container.querySelector<HTMLElement>("#offline-storage-state")!;
  const retry = container.querySelector<HTMLButtonElement>("#offline-retry-btn")!;
  const copy = container.querySelector<HTMLButtonElement>("#offline-copy-btn")!;

  const render = (kind: StatusKind, message: string, detail: string) => {
    container.dataset.status = kind;
    state.textContent = message;
    reason.textContent = detail;
  };

  const refreshStorage = async () => {
    storage.textContent = await readStorageStatus().catch(() => "Storage status unavailable");
  };

  const verify = async () => {
    writeDiagnostics({
      lastLaunchTime: Date.now(),
      onlineAtLaunch: navigator.onLine,
      controlled: Boolean(navigator.serviceWorker.controller),
    });
    if (!window.isSecureContext) {
      render("unavailable", "Offline launch unavailable", "A secure HTTPS context is required.");
      return;
    }
    if (!navigator.serviceWorker.controller) {
      render("preparing", "Preparing offline launch", "Reload once after setup so the service worker controls this page.");
      return;
    }
    try {
      const verification = await sendWorkerMessage<ShellVerification>("VERIFY_SHELL");
      const registration = await navigator.serviceWorker.getRegistration();
      const worker = registration?.active;
      writeDiagnostics({
        controlled: true,
        serviceWorkerScriptUrl: worker?.scriptURL,
        serviceWorkerState: worker?.state,
        appBuildId: verification.buildId,
        activeReleaseId: verification.activeReleaseId,
        locallyPresentReleaseIds: verification.locallyPresentReleaseIds,
        lastSuccessfulShellVerificationTime: verification.verified ? Date.now() : undefined,
        workerDiagnostics: verification.diagnostics,
      });
      if (verification.verified) {
        render("ready", "Offline launch ready", `Verified release ${verification.activeReleaseId ?? verification.buildId ?? "unknown"}.`);
      } else {
        render("unavailable", "Offline launch unavailable", verification.reason || "The cached shell could not be verified.");
      }
    } catch (error) {
      writeDiagnostics({ lastError: describeError(error) });
      render("unavailable", "Offline launch unavailable", error instanceof Error ? error.message : String(error));
    }
  };

  retry.addEventListener("click", async () => {
    retry.disabled = true;
    render("preparing", "Preparing offline launch", "Checking for a complete app shell…");
    try {
      const registration = await navigator.serviceWorker.getRegistration();
      if (!registration) throw new Error("No service-worker registration exists.");
      await registration.update();
      await verify();
    } catch (error) {
      writeDiagnostics({ lastError: describeError(error) });
      render("unavailable", "Offline launch unavailable", error instanceof Error ? error.message : String(error));
    } finally {
      retry.disabled = false;
    }
  });

  copy.addEventListener("click", async () => {
    const local = readDiagnostics();
    let worker: unknown;
    try {
      worker = await sendWorkerMessage<unknown>("GET_DIAGNOSTICS");
    } catch (error) {
      worker = { unavailable: describeError(error) };
    }
    await navigator.clipboard.writeText(JSON.stringify({ local, worker }, null, 2));
    copy.textContent = "Copied";
    window.setTimeout(() => { copy.textContent = "Copy diagnostics"; }, 1_500);
  });

  navigator.serviceWorker.addEventListener("controllerchange", () => { void verify(); });
  window.addEventListener("online", () => { void verify(); });
  window.addEventListener("offline-storage-changed", () => { void refreshStorage(); });
  void Promise.all([verify(), refreshStorage()]);
}
