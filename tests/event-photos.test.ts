import test from "node:test";
import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import { createServer } from "node:http";
import {
  sanitizePhotoPng,
  pngChunk,
} from "../netlify/functions/shared/photo-png.js";
import handler from "../netlify/functions/event-photos-api.js";
const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
function png(width = 1, height = 1, raw = Buffer.from([0, 255, 0, 0, 255])) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    signature,
    pngChunk("IHDR", header),
    pngChunk("tEXt", Buffer.from("GPS\0private-location")),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}
test("private PNG sanitizer removes metadata and rejects hostile encodings", () => {
  const good = sanitizePhotoPng(png());
  assert.equal(good.width, 1);
  assert(!good.bytes.includes(Buffer.from("GPS")));
  assert.deepEqual(sanitizePhotoPng(good.bytes).bytes, good.bytes);
  for (const bad of [
    Buffer.from('<svg onload="x"/>'),
    Buffer.from([255, 216, 255]),
    Buffer.alloc(1_000_001),
    png(1601),
    png(0),
    png(1, 1, Buffer.alloc(1000)),
    png(1, 1, Buffer.from([5, 1, 2, 3, 4])),
    Buffer.concat([png(), Buffer.from("trailer")]),
  ])
    assert.throws(() => sanitizePhotoPng(bad));
  const trailing = Buffer.concat([
    signature,
    pngChunk("IHDR", png().subarray(16, 29)),
    pngChunk(
      "IDAT",
      Buffer.concat([
        deflateSync(Buffer.from([0, 255, 0, 0, 255])),
        Buffer.from("HIDDEN_TRAILING_METADATA"),
      ]),
    ),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
  assert(
    !sanitizePhotoPng(trailing).bytes.includes(
      Buffer.from("HIDDEN_TRAILING_METADATA"),
    ),
  );
  const corrupt = png();
  corrupt[45] ^= 1;
  assert.throws(() => sanitizePhotoPng(corrupt));
  const apng = Buffer.concat([
    png().subarray(0, 33),
    pngChunk("acTL", Buffer.alloc(8)),
    png().subarray(33),
  ]);
  assert.throws(() => sanitizePhotoPng(apng));
});
test("photo HTTP boundary confines upload/list/download to owner or internal admin", async () => {
  const U = "10000000-0000-4000-8000-000000000001",
    E = "20000000-0000-4000-8000-000000000001",
    P = "30000000-0000-4000-8000-000000000001";
  let admin = false,
    verified = true,
    banned = false,
    registered = true,
    foreign = false,
    rejectAfterUpload = false;
  const calls: { path: string; method: string; body: any }[] = [];
  const backend = createServer(async (req, res) => {
    let text = "";
    for await (const c of req) text += c;
    const path = req.url!,
      url = new URL(path, "http://mock");
    let data: any;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    calls.push({ path, method: req.method!, body: data });
    const send = (data: any, status = 200) => {
      res.statusCode = status;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(data));
    };
    if (url.pathname === "/auth/v1/user")
      return send({
        id: U,
        email_confirmed_at: verified ? "2026-01-01" : null,
        is_anonymous: false,
        banned_until: banned ? "2099-01-01" : null,
      });
    if (url.pathname === "/rest/v1/profiles")
      return send({
        role: admin ? "admin" : "member",
        passcode_verified: admin,
      });
    if (url.pathname === "/rest/v1/event_registrations")
      return send(registered ? { id: P } : null);
    if (url.pathname === "/rest/v1/rpc/consume_quota") return send(true);
    if (url.pathname === "/rest/v1/rpc/queue_event_photo_cleanup")
      return send(null);
    if (url.pathname === "/rest/v1/rpc/record_event_photo_cleanup")
      return send(null);
    if (url.pathname === "/rest/v1/event_photo_cleanup")
      return send(
        req.method === "DELETE" ? [] : { id: P, object_path: "known/path.png" },
      );
    if (url.pathname === "/rest/v1/rpc/add_pending_event_photo")
      return rejectAfterUpload
        ? send({ message: "REGISTRATION_REQUIRED" }, 400)
        : send({ id: P, status: "pending" });
    if (
      url.pathname === "/rest/v1/event_photos" &&
      url.searchParams.has("object_path")
    )
      return send(null);
    if (url.pathname === "/rest/v1/event_photos")
      return send(
        url.searchParams.has("id")
          ? { user_id: foreign ? "other" : U, object_path: "known/path.png" }
          : [],
      );
    if (url.pathname.startsWith("/storage/v1/object/event-photos/"))
      return send({ Key: "event-photos/known/path.png" });
    if (
      url.pathname === "/storage/v1/object/event-photos" &&
      req.method === "DELETE"
    )
      return send([]);
    if (
      url.pathname.startsWith("/storage/v1/object/authenticated/event-photos/")
    ) {
      res.setHeader("Content-Type", "image/png");
      return res.end(png());
    }
    return send({ message: "Unexpected " + path }, 500);
  });
  await new Promise<void>((r) => backend.listen(0, "127.0.0.1", r));
  const old = {
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
  };
  process.env.SUPABASE_URL = `http://127.0.0.1:${(backend.address() as any).port}`;
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-only";
  const call = (suffix = "", method = "GET", token = "jwt", body?: unknown) =>
    handler(
      new Request("https://example.test/api/v1/event-photos" + suffix, {
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
  const input = {
    event_id: E,
    png_base64: png().toString("base64"),
    caption: "活動留念",
    consent: true,
  };
  try {
    assert.equal((await call("?event_id=" + E, "GET", "")).status, 401);
    assert.equal(
      (await call("", "POST", "ntucc_event_secret", input)).status,
      403,
    );
    assert.equal(
      (await call("", "POST", "ntucc_sk_secret", input)).status,
      403,
    );
    verified = false;
    assert.equal((await call("", "POST", "jwt", input)).status, 403);
    verified = true;
    banned = true;
    assert.equal((await call("", "POST", "jwt", input)).status, 403);
    banned = false;
    assert.equal(
      (await call("", "POST", "jwt", { ...input, consent: false })).status,
      400,
    );
    assert.equal(
      (await call("", "POST", "jwt", { ...input, user_id: "other" })).status,
      400,
    );
    registered = false;
    assert.equal((await call("", "POST", "jwt", input)).status, 403);
    registered = true;
    const uploaded = await call("", "POST", "jwt", input);
    assert.equal(uploaded.status, 201);
    assert.equal((await uploaded.json()).status, "pending");
    const rpc = calls.find((c) =>
      c.path.includes("/rpc/add_pending_event_photo"),
    )!;
    assert.equal(rpc.body.p_user, U);
    assert.equal(rpc.body.p_event, E);
    assert.match(
      rpc.body.p_path,
      new RegExp("^" + E + "/" + U + "/[0-9a-f-]+\\.png$"),
    );
    assert.equal((await call("?event_id=" + E)).status, 200);
    assert(calls.some((c) => c.path.includes("user_id=eq." + U)));
    foreign = true;
    assert.equal((await call("/" + P)).status, 404);
    assert(!calls.some((c) => c.path.includes("/object/authenticated/")));
    foreign = false;
    const download = await call("/" + P);
    assert.equal(download.status, 200);
    assert.equal(download.headers.get("cache-control"), "no-store");
    admin = true;
    foreign = true;
    assert.equal((await call("/" + P)).status, 200);
    admin = false;
    rejectAfterUpload = true;
    assert.equal((await call("", "POST", "jwt", input)).status, 403);
    assert(
      calls.some(
        (c) =>
          c.method === "DELETE" && c.path === "/storage/v1/object/event-photos",
      ),
    );
    assert(
      !calls.some(
        (c) =>
          c.path.includes("/object/public/") ||
          c.path.includes("/object/sign/"),
      ),
    );
  } finally {
    for (const [k, v] of Object.entries(old)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await new Promise<void>((r) => backend.close(() => r()));
  }
});
