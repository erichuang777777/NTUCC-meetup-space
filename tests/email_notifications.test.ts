import test from "node:test";
import assert from "node:assert/strict";
import {
  emailConfig,
  maskEmail,
  sendEmail,
  truncateError,
} from "../netlify/functions/shared/email-provider.js";
import {
  absoluteLink,
  resetWarned,
  runEmailDispatch,
  config as dispatchConfig,
} from "../netlify/functions/email-dispatch.js";
import {
  config as digestConfig,
  runEmailDigest,
} from "../netlify/functions/email-digest.js";
import { clearFeatureCache } from "../netlify/functions/shared/features.js";
import { HttpError } from "../netlify/functions/shared/http.js";

const env = {
  EMAIL_PROVIDER_URL: "https://mail.test/send",
  EMAIL_API_KEY: "sk_secret",
  EMAIL_FROM: "n@x.test",
};
const msg = { to: "alice@example.com", subject: "s", text: "t" };

test("missing env: no fetch, not configured", async () => {
  let called = 0;
  const r = await sendEmail(
    msg,
    (async () => {
      called++;
      return new Response("{}");
    }) as any,
    { EMAIL_PROVIDER_URL: "https://x" },
  );
  assert.equal(called, 0);
  assert.equal(r.notConfigured, true);
  assert.equal(emailConfig({}), null);
});

test("sends Resend-shaped request", async () => {
  let seen: any;
  const r = await sendEmail(
    msg,
    (async (url: string, init: any) => {
      seen = { url, init };
      return new Response("{}", { status: 200 });
    }) as any,
    env,
  );
  assert.ok(r.ok);
  assert.equal(seen.url, env.EMAIL_PROVIDER_URL);
  assert.equal(seen.init.headers.Authorization, "Bearer sk_secret");
  assert.deepEqual(JSON.parse(seen.init.body), {
    from: "n@x.test",
    to: msg.to,
    subject: "s",
    text: "t",
  });
});

test("mask address and truncate/redact errors", async () => {
  assert.equal(maskEmail("alice@example.com"), "a***@e***.com");
  const long = "bad alice@example.com Bearer sk_secret " + "x".repeat(900);
  const e = truncateError(long, ["sk_secret"]);
  assert.ok(e.length <= 500);
  assert.ok(!e.includes("alice@") && !e.includes("sk_secret"));
  const r = await sendEmail(
    msg,
    (async () =>
      new Response("rejected alice@example.com sk_secret " + "y".repeat(900), {
        status: 500,
      })) as any,
    env,
  );
  assert.equal(r.ok, false);
  assert.ok(r.error!.startsWith("PROVIDER_HTTP_500"));
  assert.ok(r.error!.length <= 500);
  assert.ok(!r.error!.includes("sk_secret") && !r.error!.includes("alice@"));
  const t = await sendEmail(
    msg,
    (async () => {
      throw new Error("net sk_secret");
    }) as any,
    env,
  );
  assert.ok(!t.error!.includes("sk_secret"));
});

test("absoluteLink joins origin", () => {
  assert.equal(
    absoluteLink("https://a.test/", "#notifications"),
    "https://a.test/#notifications",
  );
  assert.equal(absoluteLink("https://a.test", "/x"), "https://a.test/x");
  assert.equal(
    absoluteLink("https://a.test", null),
    "https://a.test/#notifications",
  );
});

const mockDb = (enabled: boolean, rows: any[] = []) => {
  const calls: any[] = [];
  return {
    calls,
    rpc: async (fn: string, args?: any) => {
      calls.push([fn, args]);
      if (fn === "is_feature_enabled") return { data: enabled, error: null };
      if (fn === "claim_email_batch") return { data: rows, error: null };
      return { data: 1, error: null };
    },
  };
};

test("dispatch: flag off => 404", async () => {
  clearFeatureCache();
  await assert.rejects(
    runEmailDispatch(mockDb(false), undefined, "https://a.test", true),
    (e: any) => e instanceof HttpError && e.code === "FEATURE_DISABLED",
  );
});

test("dispatch: unconfigured leaves rows pending and warns once", async () => {
  clearFeatureCache();
  resetWarned();
  const db = mockDb(true);
  const warn = console.warn;
  let warns = 0;
  console.warn = () => {
    warns++;
  };
  try {
    await runEmailDispatch(db, undefined, "https://a.test", false);
    await runEmailDispatch(db, undefined, "https://a.test", false);
  } finally {
    console.warn = warn;
  }
  assert.equal(warns, 1);
  assert.ok(!db.calls.some((c) => c[0] === "claim_email_batch"));
});

test("dispatch: sends and completes, logs masked address only", async () => {
  clearFeatureCache();
  const rows = [
    {
      id: "1",
      subject: "s1",
      body_text: "- a",
      link: "#notifications",
      to_email: "alice@example.com",
    },
    {
      id: "2",
      subject: "s2",
      body_text: "- b",
      link: "/x",
      to_email: "bob@example.com",
    },
  ];
  const db = mockDb(true, rows);
  const logs: string[] = [];
  const warn = console.warn;
  console.warn = (m: string) => {
    logs.push(m);
  };
  const sentTo: any[] = [];
  try {
    const r = await runEmailDispatch(
      db,
      async (m) => {
        sentTo.push(m);
        return m.to.startsWith("bob")
          ? { ok: false, error: "boom" }
          : { ok: true };
      },
      "https://a.test",
      true,
    );
    assert.deepEqual(r, { sent: 1, failed: 1, claimed: 2, configured: true });
  } finally {
    console.warn = warn;
  }
  assert.equal(sentTo[0].text, "- a\n\nhttps://a.test/#notifications");
  assert.deepEqual(
    db.calls.filter((c) => c[0] === "complete_email").map((c) => c[1]),
    [
      { p_id: "1", p_ok: true, p_error: null },
      { p_id: "2", p_ok: false, p_error: "boom" },
    ],
  );
  assert.ok(
    logs.every(
      (l) => !l.includes("bob@example.com") && !l.includes("alice@example.com"),
    ),
  );
  assert.ok(logs.some((l) => l.includes("b***@e***.com")));
});

test("schedules and digest flow", async () => {
  assert.equal(dispatchConfig.schedule, "*/10 * * * *");
  assert.equal(digestConfig.schedule, "17 0 * * *");
  clearFeatureCache();
  const db = mockDb(true);
  assert.deepEqual(await runEmailDigest(db, new Date("2030-01-01T00:17:00Z")), {
    digests: 1,
  });
  assert.deepEqual(db.calls[1], [
    "build_email_digests",
    { p_now: "2030-01-01T00:17:00.000Z" },
  ]);
  clearFeatureCache();
  await assert.rejects(
    runEmailDigest(mockDb(false)),
    (e: any) => e.code === "FEATURE_DISABLED",
  );
});
