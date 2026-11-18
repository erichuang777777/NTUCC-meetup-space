import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import handler from "../netlify/functions/event-photos-api.js";
test("photo lifecycle API requires owner opt-in, human admin review and durable cleanup", async () => {
  const U = "11000000-0000-4000-8000-000000000001",
    A = "11000000-0000-4000-8000-000000000002",
    E = "22000000-0000-4000-8000-000000000001",
    P = "33000000-0000-4000-8000-000000000001";
  let status = "pending",
    consent = false,
    eventPublic = true,
    removeFails = false,
    withdrawDuringRead = false,
    queued = false,
    deleted = false,
    activeGuard = false,
    downloads = 0,
    quotaAllowed = true;
  const calls: any[] = [];
  const backend = createServer(async (req, res) => {
    let text = "";
    for await (const c of req) text += c;
    const data = text ? JSON.parse(text) : null,
      url = new URL(req.url!, "http://mock");
    calls.push({ path: req.url, method: req.method, data });
    const send = (data: any, code = 200) => {
      res.statusCode = code;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(data));
    };
    const admin = req.headers.authorization === "Bearer admin-jwt";
    if (url.pathname === "/auth/v1/user")
      return send({ id: admin ? A : U, email_confirmed_at: "2026-01-01" });
    if (url.pathname === "/rest/v1/profiles")
      return send({
        role: url.searchParams.get("id") === "eq." + A ? "admin" : "member",
        passcode_verified: url.searchParams.get("id") === "eq." + A,
      });
    if (url.pathname === "/rest/v1/event_photos") {
      if (url.searchParams.has("object_path"))
        return send(activeGuard ? { id: P } : null);
      const isPublic = url.searchParams.get("status") === "eq.published";
      if (isPublic) {
        assert.equal(url.searchParams.get("publication_consent"), "eq.true");
        assert.equal(url.searchParams.get("audience"), "eq.public_web");
        assert.equal(
          url.searchParams.get("public_events.is_published"),
          "eq.true",
        );
      }
      if (url.searchParams.has("id"))
        return send(
          isPublic && !(status === "published" && consent && eventPublic)
            ? null
            : { user_id: U, object_path: "known/path.png", status },
        );
      return send(
        isPublic
          ? status === "published" && consent && eventPublic
            ? [
                {
                  id: P,
                  event_id: E,
                  caption: "photo",
                  width: 1,
                  height: 1,
                  created_at: "2026-01-01",
                  public_events: { is_published: true },
                },
              ]
            : []
          : [
              {
                id: P,
                event_id: E,
                caption: "photo",
                status,
                publication_consent: consent,
                audience: consent ? "public_web" : null,
                review_reason: null,
                user_id: U,
                storage_deleted_at: deleted ? "2026-01-01" : null,
              },
            ],
      );
    }
    if (url.pathname === "/rest/v1/rpc/consume_quota")
      return send(quotaAllowed);
    if (url.pathname === "/rest/v1/rpc/change_event_photo") {
      assert.equal(data.p_photo, P);
      if (data.p_action === "consent") {
        if (data.p_actor !== U)
          return send({ message: "PHOTO_NOT_FOUND" }, 400);
        consent = data.p_consent;
        if (!consent && status === "published") status = "pending";
      }
      if (["publish", "return"].includes(data.p_action)) {
        if (data.p_actor !== A) return send({ message: "ADMIN_REQUIRED" }, 400);
        if (data.p_action === "publish" && !consent)
          return send({ message: "PUBLICATION_CONSENT_REQUIRED" }, 400);
        status = data.p_action === "publish" ? "published" : "returned";
      }
      if (data.p_action === "withdraw") {
        if (data.p_actor !== U)
          return send({ message: "PHOTO_NOT_FOUND" }, 400);
        status = "withdrawn";
        queued = true;
        consent = false;
      }
      return send({
        id: P,
        status,
        publication_consent: consent,
        storage_deleted: deleted,
      });
    }
    if (url.pathname === "/rest/v1/event_photo_cleanup")
      return send(queued ? { id: P, object_path: "known/path.png" } : null);
    if (url.pathname === "/rest/v1/rpc/pending_event_photo_cleanup")
      return send(
        queued && !deleted ? [{ id: P, object_path: "known/path.png" }] : [],
      );
    if (url.pathname === "/rest/v1/rpc/record_event_photo_cleanup") {
      deleted = data.p_deleted;
      return send(null);
    }
    if (
      url.pathname.startsWith("/storage/v1/object/authenticated/") ||
      url.pathname.startsWith("/storage/v1/object/event-photos/")
    ) {
      downloads++;
      if (withdrawDuringRead) status = "withdrawn";
      res.setHeader("Content-Type", "image/png");
      return res.end(Buffer.from("test-image"));
    }
    if (
      url.pathname === "/storage/v1/object/event-photos" &&
      req.method === "DELETE"
    )
      return send(
        removeFails ? { message: "storage unavailable" } : [],
        removeFails ? 503 : 200,
      );
    return send({ message: "Unexpected " + req.url }, 500);
  });
  await new Promise<void>((r) => backend.listen(0, "127.0.0.1", r));
  const old = {
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
  };
  process.env.SUPABASE_URL = `http://127.0.0.1:${(backend.address() as any).port}`;
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-only";
  const call = (path: string, method = "GET", token = "", body?: any) =>
    handler(
      new Request("https://example.test/api/v1/event-photos" + path, {
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
  const publish = {
    decision: "publish",
    reason: "Reviewed consent and visible photo content",
    reviewed_for_publication: true,
    audience: "public_web",
  };
  try {
    assert.deepEqual(
      (await (await call("/public?event_id=" + E)).json()).photos,
      [],
    );
    assert.equal((await call("/public/" + P)).status, 404);
    assert.equal(downloads, 0);
    assert.equal(
      (await call("/" + P, "PATCH", "owner-jwt", publish)).status,
      403,
    );
    assert.equal(
      (await call("/" + P, "PATCH", "admin-jwt", publish)).status,
      409,
    );
    assert.equal(
      (
        await call("/" + P, "PATCH", "admin-jwt", {
          publication_consent: true,
          audience: "public_web",
        })
      ).status,
      404,
    );
    assert.equal(
      (
        await call("/" + P, "PATCH", "owner-jwt", {
          publication_consent: true,
          audience: "public_web",
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await call("/" + P, "PATCH", "admin-jwt", {
          ...publish,
          reviewed_for_publication: false,
        })
      ).status,
      400,
    );
    assert.equal(
      (await call("/" + P, "PATCH", "ntucc_event_secret", publish)).status,
      403,
    );
    assert.equal(
      (await call("/" + P, "PATCH", "admin-jwt", publish)).status,
      200,
    );
    const listing = await (await call("/public?event_id=" + E)).json();
    assert.equal(listing.photos.length, 1);
    assert(!JSON.stringify(listing).includes("user_id"));
    assert(!JSON.stringify(listing).includes("object_path"));
    assert.equal((await call("/public/" + P)).status, 200);
    eventPublic = false;
    assert.equal((await call("/public/" + P)).status, 404);
    eventPublic = true;
    assert.equal(
      (
        await call("/" + P, "PATCH", "owner-jwt", {
          publication_consent: false,
          audience: "public_web",
        })
      ).status,
      200,
    );
    assert.equal((await call("/public/" + P)).status, 404);
    assert.equal(
      (
        await call("/" + P, "PATCH", "admin-jwt", {
          decision: "return",
          reason: "Please confirm consent",
          reviewed_for_publication: true,
        })
      ).status,
      200,
    );
    assert.equal((await call("/" + P, "GET", "owner-jwt")).status, 200);
    const privateList = await (
      await call("?event_id=" + E, "GET", "owner-jwt")
    ).json();
    assert.equal(privateList.is_admin, false);
    assert.equal(privateList.photos[0].is_owner, true);
    assert(!JSON.stringify(privateList).includes("user_id"));
    await call("/" + P, "PATCH", "owner-jwt", {
      publication_consent: true,
      audience: "public_web",
    });
    await call("/" + P, "PATCH", "admin-jwt", publish);
    withdrawDuringRead = true;
    assert.equal((await call("/public/" + P)).status, 404);
    withdrawDuringRead = false;
    removeFails = true;
    const withdrawal = await (
      await call("/" + P, "DELETE", "owner-jwt")
    ).json();
    assert.equal(withdrawal.status, "withdrawn");
    assert.equal(withdrawal.storage_deleted, false);
    assert.equal(withdrawal.cleanup_pending, true);
    assert.equal((await call("/" + P, "GET", "owner-jwt")).status, 404);
    assert.equal((await call("/cleanup", "POST", "owner-jwt", {})).status, 403);
    const failed = await (
      await call("/cleanup", "POST", "admin-jwt", {})
    ).json();
    assert.equal(failed.pending, 1);
    activeGuard = true;
    removeFails = false;
    const before = calls.filter((c) => c.method === "DELETE").length;
    assert.equal(
      (await (await call("/cleanup", "POST", "admin-jwt", {})).json()).deleted,
      0,
    );
    assert.equal(calls.filter((c) => c.method === "DELETE").length, before);
    activeGuard = false;
    const cleaned = await (
      await call("/cleanup", "POST", "admin-jwt", {})
    ).json();
    assert.equal(cleaned.deleted, 1);
    assert.equal(
      (await (await call("/" + P, "DELETE", "owner-jwt")).json())
        .storage_deleted,
      true,
    );
    eventPublic = false;
    const beforeMine = calls.length;
    const mine = await call("?scope=mine", "GET", "owner-jwt");
    assert.equal(mine.status, 200);
    const mineCalls = calls.slice(beforeMine);
    assert(!mineCalls.some((c) => c.path.startsWith("/rest/v1/public_events")));
    assert(mineCalls.some((c) => c.path.includes("user_id=eq." + U)));
    const beforeAdminMine = calls.length;
    await call("?scope=mine&event_id=" + E, "GET", "admin-jwt");
    assert(
      calls
        .slice(beforeAdminMine)
        .some(
          (c) =>
            c.path.includes("user_id=eq." + A) &&
            c.path.includes("event_id=eq." + E),
        ),
    );
    quotaAllowed = false;
    const beforeLimited = calls.filter(
      (c) => c.path === "/rest/v1/rpc/change_event_photo",
    ).length;
    assert.equal(
      (
        await call("/" + P, "PATCH", "owner-jwt", {
          publication_consent: true,
          audience: "public_web",
        })
      ).status,
      429,
    );
    assert.equal(
      calls.filter((c) => c.path === "/rest/v1/rpc/change_event_photo").length,
      beforeLimited,
    );
  } finally {
    for (const [k, v] of Object.entries(old)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await new Promise<void>((r) => backend.close(() => r()));
  }
});
