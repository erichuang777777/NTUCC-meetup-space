import { randomUUID } from "node:crypto";
import { z } from "zod";
import { db } from "./shared/auth-helper.js";
import { body, checked, fail, HttpError, json } from "./shared/http.js";
import { sanitizePhotoPng } from "./shared/photo-png.js";
import { scanValue } from "../../public/pii.js";
const uuid = z.string().uuid();
async function actor(req: Request, client: ReturnType<typeof db>) {
  const token = req.headers.get("authorization")?.match(/^Bearer (\S+)$/i)?.[1];
  if (!token) throw new HttpError(401, "AUTH_REQUIRED");
  if (token.startsWith("ntucc_"))
    throw new HttpError(403, "INTERACTIVE_LOGIN_REQUIRED");
  const { data, error } = await client.auth.getUser(token);
  const user = data.user as any;
  if (error || !user) throw new HttpError(401, "INVALID_TOKEN");
  if (
    !user.email_confirmed_at ||
    user.is_anonymous ||
    user.deleted_at ||
    (user.banned_until && Date.parse(user.banned_until) > Date.now())
  )
    throw new HttpError(403, "VERIFIED_ACCOUNT_REQUIRED");
  const p = checked(
    await client
      .from("profiles")
      .select("role,passcode_verified")
      .eq("id", user.id)
      .maybeSingle(),
  );
  return {
    id: user.id as string,
    isAdmin: p?.role === "admin" && p?.passcode_verified === true,
  };
}
const publicFields = "id,event_id,caption,width,height,created_at";
const privateFields =
  publicFields +
  ",status,publication_consent,audience,review_reason,storage_deleted_at,user_id";
function imageResponse(blob: Blob) {
  return new Response(blob, {
    headers: {
      "Content-Type": "image/png",
      "Content-Disposition": 'inline; filename="event-photo.png"',
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
    },
  });
}
function photoError(result: any) {
  const code = [
    "PHOTO_NOT_FOUND",
    "ADMIN_REQUIRED",
    "PHOTO_WITHDRAWN",
    "PUBLIC_AUDIENCE_REQUIRED",
    "PHOTO_REVIEW_REQUIRED",
    "PUBLICATION_CONSENT_REQUIRED",
    "PHOTO_EVENT_UNAVAILABLE",
    "PHOTO_STILL_ACTIVE",
  ].find((c) => result.error?.message?.includes(c));
  if (code)
    throw new HttpError(
      code === "PHOTO_NOT_FOUND" ? 404 : code === "ADMIN_REQUIRED" ? 403 : 409,
      code,
    );
  return checked(result);
}
async function clean(
  client: ReturnType<typeof db>,
  row: { id: string; object_path: string },
) {
  // Both orphan queues and withdrawn rows are permanently non-public. Paths are server-generated.
  const active = await client
    .from("event_photos")
    .select("id")
    .eq("object_path", row.object_path)
    .neq("status", "withdrawn")
    .maybeSingle();
  if (active.error || active.data) return false; // Fail closed before any destructive Storage call.
  const removal = await client.storage
    .from("event-photos")
    .remove([row.object_path]);
  const recorded = await client.rpc("record_event_photo_cleanup", {
    p_id: row.id,
    p_deleted: !removal.error,
  });
  return !removal.error && !recorded.error;
}
async function publicPhoto(client: ReturnType<typeof db>, id: string) {
  return checked(
    await client
      .from("event_photos")
      .select("object_path,public_events!inner(is_published)")
      .eq("id", id)
      .eq("status", "published")
      .eq("publication_consent", true)
      .eq("audience", "public_web")
      .eq("public_events.is_published", true)
      .eq("public_events.audience", "public")
      .maybeSingle(),
  );
}
export default async function handler(req: Request) {
  try {
    const client = db(),
      url = new URL(req.url);
    const path = url.pathname
      .replace(/^.*\/(?:event-photos-api|event-photos)\/?/, "")
      .split("/")
      .filter(Boolean);
    if (path[0] === "public") {
      if (req.method !== "GET") throw new HttpError(405, "METHOD_NOT_ALLOWED");
      if (path.length === 2) {
        const id = uuid.parse(path[1]),
          photo = await publicPhoto(client, id);
        if (!photo) throw new HttpError(404, "NOT_FOUND");
        const blob = checked(
          await client.storage.from("event-photos").download(photo.object_path),
        );
        // Recheck after I/O so a withdrawal during download does not begin a new public response.
        if (!(await publicPhoto(client, id)))
          throw new HttpError(404, "NOT_FOUND");
        if (!blob) throw new HttpError(404, "NOT_FOUND");
        return imageResponse(blob);
      }
      if (path.length !== 1) throw new HttpError(404, "NOT_FOUND");
      const event = uuid.parse(url.searchParams.get("event_id")),
        page = z.coerce
          .number()
          .int()
          .min(1)
          .max(200)
          .parse(url.searchParams.get("page") ?? 1);
      const rows =
        checked(
          await client
            .from("event_photos")
            .select(publicFields + ",public_events!inner(is_published)")
            .eq("event_id", event)
            .eq("status", "published")
            .eq("publication_consent", true)
            .eq("audience", "public_web")
            .eq("public_events.is_published", true)
            .eq("public_events.audience", "public")
            .order("created_at", { ascending: false })
            .order("id")
            .range((page - 1) * 25, page * 25 - 1),
        ) ?? [];
      return json({
        photos: rows.map(({ public_events, ...photo }: any) => photo),
        page,
        page_size: 25,
      });
    }
    if (path.length > 1) throw new HttpError(404, "NOT_FOUND");
    const who = await actor(req, client);
    if (path[0] === "cleanup") {
      if (req.method !== "POST") throw new HttpError(405, "METHOD_NOT_ALLOWED");
      if (!who.isAdmin) throw new HttpError(403, "ADMIN_REQUIRED");
      z.object({})
        .strict()
        .parse(await body(req));
      const rows =
        checked(await client.rpc("pending_event_photo_cleanup")) ?? [];
      let deleted = 0;
      for (const row of rows) if (await clean(client, row)) deleted++;
      return json({
        processed: rows.length,
        deleted,
        pending: rows.length - deleted,
      });
    }
    if (path[0]) {
      const id = uuid.parse(path[0]);
      if (req.method === "PATCH") {
        const input = await body(req);
        const consent = z
          .object({
            publication_consent: z.boolean(),
            audience: z.literal("public_web"),
          })
          .strict()
          .safeParse(input);
        let args: any;
        if (consent.success)
          args = {
            p_photo: id,
            p_actor: who.id,
            p_action: "consent",
            p_consent: consent.data.publication_consent,
            p_audience: "public_web",
          };
        else {
          if (!who.isAdmin) throw new HttpError(403, "ADMIN_REQUIRED");
          const review = z
            .object({
              decision: z.enum(["publish", "return"]),
              reason: z.string().trim().min(1).max(1000),
              reviewed_for_publication: z.literal(true),
              audience: z.literal("public_web").optional(),
            })
            .strict()
            .parse(input);
          if (review.decision === "publish" && review.audience !== "public_web")
            throw new HttpError(400, "PUBLIC_AUDIENCE_REQUIRED");
          if (scanValue(review.reason).length)
            throw new HttpError(422, "PII_DETECTED");
          args = {
            p_photo: id,
            p_actor: who.id,
            p_action: review.decision,
            p_reason: review.reason,
            p_reviewed: true,
            p_audience: review.audience ?? null,
          };
        }
        const allowed = checked(
          await client.rpc("consume_quota", {
            p_user: who.id,
            p_action: "event_photo_lifecycle",
            p_limit: 60,
          }),
        );
        if (!allowed) throw new HttpError(429, "RATE_LIMITED");
        return json(photoError(await client.rpc("change_event_photo", args)));
      }
      if (req.method === "DELETE") {
        const result = photoError(
          await client.rpc("change_event_photo", {
            p_photo: id,
            p_actor: who.id,
            p_action: "withdraw",
          }),
        );
        if (result.storage_deleted)
          return json({ ...result, cleanup_pending: false });
        const row = checked(
          await client
            .from("event_photo_cleanup")
            .select("id,object_path")
            .eq("photo_id", id)
            .eq("status", "pending")
            .maybeSingle(),
        );
        const removed = row ? await clean(client, row) : false;
        return json({
          id,
          status: "withdrawn",
          storage_deleted: removed,
          cleanup_pending: !removed,
        });
      }
      if (req.method !== "GET") throw new HttpError(405, "METHOD_NOT_ALLOWED");
      const getPrivate = () =>
        client
          .from("event_photos")
          .select("user_id,object_path,status")
          .eq("id", id)
          .maybeSingle();
      const photo = checked(await getPrivate());
      if (
        !photo ||
        photo.status === "withdrawn" ||
        (!who.isAdmin && photo.user_id !== who.id)
      )
        throw new HttpError(404, "NOT_FOUND");
      const blob = checked(
        await client.storage.from("event-photos").download(photo.object_path),
      );
      const latest = checked(await getPrivate());
      if (!latest || latest.status === "withdrawn")
        throw new HttpError(404, "NOT_FOUND");
      if (!blob) throw new HttpError(404, "NOT_FOUND");
      return imageResponse(blob);
    }
    if (req.method === "GET") {
      const mine = url.searchParams.get("scope") === "mine";
      const eventParam = url.searchParams.get("event_id");
      const event = eventParam ? uuid.parse(eventParam) : null;
      if (!mine && !event) throw new HttpError(400, "EVENT_ID_REQUIRED");
      const page = z.coerce
        .number()
        .int()
        .min(1)
        .max(200)
        .parse(url.searchParams.get("page") ?? 1);
      let q = client.from("event_photos").select(privateFields);
      if (event) q = q.eq("event_id", event);
      if (mine || !who.isAdmin) q = q.eq("user_id", who.id);
      const rows =
        checked(
          await q
            .order("created_at", { ascending: false })
            .order("id")
            .range((page - 1) * 25, page * 25 - 1),
        ) ?? [];
      return json({
        photos: rows.map(({ user_id, storage_deleted_at, ...photo }: any) => ({
          ...photo,
          is_owner: user_id === who.id,
          storage_deleted: !!storage_deleted_at,
        })),
        is_admin: who.isAdmin,
        page,
        page_size: 25,
      });
    }
    if (req.method !== "POST") throw new HttpError(405, "METHOD_NOT_ALLOWED");
    const input = z
      .object({
        event_id: uuid,
        png_base64: z.string().max(1_333_336),
        caption: z.string().trim().max(500).default(""),
        consent: z.literal(true),
      })
      .strict()
      .parse(await body(req));
    if (scanValue(input.caption).length)
      throw new HttpError(422, "PII_DETECTED");
    const registered = checked(
      await client
        .from("event_registrations")
        .select("id")
        .eq("event_id", input.event_id)
        .eq("user_id", who.id)
        .eq("status", "registered")
        .eq("eligibility_status", "approved")
        .maybeSingle(),
    );
    if (!registered) throw new HttpError(403, "REGISTRATION_REQUIRED");
    const quota = checked(
      await client.rpc("consume_quota", {
        p_user: who.id,
        p_action: "event_photo_upload",
        p_limit: 10,
      }),
    );
    if (!quota) throw new HttpError(429, "RATE_LIMITED");
    if (
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        input.png_base64,
      )
    )
      throw new HttpError(400, "INVALID_PNG");
    const png = sanitizePhotoPng(Buffer.from(input.png_base64, "base64")),
      id = randomUUID(),
      key = `${input.event_id}/${who.id}/${id}.png`;
    // Durable intent precedes the external object write. A stale intent is recoverable after 10 minutes.
    checked(
      await client.rpc("queue_event_photo_cleanup", {
        p_path: key,
        p_intent: true,
      }),
    );
    checked(
      await client.storage.from("event-photos").upload(key, png.bytes, {
        contentType: "image/png",
        upsert: false,
        cacheControl: "0",
      }),
    );
    const result = await client.rpc("add_pending_event_photo", {
      p_id: id,
      p_user: who.id,
      p_event: input.event_id,
      p_path: key,
      p_caption: input.caption,
      p_width: png.width,
      p_height: png.height,
      p_bytes: png.bytes.length,
    });
    if (result.error) {
      // Compensate when registration was cancelled or the event changed while uploading.
      // Persist the orphan before attempting cleanup, so a storage outage is retryable.
      const queued = await client.rpc("queue_event_photo_cleanup", {
        p_path: key,
        p_intent: false,
      });
      if (queued.error) console.error("Private photo cleanup enqueue failed");
      else {
        const row = checked(
          await client
            .from("event_photo_cleanup")
            .select("id,object_path")
            .eq("object_path", key)
            .eq("status", "pending")
            .maybeSingle(),
        );
        if (row) await clean(client, row);
      }
      const code = [
        "PHOTO_EVENT_UNAVAILABLE",
        "REGISTRATION_REQUIRED",
        "PHOTO_LIMIT",
      ].find((c) => result.error.message.includes(c));
      if (code)
        throw new HttpError(code === "REGISTRATION_REQUIRED" ? 403 : 409, code);
    }
    const saved = checked(result);
    // If this acknowledgement fails, the recovery worker recognizes the live photo and retains it.
    const acknowledged = await client
      .from("event_photo_cleanup")
      .delete()
      .eq("object_path", key)
      .eq("status", "intent");
    if (acknowledged.error)
      console.error("Private photo upload intent awaits reconciliation");
    return json(saved, 201);
  } catch (e) {
    if (e instanceof z.ZodError) return json({ code: "VALIDATION_ERROR" }, 400);
    return fail(e);
  }
}
