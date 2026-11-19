import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import handler from "../netlify/functions/event-feedback-api.js";
import { clearFeatureCache } from "../netlify/functions/shared/features.js";

const E = "10000000-0000-4000-8000-000000000001",
  U = "20000000-0000-4000-8000-000000000001";

test("event feedback API: feature gate, auth, PII guard and RPC error mapping", async () => {
  let flag = true,
    admin = false,
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
      return send({
        id: U,
        role: admin ? "admin" : "member",
        passcode_verified: verified,
      });
    if (url.pathname === "/rest/v1/user_api_tokens")
      return send(
        req.method === "PATCH" ? [] : { id: E, user_id: U, scopes: [] },
      );
    if (url.pathname === "/rest/v1/pii_override_logs") return send(null, 201);
    if (url.pathname === "/rest/v1/rpc/submit_event_feedback")
      return rpcError ? send({ message: rpcError }, 400) : send({ id: E });
    if (url.pathname === "/rest/v1/rpc/upsert_event_feedback_form")
      return rpcError ? send({ message: rpcError }, 400) : send({ id: E });
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
      new Request("https://example.test/api/v1/event-feedback/" + suffix, {
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
  const submit = { answers: { overall: 5, note: "很好" } };
  const form = {
    questions: [
      { id: "overall", type: "rating", label: "整體滿意度", required: true },
      { id: "note", type: "text", label: "建議" },
    ],
    closes_at: "2099-01-01T00:00:00Z",
    is_anonymous: true,
  };
  try {
    // flag off: 404 before auth, nothing reaches the DB
    flag = false;
    let r = await call(E, "POST", submit);
    assert.equal(r.status, 404);
    assert.equal((await r.json()).code, "FEATURE_DISABLED");
    assert.equal(rpcCalls("submit_event_feedback").length, 0);
    flag = true;

    assert.equal((await call(E, "POST", submit, "")).status, 401);
    assert.equal((await call(E, "POST", submit, "ntucc_sk_x")).status, 403);
    assert.equal((await call("not-a-uuid", "POST", submit)).status, 400);
    assert.equal((await call(E, "GET")).status, 405);
    verified = false;
    assert.equal((await call(E, "POST", submit)).status, 403);
    verified = true;

    // strict body validation
    assert.equal(
      (await call(E, "POST", { ...submit, respondent: "x" })).status,
      400,
    );
    assert.equal(
      (await call(E, "POST", { answers: { a: { b: 1 } } })).status,
      400,
    );

    // success: uses authenticated user id, never a client-supplied one
    r = await call(E, "POST", submit);
    assert.equal(r.status, 201);
    const sent = rpcCalls("submit_event_feedback").at(-1)!.body;
    assert.equal(sent.p_user, U);
    assert.equal(sent.p_event, E);
    assert.deepEqual(sent.p_answers, submit.answers);

    // PII in a text answer: 422 unless forced; forced is logged
    const pii = { answers: { overall: 4, note: "病歷號 12345678 的個案" } };
    r = await call(E, "POST", pii);
    assert.equal(r.status, 422);
    assert.equal((await r.json()).code, "PII_DETECTED");
    const before = rpcCalls("submit_event_feedback").length;
    assert.equal(before, 1);
    assert.equal(
      calls.filter((c) => c.path.startsWith("/rest/v1/pii_override_logs"))
        .length,
      0,
    );
    r = await call(E, "POST", { ...pii, force_override: true });
    assert.equal(r.status, 201);
    assert.equal(
      calls.filter((c) => c.path.startsWith("/rest/v1/pii_override_logs"))
        .length,
      1,
    );

    // RPC errors map to stable codes
    for (const [msg, status] of [
      ["NOT_ELIGIBLE", 403],
      ["ALREADY_SUBMITTED", 409],
      ["FEEDBACK_CLOSED", 409],
      ["FEEDBACK_NOT_OPEN", 409],
      ["INVALID_ANSWERS", 400],
      ["FEEDBACK_UNAVAILABLE", 404],
    ] as const) {
      rpcError = msg;
      r = await call(E, "POST", submit);
      assert.equal(r.status, status, msg);
      assert.equal((await r.json()).code, msg);
    }
    rpcError = "boom internal detail";
    r = await call(E, "POST", submit);
    assert.equal(r.status, 400);
    assert.equal((await r.json()).code, "DATABASE_ERROR");
    rpcError = null;

    // form management: admin only, PII guarded on labels/options
    assert.equal((await call(E + "/form", "PUT", form)).status, 403);
    assert.equal((await call(E + "/form", "POST", form)).status, 405);
    admin = true;
    r = await call(E + "/form", "PUT", form);
    assert.equal(r.status, 200);
    const up = rpcCalls("upsert_event_feedback_form").at(-1)!.body;
    assert.equal(up.p_actor, U);
    assert.equal(up.p_anonymous, true);
    assert.equal(up.p_opens, null);
    r = await call(E + "/form", "PUT", {
      ...form,
      questions: [
        { id: "q", type: "text", label: "請問 09 12 345 678? 0912-345-678" },
      ],
    });
    assert.equal(r.status, 422);
    assert.equal(
      (await call(E + "/form", "PUT", { ...form, questions: [] })).status,
      400,
    );
    assert.equal(
      (
        await call(E + "/form", "PUT", {
          ...form,
          questions: Array.from({ length: 16 }, (_, i) => ({
            id: "q" + i,
            type: "text",
            label: "x",
          })),
        })
      ).status,
      400,
    );
    rpcError = "FORM_LOCKED";
    assert.equal((await call(E + "/form", "PUT", form)).status, 409);
  } finally {
    process.env.SUPABASE_URL = old.u;
    process.env.SUPABASE_SERVICE_ROLE_KEY = old.k;
    clearFeatureCache();
    await new Promise((r) => backend.close(r));
  }
});
