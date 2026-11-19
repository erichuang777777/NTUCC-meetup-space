import test from "node:test";
import assert from "node:assert/strict";
import { clearFeatureCache } from "../netlify/functions/shared/features.js";
import {
  filterHidden,
  hiddenIds,
  isHidden,
} from "../netlify/functions/shared/moderation.js";
import { HttpError } from "../netlify/functions/shared/http.js";

function mockDb(opts: { enabled: boolean; hidden?: string[]; fail?: boolean }) {
  const calls: any[] = [];
  return {
    calls,
    rpc: async (fn: string, args?: any) => {
      calls.push([fn, args]);
      if (fn === "is_feature_enabled")
        return { data: opts.enabled, error: null };
      if (fn === "moderation_hidden_ids")
        return opts.fail
          ? { data: null, error: { message: "x" } }
          : {
              data: (args.p_ids as string[]).filter((i) =>
                (opts.hidden ?? []).includes(i),
              ),
              error: null,
            };
      return { data: null, error: { message: "unknown" } };
    },
  };
}
const rows = [{ id: "a" }, { id: "b" }, { id: "c" }];

test("filterHidden is a no-op and skips the RPC while the flag is off", async () => {
  clearFeatureCache();
  const db = mockDb({ enabled: false, hidden: ["a"] });
  assert.deepEqual(await filterHidden(db, "u1", "thread", rows), rows);
  assert.equal(
    db.calls.some((c) => c[0] === "moderation_hidden_ids"),
    false,
  );
});

test("filterHidden removes hidden rows when enabled", async () => {
  clearFeatureCache();
  const db = mockDb({ enabled: true, hidden: ["b"] });
  assert.deepEqual(await filterHidden(db, "u1", "qa", rows), [
    { id: "a" },
    { id: "c" },
  ]);
  const call = db.calls.find((c) => c[0] === "moderation_hidden_ids");
  assert.deepEqual(call[1], {
    p_type: "qa",
    p_ids: ["a", "b", "c"],
    p_viewer: "u1",
  });
});

test("filterHidden tolerates empty and null input", async () => {
  clearFeatureCache();
  const db = mockDb({ enabled: true });
  assert.deepEqual(await filterHidden(db, "u1", "space", []), []);
  assert.deepEqual(await filterHidden(db, "u1", "space", null), []);
  assert.equal(db.calls.length, 0);
});

test("isHidden reports a single id and fails closed on RPC errors", async () => {
  clearFeatureCache();
  assert.equal(
    await isHidden(
      mockDb({ enabled: true, hidden: ["a"] }),
      "u",
      "pain_point",
      "a",
    ),
    true,
  );
  assert.equal(
    await isHidden(
      mockDb({ enabled: true, hidden: ["a"] }),
      "u",
      "pain_point",
      "z",
    ),
    false,
  );
  await assert.rejects(
    () => hiddenIds(mockDb({ enabled: true, fail: true }), "u", "reply", ["a"]),
    (e: unknown) =>
      e instanceof HttpError && e.code === "MODERATION_UNAVAILABLE",
  );
});
