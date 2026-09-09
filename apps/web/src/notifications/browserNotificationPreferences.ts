import { useSyncExternalStore } from "react";

export const BROWSER_NOTIFICATION_PREFERENCES_KEY = "t3code:browser-notifications:v1";
const CHANGE_EVENT = "t3code:browser-notifications-change";

export interface BrowserNotificationPreferences {
  readonly enabled: boolean;
  readonly notifyOnApproval: boolean;
  readonly notifyOnInput: boolean;
  readonly notifyOnCompletion: boolean;
  readonly notifyOnFailure: boolean;
}

export const DEFAULT_BROWSER_NOTIFICATION_PREFERENCES: BrowserNotificationPreferences =
  Object.freeze({
    enabled: false,
    notifyOnApproval: true,
    notifyOnInput: true,
    notifyOnCompletion: true,
    notifyOnFailure: true,
  });

let cachedRaw: string | null | undefined;
let cachedPreferences = DEFAULT_BROWSER_NOTIFICATION_PREFERENCES;

export function parseBrowserNotificationPreferences(
  raw: string | null,
): BrowserNotificationPreferences {
  if (raw === null) return DEFAULT_BROWSER_NOTIFICATION_PREFERENCES;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (value.schemaVersion !== 1) return DEFAULT_BROWSER_NOTIFICATION_PREFERENCES;
    return {
      enabled: value.enabled === true,
      notifyOnApproval: value.notifyOnApproval !== false,
      notifyOnInput: value.notifyOnInput !== false,
      notifyOnCompletion: value.notifyOnCompletion !== false,
      notifyOnFailure: value.notifyOnFailure !== false,
    };
  } catch {
    return DEFAULT_BROWSER_NOTIFICATION_PREFERENCES;
  }
}

export function readBrowserNotificationPreferences(): BrowserNotificationPreferences {
  if (typeof window === "undefined") return DEFAULT_BROWSER_NOTIFICATION_PREFERENCES;
  const raw = window.localStorage.getItem(BROWSER_NOTIFICATION_PREFERENCES_KEY);
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    cachedPreferences = parseBrowserNotificationPreferences(raw);
  }
  return cachedPreferences;
}

export function writeBrowserNotificationPreferences(
  preferences: BrowserNotificationPreferences,
): void {
  if (typeof window === "undefined") return;
  const raw = JSON.stringify({ schemaVersion: 1, ...preferences });
  window.localStorage.setItem(BROWSER_NOTIFICATION_PREFERENCES_KEY, raw);
  cachedRaw = raw;
  cachedPreferences = preferences;
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

function subscribe(listener: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  const onStorage = (event: StorageEvent) => {
    if (event.key === BROWSER_NOTIFICATION_PREFERENCES_KEY) listener();
  };
  window.addEventListener(CHANGE_EVENT, listener);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(CHANGE_EVENT, listener);
    window.removeEventListener("storage", onStorage);
  };
}

export function useBrowserNotificationPreferences(): BrowserNotificationPreferences {
  return useSyncExternalStore(
    subscribe,
    readBrowserNotificationPreferences,
    () => DEFAULT_BROWSER_NOTIFICATION_PREFERENCES,
  );
}
