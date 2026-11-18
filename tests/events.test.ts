import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import handler from "../netlify/functions/events-api.js";
import { eventCalendar } from "../netlify/functions/shared/event-calendar.js";
const E = "10000000-0000-4000-8000-000000000001",
  U = "20000000-0000-4000-8000-000000000001";
test("iCalendar escapes text, folds UTF-8 and preserves identity and UTC", () => {
  const e = {
    id: E,
    title: "長中文😀".repeat(40) + "\r\nBEGIN:VEVENT",
    description: "a,b;c\\d\ne",
    location: "台北",
    starts_at: "2026-12-01T00:30:00+08:00",
    ends_at: "2026-12-01T01:30:00+08:00",
    updated_at: "2026-11-18T00:00:00Z",
    status: "cancelled",
    sequence: 2,
  };
  const ics = eventCalendar(e);
  for (const line of ics.split("\r\n"))
    assert.ok(Buffer.byteLength(line) <= 75);
  const unfolded = ics.replace(/\r\n /g, "");
  assert.equal((unfolded.match(/\r\nBEGIN:VEVENT/g) || []).length, 1);
  assert.ok(unfolded.includes("DTSTART:20261130T163000Z"));
  assert.ok(unfolded.includes("STATUS:CANCELLED"));
  assert.ok(unfolded.includes("SEQUENCE:2"));
  assert.ok(unfolded.includes("a\\,b\\;c\\\\d\\ne"));
  assert.ok(unfolded.includes("UID:" + E + "@ntucc-meetup"));
});
test("public event API is allowlisted; verified external users can act only for themselves", async () => {
  let confirmed = true,
    anonymous = false,
    admin = false,
    tokenExists = true;
  const calls: { path: string; data: any; method: string }[] = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const data = raw ? JSON.parse(raw) : null,
      path = req.url!,
      url = new URL(path, "http://mock");
    calls.push({ path, data, method: req.method! });
    res.setHeader("content-type", "application/json");
    const send = (v: any, s = 200) => {
      res.statusCode = s;
      res.end(JSON.stringify(v));
    };
    const user = {
      id: U,
      email: "external@example.test",
      email_confirmed_at: confirmed ? "2026-01-01" : null,
      is_anonymous: anonymous,
    };
    if (path === "/auth/v1/user") return send(user);
    if (path === `/auth/v1/admin/users/${U}`) return send({ user });
    if (url.pathname === "/rest/v1/profiles")
      return send({
        id: U,
        role: admin ? "admin" : "member",
        passcode_verified: admin,
      });
    if (url.pathname === "/rest/v1/event_api_tokens")
      return send(
        tokenExists ? { user_id: U, expires_at: "2099-01-01", id: E } : null,
      );
    if (url.pathname === "/rest/v1/public_events")
      return send(url.searchParams.has("id") ? null : []);
    if (url.pathname === "/rest/v1/public_announcements") return send([]);
    if (url.pathname === "/rest/v1/event_registrations") return send(null);
    if (path === "/rest/v1/rpc/consume_quota") return send(true);
    if (path === "/rest/v1/rpc/register_public_event")
      return send({
        id: E,
        status: data.p_cancel ? "cancelled" : "registered",
      });
    send({ message: "unexpected mock call" }, 500);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const old = {
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
  };
  process.env.SUPABASE_URL = `http://127.0.0.1:${(server.address() as any).port}`;
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-key";
  const req = (path = "", method = "GET", token = "", data?: any) =>
    handler(
      new Request("https://example.test/api/v1/events" + path, {
        method,
        headers: token
          ? {
              Authorization: "Bearer " + token,
              "Content-Type": "application/json",
            }
          : {},
        ...(data === undefined ? {} : { body: JSON.stringify(data) }),
      }),
    );
  try {
    assert.equal((await req()).status, 200);
    for (const c of calls.filter((c) =>
      c.path.startsWith("/rest/v1/public_"),
    )) {
      assert.ok(c.path.includes("is_published=eq.true"));
      assert.ok(!c.path.includes("select=*"));
    }
    assert.equal((await req("/" + E)).status, 404);
    assert.equal((await req("/" + E + "/calendar")).status, 404);
    assert.equal(
      (await req("/" + E + "/registration", "POST", "", {})).status,
      401,
    );
    assert.equal(
      (await req("/" + E + "/registration", "POST", "ntucc_sk_old", {})).status,
      403,
    );
    assert.equal(
      (await req("/" + E + "/registration", "POST", "jwt", { user_id: E }))
        .status,
      400,
    );
    confirmed = false;
    assert.equal(
      (await req("/" + E + "/registration", "POST", "jwt", {})).status,
      403,
    );
    confirmed = true;
    anonymous = true;
    assert.equal(
      (await req("/" + E + "/registration", "POST", "jwt", {})).status,
      403,
    );
    anonymous = false;
    assert.equal(
      (await req("/" + E + "/registration", "POST", "jwt", {})).status,
      200,
    );
    const rpc = calls.find(
      (c) => c.path === "/rest/v1/rpc/register_public_event",
    )!;
    assert.equal(rpc.data.p_user, U);
    assert.equal(rpc.data.p_event, E);
    assert.equal(
      (await req("/" + E + "/registration", "DELETE", "jwt")).status,
      200,
    );
    assert.equal(
      (await req("/" + E + "/registration", "GET", "jwt")).status,
      200,
    );
    assert.ok(calls.some((c) => c.path.includes("user_id=eq." + U)));
    assert.equal((await req("/manage", "GET", "jwt")).status, 403);
    assert.equal(
      (await req("/tokens", "POST", "ntucc_event_secret", {})).status,
      403,
    );
    assert.equal((await req('/'+E+'/registration','POST','ntucc_event_valid',{})).status,200);
    tokenExists = false;
    assert.equal(
      (await req("/" + E + "/registration", "POST", "ntucc_event_revoked", {}))
        .status,
      401,
    );
    assert.ok(
      !calls.some((c) => c.method === "PATCH" && c.path.includes("profiles")),
    );
  } finally {
    Object.assign(process.env, old);
    for (const [k, v] of Object.entries(old))
      if (v === undefined) delete process.env[k];
    await new Promise<void>((r) => server.close(() => r()));
  }
});
