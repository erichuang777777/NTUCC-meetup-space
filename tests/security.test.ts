import test from "node:test";
import assert from "node:assert/strict";
import { detectPII, maskValue, scanValue } from "../public/pii.js";
import { slideCount, spaceSchema } from "../netlify/functions/shared/spaces.js";
import { hashToken } from "../netlify/functions/shared/auth-helper.js";
import api from "../netlify/functions/spaces-api.js";
import mcp from "../netlify/functions/mcp.js";
import chat from "../netlify/functions/chat.js";
test("PII rules detect contextual medical identifiers and preserve dates/URL numbers", () => {
  const found = detectPII(
    "A123456789 病歷號：12345678 病人王小明 12A-03 ICU-02 0912-345-678",
  );
  for (const type of ["身分證字號", "病歷號", "姓名", "床號", "手機號碼"])
    assert.ok(
      found.some((v) => v.type === type),
      type,
    );
  assert.equal(
    detectPII("20261116 https://example.org/12345678 2026-11-16").length,
    0,
  );
});
test("nested content gets masked without mutating originals", () => {
  const v = {
    reference_links: [{ title: "MRN: 12345678" }],
    html: "0912345678",
  };
  assert.equal(scanValue(v).length, 2);
  assert.equal(scanValue(maskValue(v)).length, 0);
  assert.equal(v.html, "0912345678");
});
test("HTML parser counts real slides, ignores comments and scripts", () => {
  assert.equal(
    slideCount(
      '<!-- <section class="slide"> --><script>"<section class=slide>"</script><section class="slide x"></section><div data-slide></div>',
    ),
    2,
  );
  assert.equal(slideCount('<section class="slideshow"></section>'), 0);
});
test("references reject executable and insecure schemes", () => {
  const base = { title: "Test", summary: "Summary" };
  for (const url of [
    "javascript:alert(1)",
    "http://example.org",
    "data:text/html,abc",
  ])
    assert.equal(
      spaceSchema.safeParse({
        ...base,
        reference_links: [{ label: "工具官網", title: "Test", url }],
      }).success,
      false,
    );
  assert.ok(
    spaceSchema.safeParse({
      ...base,
      reference_links: [
        { label: "工具官網", title: "Test", url: "https://example.org" },
      ],
    }).success,
  );
});
test("token digest is stable SHA-256 and never equals plaintext", () => {
  const digest = hashToken("ntucc_sk_test");
  assert.equal(digest.length, 64);
  assert.equal(digest, hashToken("ntucc_sk_test"));
  assert.notEqual(digest, hashToken("ntucc_sk_other"));
});
test("write endpoints fail closed without auth", async () => {
  for (const handler of [api, chat]) {
    const response = await handler(
      new Request("http://localhost/api/v1/spaces", {
        method: "POST",
        body: "{}",
      }),
    );
    assert.equal(response.status, 401);
  }
});
test("MCP rejects GET, foreign origins, and unauthenticated data requests", async () => {
  assert.equal(
    (await mcp(new Request("http://localhost/api/mcp"))).status,
    405,
  );
  assert.equal(
    (
      await mcp(
        new Request("http://localhost/api/mcp", {
          method: "POST",
          headers: { origin: "https://foreign.example" },
        }),
      )
    ).status,
    403,
  );
  for (let i = 0; i < 2; i++) {
    const response = await mcp(
      new Request("http://localhost/api/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-11-25",
            capabilities: {},
            clientInfo: { name: "test", version: "1" },
          },
        }),
      }),
    );
    assert.equal(response.status, 401);
  }
});

test("REST guard blocks PII before writes and audits overrides without storing raw matches", async () => {
  const { createServer } = await import("node:http");
  const calls: { path: string; payload: any }[] = [];
  const server = createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    const path = req.url ?? "";
    calls.push({ path, payload: text ? JSON.parse(text) : null });
    res.setHeader("content-type", "application/json");
    if (path === "/auth/v1/user")
      res.end(
        JSON.stringify({
          id: "00000000-0000-4000-8000-000000000001",
          aud: "authenticated",
        }),
      );
    else if (path.startsWith("/rest/v1/profiles"))
      res.end(
        JSON.stringify({
          id: "00000000-0000-4000-8000-000000000001",
          role: "member",
          passcode_verified: true,
        }),
      );
    else if (path === "/rest/v1/rpc/save_space")
      res.end(JSON.stringify("10000000-0000-4000-8000-000000000001"));
    else if (path === "/rest/v1/pii_override_logs") {
      res.statusCode = 201;
      res.end("{}");
    } else {
      res.statusCode = 404;
      res.end("{}");
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address() as { port: number };
  const oldURL = process.env.SUPABASE_URL,
    oldKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.SUPABASE_URL = `http://127.0.0.1:${address.port}`;
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";
  const request = (data: any) =>
    api(
      new Request("http://localhost/api/v1/spaces", {
        method: "POST",
        headers: {
          authorization: "Bearer test-jwt",
          "content-type": "application/json",
        },
        body: JSON.stringify(data),
      }),
    );
  try {
    for (const path of [
      "/api/v1/spaces",
      "/api/v1/spaces/10000000-0000-4000-8000-000000000001/slides",
    ]) {
      assert.equal(
        (await api(new Request("http://localhost" + path))).status,
        401,
      );
    }
    assert.equal(
      calls.length,
      0,
      "anonymous reads must fail before contacting the database",
    );
    for (let i = 0; i < 2; i++) {
      const response = await mcp(
        new Request("http://localhost/api/mcp", {
          method: "POST",
          headers: {
            authorization: "Bearer test-jwt",
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
              protocolVersion: "2025-11-25",
              capabilities: {},
              clientInfo: { name: "test", version: "1" },
            },
          }),
        }),
      );
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("mcp-session-id"), null);
      assert.equal(
        (await response.json()).result.serverInfo.name,
        "ntucc-meetup-spaces",
      );
    }
    const payload = { title: "MRN: 12345678", summary: "Test summary" };
    const blocked = await request(payload);
    assert.equal(blocked.status, 422);
    assert.equal((await blocked.json()).code, "PII_DETECTED");
    assert.ok(
      !calls.some(
        (c) =>
          c.path.includes("save_space") || c.path.includes("pii_override_logs"),
      ),
    );
    const allowed = await request({ ...payload, force_override: true });
    assert.equal(allowed.status, 200);
    const log = calls.find((c) => c.path === "/rest/v1/pii_override_logs");
    assert.ok(log);
    assert.deepEqual(log.payload.matched_types, ["病歷號"]);
    assert.ok(!JSON.stringify(log.payload).includes("12345678"));
    const invalid = await request({
      title: "safe",
      summary: "safe",
      html_slides: '<section class="slide">one</section>',
    });
    assert.equal(invalid.status, 422);
    assert.equal((await invalid.json()).code, "SLIDE_COUNT_INVALID");
  } finally {
    process.env.SUPABASE_URL = oldURL;
    process.env.SUPABASE_SERVICE_ROLE_KEY = oldKey;
    await new Promise<void>((r, e) =>
      server.close((err) => (err ? e(err) : r())),
    );
  }
});
