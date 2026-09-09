import { useEffect, useMemo, useRef } from "react";

import { isElectron } from "../env";
import {
  useAllEnvironmentShellsBootstrapped,
  useProjects,
  useThreadShells,
} from "../state/entities";
import { useBrowserNotificationPreferences } from "./browserNotificationPreferences";
import {
  browserNotificationForTransition,
  buildBrowserAwarenessSnapshot,
  type BrowserThreadNotification,
} from "./browserNotifications";

async function showBrowserNotification(notification: BrowserThreadNotification): Promise<void> {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  const options: NotificationOptions = {
    body: notification.body,
    icon: "/pwa-icon-192.png",
    badge: "/favicon-32x32.png",
    tag: notification.tag,
    data: { route: notification.route },
  };

  if ("serviceWorker" in navigator) {
    const registration = await navigator.serviceWorker.getRegistration("/");
    if (registration?.active) {
      await registration.showNotification(notification.title, options);
      return;
    }
  }

  const visibleNotification = new Notification(notification.title, options);
  visibleNotification.addEventListener("click", () => {
    window.focus();
    window.location.assign(notification.route);
    visibleNotification.close();
  });
}

export function BrowserNotificationHost() {
  const projects = useProjects();
  const threads = useThreadShells();
  const bootstrapped = useAllEnvironmentShellsBootstrapped();
  const preferences = useBrowserNotificationPreferences();
  const states = useMemo(
    () => buildBrowserAwarenessSnapshot(projects, threads),
    [projects, threads],
  );
  const previousStates = useRef<ReadonlyMap<string, ReturnType<typeof states.get>> | null>(null);

  useEffect(() => {
    if (!bootstrapped) return;
    const previous = previousStates.current;
    previousStates.current = states;
    if (previous === null || isElectron || document.visibilityState !== "hidden") return;

    for (const [key, next] of states) {
      const notification = browserNotificationForTransition({
        previous: previous.get(key),
        next,
        preferences,
      });
      if (notification) {
        void showBrowserNotification(notification).catch((error) => {
          console.warn("Could not show browser notification.", error);
        });
      }
    }
  }, [bootstrapped, preferences, states]);

  return null;
}
