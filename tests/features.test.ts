import test from "node:test";
import assert from "node:assert/strict";
import {
  isFeatureEnabled,
  requireFeature,
  clearFeatureCache,
} from "../netlify/functions/shared/features.js";
import { HttpError, fail } from "../netlify/functions/shared/http.js";

const mockDb = (result: { data: any; error: any }) => {
  const calls: any[] = [];
  return {
    calls,
    rpc: async (fn: string, args?: any) => {
      calls.push([fn, args]);
      return result;
    },
  };
};

test("isFeatureEnabled reflects the RPC result and caches briefly", async () => {
  clearFeatureCache();
  const db = mockDb({ data: true, error: null });
  assert.equal(await isFeatureEnabled(db, "polls"), true);
  assert.equal(await isFeatureEnabled(db, "polls"), true);
  assert.equal(db.calls.length, 1);
  assert.deepEqual(db.calls[0], ["is_feature_enabled", { p_key: "polls" }]);
  assert.equal(await isFeatureEnabled(db, "polls", Date.now() + 60_000), true);
  assert.equal(db.calls.length, 2);
});

test("isFeatureEnabled fails closed on error or non-true data", async () => {
  clearFeatureCache();
  assert.equal(
    await isFeatureEnabled(
      mockDb({ data: null, error: { message: "x" } }),
      "a",
    ),
    false,
  );
  assert.equal(
    await isFeatureEnabled(mockDb({ data: "true", error: null }), "b"),
    false,
  );
});

test("requireFeature passes when enabled", async () => {
  clearFeatureCache();
  await requireFeature(mockDb({ data: true, error: null }), "polls");
});

test("requireFeature returns 404 FEATURE_DISABLED when disabled", async () => {
  clearFeatureCache();
  const db = mockDb({ data: false, error: null });
  await assert.rejects(requireFeature(db, "polls"), (e: unknown) => {
    assert.ok(e instanceof HttpError);
    assert.equal(e.status, 404);
    assert.equal(e.code, "FEATURE_DISABLED");
    return true;
  });
  clearFeatureCache();
  try {
    await requireFeature(db, "polls");
  } catch (e) {
    const res = fail(e);
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), {
      code: "FEATURE_DISABLED",
      feature: "polls",
    });
  }
});
