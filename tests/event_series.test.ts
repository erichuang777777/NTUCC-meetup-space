import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import handler from "../netlify/functions/event-series-api.js";
import { clearFeatureCache } from "../netlify/functions/shared/features.js";

const S = "10000000-0000-4000-8000-000000000001",
  U = "20000000-0000-4000-8000-000000000001";

test("event series API: feature gate, admin only, PII guard, RPC error mapping", async () => {
  let flag = true,
    admin = false,
    rpcError: string | null = null;
  const calls: { path: string; body: any }[] = [];
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
    calls.push({ path: url.pathname, body: data });
    const send = (v: any, s = 200) => {
      res.statusCode = s;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(v));
    };
    if (url.pathname === "/rest/v1/rpc/is_feature_enabled") return send(flag);
    if (url.pathname === "/auth/v1/user")
      return send({ id: U, email: "a@b.c" });
    if (url.pathname === "/rest/v1/profiles")
      return send({
        id: U,
        role: admin ? "admin" : "member",
        passcode_verified: true,
      });
    if (url.pathname === "/rest/v1/user_api_tokens")
      return send(
        req.method === "PATCH" ? [] : { id: S, user_id: U, scopes: [] },
      );
    if (url.pathname === "/rest/v1/pii_override_logs") return send(null, 201);
    if (url.pathname.startsWith("/rest/v1/rpc/"))
      return rpcError ? send({ message: rpcError }, 400) : send({ id: S });
    return send({ message: "Unexpected " + req.url }, 500);
  });
  await new Promise<void>((r) => backend.listen(0, "127.0.0.1", r));
  const old = {
    u: process.env.SUPABASE_URL,
    k: process.env.SUPABASE_SERVICE_ROLE_KEY,
  };
  process.env.SUPABASE_URL = `http://127.0.0.1:${(backend.address() as any).port}`;
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-only";
  const call = (suffix: string, method: string, body?: unknown) => {
    clearFeatureCache();
    return handler(
      new Request("https://example.test/api/v1/event-series" + suffix, {
        method,
        headers: {
          Authorization: "Bearer jwt",
          "Content-Type": "application/json",
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }),
    );
  };
  const rpcCalls = (name: string) =>
    calls.filter((c) => c.path === "/rest/v1/rpc/" + name);
  try {
    flag = false;
    let r = await call("", "POST", { title: "x" });
    assert.equal(r.status, 404);
    assert.equal((await r.json()).code, "FEATURE_DISABLED");
    assert.equal(rpcCalls("create_event_series").length, 0);
    flag = true;

    assert.equal((await call("", "POST", { title: "x" })).status, 403);
    admin = true;
    assert.equal((await call("", "GET")).status, 405);
    assert.equal(
      (await call("/not-a-uuid", "PUT", { title: "x" })).status,
      400,
    );
    assert.equal(
      (await call("", "POST", { title: "x", created_by: U })).status,
      400,
    );
    assert.equal(
      (await call("", "POST", { title: "x".repeat(81) })).status,
      400,
    );

    r = await call("", "POST", { title: "每月聚會", description: "說明" });
    assert.equal(r.status, 201);
    const sent = rpcCalls("create_event_series").at(-1)!.body;
    assert.equal(sent.p_actor, U);
    assert.equal(sent.p_title, "每月聚會");

    const pii = { title: "系列", description: "病歷號 12345678 的個案" };
    r = await call("", "POST", pii);
    assert.equal(r.status, 422);
    assert.equal((await r.json()).code, "PII_DETECTED");
    assert.equal(rpcCalls("create_event_series").length, 1);
    r = await call("", "POST", { ...pii, force_override: true });
    assert.equal(r.status, 201);

    r = await call("/" + S, "PUT", { title: "新名", archived: true });
    assert.equal(r.status, 200);
    assert.equal(rpcCalls("update_event_series").at(-1)!.body.p_archived, true);

    for (const [msg, status] of [
      ["SLUG_TAKEN", 409],
      ["SERIES_NOT_FOUND", 404],
      ["INVALID_SERIES", 400],
    ] as const) {
      rpcError = msg;
      r = await call("/" + S, "PUT", { title: "x" });
      assert.equal(r.status, status, msg);
      assert.equal((await r.json()).code, msg);
    }
    rpcError = "boom internal";
    r = await call("/" + S, "PUT", { title: "x" });
    assert.equal((await r.json()).code, "DATABASE_ERROR");
  } finally {
    backend.close();
    process.env.SUPABASE_URL = old.u;
    process.env.SUPABASE_SERVICE_ROLE_KEY = old.k;
  }
});
