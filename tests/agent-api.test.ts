import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import api from "../netlify/functions/agent-api.js";
import oldApi from "../netlify/functions/spaces-api.js";
import mcp from "../netlify/functions/mcp.js";
const U = "00000000-0000-4000-8000-000000000001",
  R = "00000000-0000-4000-8000-000000000002",
  A = "00000000-0000-4000-8000-000000000003",
  P = "10000000-0000-4000-8000-000000000001",
  T = "20000000-0000-4000-8000-000000000001",
  C = "30000000-0000-4000-8000-000000000001",
  OTHER = "30000000-0000-4000-8000-000000000002";
test("Agent endpoints and MCP protect private data, token scopes and sender identity", async () => {
  const calls: { path: string; data: any; method: string }[] = [];
  let scopes = [
      "projects:read",
      "projects:write",
      "discussions:read",
      "discussions:write",
    ],
    revoked = false,
    privateProject = false,
    role = "member";
  const server = createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    const path = req.url ?? "",
      url = new URL(path, "http://mock"),
      data = text ? JSON.parse(text) : null;
    calls.push({ path, data, method: req.method! });
    res.setHeader("content-type", "application/json");
    res.setHeader("content-range", "0-0/1");
    const respond = (value: any, status = 200) => {
      res.statusCode = status;
      res.end(JSON.stringify(value));
    };
    if (path === "/auth/v1/user")
      return respond({ id: U, aud: "authenticated" });
    if (url.pathname === "/rest/v1/user_api_tokens") {
      if (req.method === "GET")
        return respond(
          revoked ? null : { id: "test-token", user_id: U, scopes },
        );
      return respond({}, 201);
    }
    if (url.pathname === "/rest/v1/profiles") {
      if (url.searchParams.get("select")?.includes("role"))
        return respond({ id: U, role, passcode_verified: true });
      return respond({
        id: R,
        display_name: "Colleague",
        department: "Test department",
        accepts_messages: true,
        email: "must-not-leak@example.test",
      });
    }
    if (url.pathname === "/rest/v1/spaces")
      return respond({
        id: P,
        owner_id: R,
        visibility: privateProject ? "private" : "public",
        title: "Project",
        summary: "Introduction",
      });
    if (url.pathname === "/rest/v1/discussion_threads_read")
      return respond({
        id: T,
        space_id: P,
        title: "Thread",
        body: "Private thread body",
      });
    if (url.pathname === "/rest/v1/discussion_replies_read")
      return respond([{ id: "reply", thread_id: T, body: "Reply" }]);
    if (url.pathname === "/rest/v1/private_conversations") {
      const c = {
        id: C,
        member_low: U,
        member_high: R,
        last_message_at: new Date().toISOString(),
        low: { id: U, display_name: "Sender", department: "Test" },
        high: {
          id: R,
          display_name: "Colleague",
          department: "Test",
          email: "must-not-leak@example.test",
        },
      };
      if (url.searchParams.get("id") === "eq." + OTHER)
        return respond({ ...c, id: OTHER, member_low: R, member_high: A });
      return respond(url.searchParams.has("id") ? c : [c]);
    }
    if (url.pathname === "/rest/v1/private_messages")
      return respond([
        { id: "message", conversation_id: C, sender_id: R, body: "Hello" },
      ]);
    if (url.pathname === "/rest/v1/pii_override_logs") return respond({}, 201);
    if (url.pathname === "/rest/v1/rpc/send_private_message")
      return respond({
        conversation_id: C,
        message_id: "message",
        duplicate: false,
      });
    respond({}, 404);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port,
    oldURL = process.env.SUPABASE_URL,
    oldKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.SUPABASE_URL = `http://127.0.0.1:${port}`;
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service";
  const request = (
    path: string,
    method = "GET",
    body?: any,
    token = "ntucc_sk_test",
  ) =>
    api(
      new Request("http://local/api/v1/agent/" + path, {
        method,
        headers: {
          authorization: "Bearer " + token,
          "content-type": "application/json",
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }),
    );
  try {
    assert.equal(
      (await api(new Request("http://local/api/v1/agent/projects"))).status,
      401,
    );
    assert.equal(calls.length, 0);
    assert.equal((await request("inbox")).status, 403);
    assert.ok(
      !calls.some((c) => c.path.startsWith("/rest/v1/private_conversations")),
    );
    const minted = await oldApi(
      new Request("http://local/api/v1/spaces", {
        method: "POST",
        headers: {
          authorization: "Bearer ntucc_sk_test",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          action: "token_create",
          payload: { include_messages: true },
        }),
      }),
    );
    assert.equal(minted.status, 403);
    assert.ok(
      !calls.some(
        (c) =>
          c.path.startsWith("/rest/v1/user_api_tokens") && c.method === "POST",
      ),
    );
    const profile = await request("members/" + R);
    assert.equal(profile.status, 200);
    assert.equal((await profile.json()).email, undefined);
    privateProject = true;
    assert.equal((await request("projects/" + P)).status, 404);
    const discussion = await request("discussions/" + T);
    assert.equal(discussion.status, 404);
    assert.ok(!(await discussion.text()).includes("Private thread body"));
    privateProject = false;
    const m = await mcp(
      new Request("http://local/api/mcp", {
        method: "POST",
        headers: {
          authorization: "Bearer ntucc_sk_test",
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "send_private_message",
            arguments: { recipient_id: R, body: "Hello" },
          },
        }),
      }),
    );
    assert.equal(m.status, 200);
    const result = (await m.json()).result;
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /TOKEN_SCOPE_REQUIRED/);
    scopes.push("messages:read", "messages:write");
    const inbox = await request("inbox");
    assert.equal(inbox.status, 200);
    const inboxData = await inbox.json();
    assert.equal(inboxData.conversations[0].other.id, R);
    assert.equal(inboxData.conversations[0].other.email, undefined);
    assert.ok(
      calls.some(
        (c) =>
          c.path.includes(encodeURIComponent("member_low.eq." + U)) ||
          c.path.includes("member_low.eq." + U),
      ),
    );
    role = "admin";
    let messageReads = calls.filter((c) =>
      c.path.startsWith("/rest/v1/private_messages"),
    ).length;
    assert.equal((await request("inbox/" + OTHER)).status, 404);
    assert.equal(
      calls.filter((c) => c.path.startsWith("/rest/v1/private_messages"))
        .length,
      messageReads,
    );
    role = "member";
    assert.equal((await request("inbox/" + C)).status, 200);
    const before = calls.filter((c) =>
      c.path.includes("rpc/send_private_message"),
    ).length;
    assert.equal(
      (
        await request("messages", "POST", {
          recipient_id: R,
          body: "MRN: 12345678",
        })
      ).status,
      422,
    );
    assert.equal(
      calls.filter((c) => c.path.includes("rpc/send_private_message")).length,
      before,
    );
    assert.equal(
      (
        await request("messages", "POST", {
          recipient_id: R,
          sender_id: R,
          body: "Hello",
        })
      ).status,
      400,
    );
    const sent = await request("messages", "POST", {
      recipient_id: R,
      body: "MRN: 12345678",
      force_override: true,
      client_request_id: "40000000-0000-4000-8000-000000000001",
    });
    assert.equal(sent.status, 201);
    const sendCall = calls.find((c) =>
      c.path.includes("rpc/send_private_message"),
    );
    assert.equal(sendCall?.data.p_sender, U);
    assert.equal(sendCall?.data.p_recipient, R);
    const log = calls.find((c) =>
      c.path.startsWith("/rest/v1/pii_override_logs"),
    );
    assert.equal(log?.data.source_channel, "rest_api");
    assert.ok(!JSON.stringify(log?.data).includes("12345678"));
    revoked = true;
    assert.equal((await request("projects")).status, 401);
  } finally {
    if (oldURL === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = oldURL;
    if (oldKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = oldKey;
    await new Promise<void>((r, j) =>
      server.close((err) => (err ? j(err) : r())),
    );
  }
});
