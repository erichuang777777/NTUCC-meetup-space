import { registerFeature } from "../feature-registry";
import { isEnabled } from "../features";

// No page of its own: the waitlist surfaces inside the public event pages
// (public-events.ts / guest-registration.ts) and the admin event editor.
registerFeature({ key: "event_waitlist" });

export const WAITLIST_ENABLED_KEY = "event_waitlist";

/** 候補中（第 N 位） */
export function waitlistLabel(position?: number | null): string {
  return position && position > 0 ? `候補中（第 ${position} 位）` : "候補中";
}

export const WAITLIST_NOTE =
  "目前名額已滿，你已排入候補。有人取消時會依登記順序自動遞補；遞補成功前不會提供報到 QR。";

/** Admin editor checkbox; empty unless the flag is on for the signed-in admin. */
export function waitlistField(enabled: boolean | undefined): string {
  return isEnabled(WAITLIST_ENABLED_KEY)
    ? `<label class="check"><input name="waitlist_enabled" type="checkbox" ${enabled ? "checked" : ""}>額滿後開放候補（有人取消時依序自動遞補）</label>`
    : "";
}

/** Adds waitlist_enabled to the saved record only when the feature is on. */
export function applyWaitlistRecord(record: Record<string, unknown>) {
  if (isEnabled(WAITLIST_ENABLED_KEY))
    record.waitlist_enabled = record.waitlist_enabled === "on";
  else delete record.waitlist_enabled;
}
