import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import handler from "../netlify/functions/hosted-events-api.js";
import { clearFeatureCache } from "../netlify/functions/shared/features.js";

const R = "10000000-0000-4000-8000-000000000001",
  U = "20000000-0000-4000-8000-000000000001";

test("hosted events API: feature gate, auth, PII guard, actor binding and error mapping", async () => {
  let flag = true,
    verified = true,
    rpcError: string | null = null;
  const calls: { path: string; method: string; body: any }[] = [];
  const backend = createServer(async (req, res) => {
    let text = "";
    for await (const c of req) text += c;
    const url = new URL(req.url!, "http://mock");
    let data: any;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    calls.push({ path: req.url!, method: req.method!, body: data });
    const send = (v: any, s = 200) => {
      res.statusCode = s;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(v));
    };
    if (url.pathname === "/rest/v1/rpc/is_feature_enabled") return send(flag);
    if (url.pathname === "/auth/v1/user")
      return send({ id: U, email: "a@b.c" });
    if (url.pathname === "/rest/v1/profiles")
      return send({ id: U, role: "member", passcode_verified: verified });
    if (url.pathname === "/rest/v1/user_api_tokens")
      return send(
        req.method === "PATCH" ? [] : { id: R, user_id: U, scopes: [] },
      );
    if (url.pathname === "/rest/v1/pii_override_logs") return send(null, 201);
    if (url.pathname.startsWith("/rest/v1/rpc/"))
      return rpcError ? send({ message: rpcError }, 400) : send({ id: R });
    return send({ message: "Unexpected " + req.url }, 500);
  });
  await new Promise<void>((r) => backend.listen(0, "127.0.0.1", r));
  const old = {
    u: process.env.SUPABASE_URL,
    k: process.env.SUPABASE_SERVICE_ROLE_KEY,
  };
  process.env.SUPABASE_URL = `http://127.0.0.1:${(backend.address() as any).port}`;
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-only";
  const call = (
    suffix: string,
    method: string,
    body?: unknown,
    token = "jwt",
  ) => {
    clearFeatureCache();
    return handler(
      new Request("https://example.test/api/v1/hosted-events" + suffix, {
        method,
        headers: token
          ? {
              Authorization: "Bearer " + token,
              "Content-Type": "application/json",
            }
          : {},
        ...(body ? { body: JSON.stringify(body) } : {}),
      }),
    );
  };
  const rpcCalls = (name: string) =>
    calls.filter((c) => c.path === "/rest/v1/rpc/" + name);
  const draft = {
    title: "讀書會",
    description: "一起讀書",
    location: "會議室 A",
    starts_at: "2099-01-01T01:00:00Z",
    ends_at: "2099-01-01T03:00:00Z",
    capacity: 20,
  };
  try {
    // flag off: 404 before auth, nothing reaches the DB
    flag = false;
    let r = await call("", "POST", draft);
    assert.equal(r.status, 404);
    assert.equal((await r.json()).code, "FEATURE_DISABLED");
    assert.equal(rpcCalls("save_hosted_event_request").length, 0);
    flag = true;

    assert.equal((await call("", "POST", draft, "")).status, 401);
    assert.equal((await call("", "POST", draft, "ntucc_sk_x")).status, 403);
    assert.equal((await call("/not-a-uuid/submit", "POST", {})).status, 400);
    assert.equal((await call("", "GET")).status, 405);
    verified = false;
    assert.equal((await call("", "POST", draft)).status, 403);
    verified = true;

    // validation: strict body, lengths, date order
    assert.equal(
      (await call("", "POST", { ...draft, host_id: "x" })).status,
      400,
    );
    assert.equal(
      (await call("", "POST", { ...draft, title: "x".repeat(121) })).status,
      400,
    );
    assert.equal(
      (await call("", "POST", { ...draft, description: "x".repeat(3001) }))
        .status,
      400,
    );
    assert.equal(
      (await call("", "POST", { ...draft, location: "x".repeat(201) })).status,
      400,
    );
    assert.equal(
      (await call("", "POST", { ...draft, ends_at: draft.starts_at })).status,
      400,
    );
    assert.equal(rpcCalls("save_hosted_event_request").length, 0);

    // success: actor is the authenticated user
    r = await call("", "POST", draft);
    assert.equal(r.status, 201);
    const saved = rpcCalls("save_hosted_event_request").at(-1)!.body;
    assert.equal(saved.p_actor, U);
    assert.equal(saved.p_id, null);
    assert.equal(saved.p_capacity, 20);
    r = await call("", "POST", { ...draft, id: R });
    assert.equal(r.status, 200);

    // PII: 422 unless forced; forced is logged
    const pii = { ...draft, description: "請打 0912-345-678 聯絡" };
    r = await call("", "POST", pii);
    assert.equal(r.status, 422);
    assert.equal((await r.json()).code, "PII_DETECTED");
    const n = rpcCalls("save_hosted_event_request").length;
    r = await call("", "POST", { ...pii, force_override: true });
    assert.equal(r.status, 201);
    assert.equal(rpcCalls("save_hosted_event_request").length, n + 1);
    assert.equal(
      calls.filter((c) => c.path.startsWith("/rest/v1/pii_override_logs"))
        .length,
      1,
    );

    // submit / cancel / registrations / review / revoke map to RPCs with the actor
    r = await call(`/${R}/submit`, "POST", {});
    assert.equal(r.status, 200);
    assert.deepEqual(rpcCalls("submit_hosted_event_request").at(-1)!.body, {
      p_actor: U,
      p_id: R,
    });
    assert.equal((await call(`/${R}/cancel`, "POST", {})).status, 200);
    assert.equal((await call(`/${R}/submit`, "GET")).status, 405);
    assert.equal((await call(`/${R}/registrations?page=2`, "GET")).status, 200);
    assert.equal(rpcCalls("hosted_event_registrations").at(-1)!.body.p_page, 2);
    assert.equal((await call(`/${R}/registrations`, "POST", {})).status, 405);
    assert.equal(
      (await call(`/${R}/review`, "POST", { decision: "approve" })).status,
      200,
    );
    const rv = rpcCalls("review_hosted_event").at(-1)!.body;
    assert.equal(rv.p_actor, U);
    assert.equal(rv.p_decision, "approve");
    assert.equal(rv.p_publish, false);
    assert.equal(rv.p_public, false);
    assert.equal(
      (await call(`/${R}/review`, "POST", { decision: "delete" })).status,
      400,
    );
    r = await call(`/${R}/review`, "POST", {
      decision: "return",
      note: "請聯絡 0912-345-678",
    });
    assert.equal(r.status, 422);
    assert.equal(
      (await call(`/${R}/revoke`, "POST", { note: "違規" })).status,
      200,
    );
    assert.equal(rpcCalls("revoke_hosted_event").at(-1)!.body.p_actor, U);
    assert.equal((await call(`/${R}/unknown`, "POST", {})).status, 404);

    // RPC errors map to stable codes (admin/host checks live in the DB)
    for (const [msg, status] of [
      ["ADMIN_REQUIRED", 403],
      ["MEMBER_REQUIRED", 403],
      ["REQUEST_NOT_FOUND", 404],
      ["REQUEST_LOCKED", 409],
      ["INVALID_STATE", 409],
      ["EVENT_IN_PAST", 409],
      ["RATE_LIMITED", 429],
      ["INVALID_REQUEST", 400],
    ] as const) {
      rpcError = msg;
      r = await call(`/${R}/submit`, "POST", {});
      assert.equal(r.status, status, msg);
      assert.equal((await r.json()).code, msg);
    }
    rpcError = "boom internal detail";
    r = await call(`/${R}/submit`, "POST", {});
    assert.equal(r.status, 400);
    assert.equal((await r.json()).code, "DATABASE_ERROR");
    rpcError = null;
  } finally {
    backend.close();
    process.env.SUPABASE_URL = old.u;
    process.env.SUPABASE_SERVICE_ROLE_KEY = old.k;
  }
});
