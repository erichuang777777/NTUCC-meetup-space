import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { discussionAction } from "../netlify/functions/shared/discussions.js";
import { HttpError } from "../netlify/functions/shared/http.js";
import { spaceSchema } from "../netlify/functions/shared/spaces.js";
const user = "00000000-0000-4000-8000-000000000001",
  other = "00000000-0000-4000-8000-000000000002",
  space = "10000000-0000-4000-8000-000000000001",
  thread = "20000000-0000-4000-8000-000000000001";
test("forum writes enforce PII, authorship, public-space access and moderation boundaries", async () => {
  const calls: { path: string; method: string; data: any }[] = [];
  let isPublic = true,
    hidden = false;
  const server = createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    const path = req.url ?? "",
      data = text ? JSON.parse(text) : null;
    calls.push({ path, method: req.method!, data });
    res.setHeader("content-type", "application/json");
    if (path.startsWith("/rest/v1/spaces"))
      res.end(JSON.stringify(isPublic ? { id: space, owner_id: other } : null));
    else if (
      path.startsWith("/rest/v1/discussion_threads") &&
      req.method === "GET"
    )
      res.end(
        JSON.stringify({ id: thread, space_id: space, is_hidden: hidden }),
      );
    else if (path === "/rest/v1/rpc/consume_quota") res.end("true");
    else if (path.startsWith("/rest/v1/pii_override_logs")) {
      res.statusCode = 201;
      res.end("{}");
    } else if (
      path.startsWith("/rest/v1/discussion_threads") &&
      (req.method === "POST" || req.method === "PATCH")
    ) {
      res.statusCode = req.method === "POST" ? 201 : 200;
      res.end(JSON.stringify({ id: thread }));
    } else if (
      path.startsWith("/rest/v1/discussion_replies") &&
      req.method === "PATCH"
    )
      res.end("null");
    else if (
      path.startsWith("/rest/v1/discussion_replies") &&
      req.method === "POST"
    ) {
      res.statusCode = 201;
      res.end(JSON.stringify({ id: "reply" }));
    } else {
      res.statusCode = 404;
      res.end("{}");
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const oldURL = process.env.SUPABASE_URL,
    oldKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.SUPABASE_URL = `http://127.0.0.1:${port}`;
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";
  const actor = { id: user, role: "member", passcode_verified: true },
    payload = {
      space_id: space,
      title: "Test",
      body: "MRN: 12345678",
      kind: "question",
    };
  const blocked = (status: number) => (err: unknown) =>
    err instanceof HttpError && err.status === status;
  try {
    await assert.rejects(
      () => discussionAction("thread_create", payload, false, actor, "web_ui"),
      blocked(422),
    );
    assert.ok(!calls.some((c) => c.method === "POST"));
    await discussionAction(
      "thread_create",
      { ...payload, author_id: other },
      true,
      actor,
      "web_ui",
    );
    const insertion = calls.find(
      (c) =>
        c.path.startsWith("/rest/v1/discussion_threads") && c.method === "POST",
    );
    assert.equal(insertion?.data.author_id, user);
    const log = calls.find((c) =>
      c.path.startsWith("/rest/v1/pii_override_logs"),
    );
    assert.deepEqual(log?.data.matched_types, ["病歷號"]);
    assert.ok(!JSON.stringify(log?.data).includes("12345678"));
    await assert.rejects(
      () =>
        discussionAction(
          "thread_moderate",
          { thread_id: thread, operation: "pin", value: true },
          false,
          actor,
          "web_ui",
        ),
      blocked(403),
    );
    await discussionAction(
      "thread_moderate",
      { thread_id: thread, operation: "pin", value: true },
      false,
      { ...actor, role: "admin" },
      "web_ui",
    );
    await assert.rejects(
      () =>
        discussionAction(
          "thread_moderate",
          {
            thread_id: thread,
            operation: "hide_reply",
            reply_id: "30000000-0000-4000-8000-000000000001",
            value: true,
          },
          false,
          { ...actor, role: "admin" },
          "web_ui",
        ),
      blocked(404),
    );
    assert.ok(calls.some((c) => c.path.includes("thread_id=eq." + thread)));
    isPublic = false;
    await assert.rejects(
      () =>
        discussionAction(
          "thread_reply",
          { thread_id: thread, body: "Test" },
          false,
          actor,
          "web_ui",
        ),
      blocked(404),
    );
    await assert.rejects(
      () =>
        discussionAction(
          "thread_moderate",
          { thread_id: thread, operation: "pin", value: true },
          false,
          { ...actor, role: "admin" },
          "web_ui",
        ),
      blocked(404),
    );
    isPublic = true;
    hidden = true;
    await assert.rejects(
      () =>
        discussionAction(
          "thread_reply",
          { thread_id: thread, body: "Test" },
          false,
          actor,
          "web_ui",
        ),
      blocked(404),
    );
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
test("project covers reject external URLs, SVG, executable schemes and oversized payloads", () => {
  const input = { title: "Cover", summary: "Summary" };
  for (const cover_image of [
    "https://example.org/a.png",
    "javascript:alert(1)",
    "data:image/svg+xml;base64,PHN2Zz4=",
    "data:image/png;base64," + "A".repeat(220000),
  ])
    assert.equal(
      spaceSchema.safeParse({ ...input, cover_image }).success,
      false,
    );
  assert.ok(
    spaceSchema.safeParse({
      ...input,
      cover_image: "data:image/jpeg;base64,YQ==",
    }).success,
  );
  assert.ok(spaceSchema.safeParse({ ...input, cover_image: null }).success);
});
