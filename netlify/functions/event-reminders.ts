import { db } from "./shared/auth-helper.js";
import { requireFeature } from "./shared/features.js";
import { fail, json } from "./shared/http.js";

type Rpc = Parameters<typeof requireFeature>[0];

/** Queue reminders for events starting within the window; no-op when the flag is off. */
export async function runEventReminders(client: Rpc, window = "24 hours") {
  await requireFeature(client, "notifications");
  const { data, error } = await client.rpc("queue_event_reminders", {
    p_window: window,
  });
  if (error) throw new Error("REMINDER_FAILED");
  return { queued: Number(data ?? 0) };
}

export default async () => {
  try {
    return json(await runEventReminders(db()));
  } catch (e) {
    return fail(e);
  }
};

export const config = { schedule: "@hourly" };
