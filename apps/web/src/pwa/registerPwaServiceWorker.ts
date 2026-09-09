import { isElectron } from "../env";

const SERVICE_WORKER_URL = "/service-worker.js";

function sameOriginResourceUrls(entries: ReadonlyArray<PerformanceEntry>): ReadonlyArray<string> {
  if (typeof window === "undefined") return [];
  const urls = new Set<string>();
  for (const entry of entries) {
    try {
      const url = new URL(entry.name, window.location.href);
      if (url.origin === window.location.origin) urls.add(url.href);
    } catch {
      // Ignore malformed third-party performance entries.
    }
  }
  return [...urls];
}

export function shouldRegisterPwaServiceWorker(input: {
  readonly production: boolean;
  readonly electron: boolean;
  readonly serviceWorkerSupported: boolean;
}): boolean {
  return input.production && !input.electron && input.serviceWorkerSupported;
}

export async function registerPwaServiceWorker(): Promise<void> {
  if (
    !shouldRegisterPwaServiceWorker({
      production: import.meta.env.PROD,
      electron: isElectron,
      serviceWorkerSupported: typeof navigator !== "undefined" && "serviceWorker" in navigator,
    })
  ) {
    return;
  }

  try {
    await navigator.serviceWorker.register(SERVICE_WORKER_URL, {
      scope: "/",
      updateViaCache: "none",
    });
    const registration = await navigator.serviceWorker.ready;
    const resources = sameOriginResourceUrls(performance.getEntriesByType("resource"));
    registration.active?.postMessage({ type: "CACHE_APP_RESOURCES", resources });
  } catch (error) {
    console.warn("Could not enable offline app support.", error);
  }
}
