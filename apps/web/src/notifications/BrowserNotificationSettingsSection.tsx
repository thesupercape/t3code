import { useState } from "react";

import { isElectron } from "../env";
import { SettingsRow, SettingsSection } from "../components/settings/settingsLayout";
import { Switch } from "../components/ui/switch";
import {
  useBrowserNotificationPreferences,
  writeBrowserNotificationPreferences,
} from "./browserNotificationPreferences";

function browserNotificationSupport(): boolean {
  return !isElectron && typeof window !== "undefined" && "Notification" in window;
}

export function BrowserNotificationSettingsSection() {
  const preferences = useBrowserNotificationPreferences();
  const [permission, setPermission] = useState<NotificationPermission>(() =>
    browserNotificationSupport() ? Notification.permission : "denied",
  );
  const supported = browserNotificationSupport();

  const setEnabled = async (enabled: boolean) => {
    if (!enabled) {
      writeBrowserNotificationPreferences({ ...preferences, enabled: false });
      return;
    }
    const nextPermission = await Notification.requestPermission();
    setPermission(nextPermission);
    writeBrowserNotificationPreferences({
      ...preferences,
      enabled: nextPermission === "granted",
    });
  };
  const updatePreference = (
    key: "notifyOnApproval" | "notifyOnInput" | "notifyOnCompletion" | "notifyOnFailure",
    enabled: boolean,
  ) => writeBrowserNotificationPreferences({ ...preferences, [key]: enabled });

  const description = !supported
    ? "This browser does not support task notifications."
    : permission === "denied"
      ? "Notifications are blocked in this browser's site settings."
      : "Notify this browser while T3 Code remains open in the background.";

  return (
    <SettingsSection title="Browser notifications">
      <SettingsRow
        title="Task notifications"
        description={description}
        control={
          <Switch
            checked={preferences.enabled && permission === "granted"}
            disabled={!supported || permission === "denied"}
            onCheckedChange={(checked) => void setEnabled(Boolean(checked))}
            aria-label="Task notifications"
          />
        }
      />
      <SettingsRow
        title="Approval requests"
        description="Notify when an agent needs approval before it can continue."
        control={
          <Switch
            checked={preferences.notifyOnApproval}
            disabled={!preferences.enabled}
            onCheckedChange={(checked) => updatePreference("notifyOnApproval", Boolean(checked))}
            aria-label="Approval request notifications"
          />
        }
      />
      <SettingsRow
        title="Questions"
        description="Notify when an agent is waiting for your input."
        control={
          <Switch
            checked={preferences.notifyOnInput}
            disabled={!preferences.enabled}
            onCheckedChange={(checked) => updatePreference("notifyOnInput", Boolean(checked))}
            aria-label="Agent question notifications"
          />
        }
      />
      <SettingsRow
        title="Completed tasks"
        description="Notify when an agent finishes its work."
        control={
          <Switch
            checked={preferences.notifyOnCompletion}
            disabled={!preferences.enabled}
            onCheckedChange={(checked) => updatePreference("notifyOnCompletion", Boolean(checked))}
            aria-label="Completed task notifications"
          />
        }
      />
      <SettingsRow
        title="Failed tasks"
        description="Notify when an agent run fails."
        control={
          <Switch
            checked={preferences.notifyOnFailure}
            disabled={!preferences.enabled}
            onCheckedChange={(checked) => updatePreference("notifyOnFailure", Boolean(checked))}
            aria-label="Failed task notifications"
          />
        }
      />
    </SettingsSection>
  );
}
