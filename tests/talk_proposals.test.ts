import test from "node:test";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import handler from "../netlify/functions/talk-proposals-api.js";
import { clearFeatureCache } from "../netlify/functions/shared/features.js";

const P = "10000000-0000-4000-8000-000000000001",
  U = "20000000-0000-4000-8000-000000000001",
  EV = "30000000-0000-4000-8000-000000000001",
  PAIN = "40000000-0000-4000-8000-000000000001";

test("talk proposals API: feature gate, auth, PII guard, RPC mapping", async () => {
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
        req.method === "PATCH" ? [] : { id: P, user_id: U, scopes: [] },
      );
    if (url.pathname === "/rest/v1/pii_override_logs") return send(null, 201);
    if (url.pathname.startsWith("/rest/v1/rpc/") && rpcError)
      return send({ message: rpcError }, 400);
    if (url.pathname === "/rest/v1/rpc/upsert_talk_proposal")
      return send({ id: P, status: "draft" });
    if (url.pathname === "/rest/v1/rpc/submit_talk_proposal")
      return send({ id: P, status: "submitted" });
    if (url.pathname === "/rest/v1/rpc/withdraw_talk_proposal")
      return send({ id: P, status: "withdrawn" });
    return send({ message: "Unexpected " + req.url }, 500);
  });
  await new Promise<void>((r) => backend.listen(0, "127.0.0.1", r));
  process.env.SUPABASE_URL = `http://127.0.0.1:${(backend.address() as any).port}`;
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-only";
  const call = (
    suffix: string,
    method: string,
    payload?: unknown,
    token = "jwt",
  ) => {
    clearFeatureCache();
    return handler(
      new Request("https://example.test/api/v1/talk-proposals" + suffix, {
        method,
        headers: token
          ? {
              Authorization: "Bearer " + token,
              "Content-Type": "application/json",
            }
          : {},
        ...(payload ? { body: JSON.stringify(payload) } : {}),
      }),
    );
  };
  const rpcCalls = (name: string) =>
    calls.filter((c) => c.path === "/rest/v1/rpc/" + name);
  const piiLogs = () =>
    calls.filter((c) => c.path.startsWith("/rest/v1/pii_override_logs")).length;
  const proposal = {
    title: "AI 寫交班摘要",
    abstract: "我們做了一個小工具，分享做法與踩過的坑。",
    category_tag: "實戰展示",
    duration_minutes: 10,
    preferred_event_id: EV,
    pain_point_id: PAIN,
  };
  try {
    // flag off: 404 before auth, nothing reaches the DB
    flag = false;
    let r = await call("", "POST", proposal);
    assert.equal(r.status, 404);
    assert.equal((await r.json()).code, "FEATURE_DISABLED");
    assert.equal(rpcCalls("upsert_talk_proposal").length, 0);
    flag = true;

    assert.equal((await call("", "POST", proposal, "")).status, 401);
    assert.equal((await call("", "POST", proposal, "ntucc_sk_x")).status, 403);
    assert.equal((await call("/not-a-uuid", "PUT", proposal)).status, 400);
    assert.equal((await call("", "GET")).status, 405);
    assert.equal((await call("/" + P, "POST", proposal)).status, 405);
    assert.equal((await call("/" + P + "/bogus", "POST", {})).status, 404);
    verified = false;
    assert.equal((await call("", "POST", proposal)).status, 403);
    verified = true;

    // strict validation
    for (const bad of [
      { ...proposal, proposer_id: U },
      { ...proposal, status: "accepted" },
      { ...proposal, title: "" },
      { ...proposal, title: "字".repeat(121) },
      { ...proposal, abstract: "字".repeat(1501) },
      { ...proposal, category_tag: "其他" },
      { ...proposal, duration_minutes: 7 },
      { ...proposal, pain_point_id: "nope" },
    ])
      assert.equal((await call("", "POST", bad)).status, 400);
    assert.equal(rpcCalls("upsert_talk_proposal").length, 0);

    // create: actor comes from the token, never the body
    r = await call("", "POST", proposal);
    assert.equal(r.status, 201);
    let sent = rpcCalls("upsert_talk_proposal").at(-1)!.body;
    assert.equal(sent.p_actor, U);
    assert.equal(sent.p_id, null);
    assert.equal(sent.p_pain, PAIN);
    assert.equal(sent.p_duration, 10);
    assert.equal(rpcCalls("submit_talk_proposal").length, 0);

    // update + submit in one call
    r = await call("/" + P, "PUT", { ...proposal, submit: true });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).status, "submitted");
    sent = rpcCalls("upsert_talk_proposal").at(-1)!.body;
    assert.equal(sent.p_id, P);
    assert.equal(rpcCalls("submit_talk_proposal").at(-1)!.body.p_actor, U);

    // submit / withdraw actions
    r = await call("/" + P + "/submit", "POST", {});
    assert.equal(r.status, 200);
    r = await call("/" + P + "/withdraw", "POST");
    assert.equal(r.status, 200);
    assert.equal((await r.json()).status, "withdrawn");
    assert.equal(rpcCalls("withdraw_talk_proposal").at(-1)!.body.p_id, P);
    assert.equal((await call("/" + P + "/submit", "GET")).status, 405);

    // PII in title/abstract: 422 unless forced; forced is logged
    const pii = { ...proposal, abstract: "病歷號 12345678 的個案經驗" };
    const before = rpcCalls("upsert_talk_proposal").length;
    r = await call("", "POST", pii);
    assert.equal(r.status, 422);
    assert.equal((await r.json()).code, "PII_DETECTED");
    assert.equal(rpcCalls("upsert_talk_proposal").length, before);
    assert.equal(piiLogs(), 0);
    r = await call("", "POST", { ...pii, force_override: true });
    assert.equal(r.status, 201);
    assert.equal(piiLogs(), 1);

    // RPC errors map to stable codes
    for (const [msg, status] of [
      ["NOT_EDITABLE", 409],
      ["INVALID_TRANSITION", 409],
      ["PROPOSAL_NOT_FOUND", 404],
      ["PAIN_POINT_NOT_FOUND", 404],
      ["EVENT_NOT_FOUND", 404],
      ["MEMBER_REQUIRED", 403],
      ["INVALID_PROPOSAL", 400],
    ] as const) {
      rpcError = msg;
      r = await call("/" + P, "PUT", proposal);
      assert.equal(r.status, status, msg);
      assert.equal((await r.json()).code, msg);
    }
    rpcError = "boom internal detail";
    r = await call("/" + P + "/withdraw", "POST");
    assert.equal(r.status, 400);
    assert.equal((await r.json()).code, "DATABASE_ERROR");
    rpcError = null;

    assert.match(
      readFileSync("public/features/notifications.ts", "utf8"),
      /type: "talk_proposal_reviewed"/,
    );
  } finally {
    await new Promise((r) => backend.close(r));
  }
});
