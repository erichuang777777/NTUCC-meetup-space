import test from "node:test";
import assert from "node:assert/strict";
import { clearFeatureCache } from "../netlify/functions/shared/features.js";
import {
  runEventReminders,
  config,
} from "../netlify/functions/event-reminders.js";
import { HttpError } from "../netlify/functions/shared/http.js";

const mock = (enabled: boolean, queued = 3) => {
  const calls: any[] = [];
  return {
    calls,
    rpc: async (fn: string, args?: any) => {
      calls.push([fn, args]);
      if (fn === "is_feature_enabled") return { data: enabled, error: null };
      return { data: queued, error: null };
    },
  };
};

test("reminders are skipped with 404 when the flag is off", async () => {
  clearFeatureCache();
  const db = mock(false);
  await assert.rejects(
    runEventReminders(db),
    (e: any) => e instanceof HttpError && e.code === "FEATURE_DISABLED",
  );
  assert.ok(!db.calls.some((c) => c[0] === "queue_event_reminders"));
});

test("reminders call the SQL function when the flag is on", async () => {
  clearFeatureCache();
  const db = mock(true, 4);
  assert.deepEqual(await runEventReminders(db), { queued: 4 });
  assert.deepEqual(db.calls[1], [
    "queue_event_reminders",
    { p_window: "24 hours" },
  ]);
});

test("function is scheduled hourly", () => {
  assert.equal(config.schedule, "@hourly");
});
