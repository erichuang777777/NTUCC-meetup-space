import { z } from "zod";
import { randomBytes } from "node:crypto";
import {
  db,
  hashToken,
  authenticate,
  admin,
  requireInteractive,
} from "./shared/auth-helper.js";
import { body, checked, fail, HttpError, json } from "./shared/http.js";
import { guard } from "./shared/pii-guard.js";
import { eventCalendar } from "./shared/event-calendar.js";
const eventFields =
  "id,title,description,location,starts_at,ends_at,registration_closes_at,capacity,status,updated_at,sequence";
const announcementFields = "id,title,content,created_at";
const uuid = z.string().uuid();
const eventSchema = z
  .object({
    id: uuid.optional(),
    title: z.string().trim().min(1).max(200),
    description: z.string().max(10000).default(""),
    location: z.string().max(500).default(""),
    starts_at: z.iso.datetime({ offset: true }),
    ends_at: z.iso.datetime({ offset: true }),
    registration_closes_at: z.iso.datetime({ offset: true }),
    capacity: z.number().int().min(1).max(10000),
    status: z.enum(["scheduled", "cancelled"]),
    is_published: z.boolean(),
  })
  .strict()
  .refine(
    (e) =>
      Date.parse(e.ends_at) > Date.parse(e.starts_at) &&
      Date.parse(e.registration_closes_at) <= Date.parse(e.starts_at),
    "Invalid event dates",
  );
const announcementSchema = z
  .object({
    id: uuid.optional(),
    title: z.string().trim().min(1).max(200),
    content: z.string().max(10000),
    is_published: z.boolean(),
  })
  .strict();
function eligible(user: any) {
  return !!user?.email_confirmed_at && !user.is_anonymous && !user.deleted_at &&
    !(user.banned_until && Date.parse(user.banned_until) > Date.now());
}
async function eventActor(req: Request, interactive = false) {
  const token = req.headers.get("authorization")?.match(/^Bearer (\S+)$/i)?.[1];
  if (!token) throw new HttpError(401, "AUTH_REQUIRED");
  const client = db();
  if (token.startsWith("ntucc_event_")) {
    if (interactive) throw new HttpError(403, "INTERACTIVE_LOGIN_REQUIRED");
    const row = checked(
      await client
        .from("event_api_tokens")
        .select("user_id,expires_at")
        .eq("token_hash", hashToken(token))
        .maybeSingle(),
    );
    if (!row || Date.parse(row.expires_at) <= Date.now())
      throw new HttpError(401, "INVALID_TOKEN");
    const { data, error } = await client.auth.admin.getUserById(row.user_id);
    if (error || !eligible(data.user))
      throw new HttpError(401, "INVALID_TOKEN");
    return row.user_id as string;
  }
  if (token.startsWith("ntucc_sk_"))
    throw new HttpError(403, "EVENT_TOKEN_REQUIRED");
  const { data, error } = await client.auth.getUser(token);
  if (error || !data.user) throw new HttpError(401, "INVALID_TOKEN");
  if (!eligible(data.user))
    throw new HttpError(403, "EMAIL_NOT_VERIFIED");
  return data.user.id;
}
async function limited(id: string, action: string, max: number) {
  const ok = checked(
    await db().rpc("consume_quota", {
      p_user: id,
      p_action: action,
      p_limit: max,
    }),
  );
  if (!ok) throw new HttpError(429, "RATE_LIMITED");
}
export default async function handler(req: Request) {
  try {
    const path = new URL(req.url).pathname
      .replace(/^.*\/(?:events-api|events)\/?/, "")
      .split("/")
      .filter(Boolean);
    const [id, child] = path;
    if (path.length > 2) throw new HttpError(404, "NOT_FOUND");
    const client = db();
    if (id === "manage" && !child) {
      const actor = (await authenticate(req))!;
      requireInteractive(actor);
      admin(actor);
      if (req.method === "GET")
        return json({
          events: checked(
            await client
              .from("public_events")
              .select("*")
              .order("starts_at", { ascending: false })
              .limit(500),
          ),
          announcements: checked(
            await client
              .from("public_announcements")
              .select("*")
              .order("created_at", { ascending: false })
              .limit(500),
          ),
        });
      if (req.method !== "POST") throw new HttpError(405, "METHOD_NOT_ALLOWED");
      const input = z
        .object({
          kind: z.enum(["event", "announcement"]),
          record: z.unknown(),
        })
        .strict()
        .parse(await body(req));
      const record =
        input.kind === "event"
          ? eventSchema.parse(input.record)
          : announcementSchema.parse(input.record);
      await guard(record, false, actor, "rest_api");
      await limited(actor.id, "public_event_manage", 30);
      const table =
        input.kind === "event" ? "public_events" : "public_announcements";
      const fields: Record<string, unknown> =
        input.kind === "event"
          ? { ...record, updated_at: new Date().toISOString() }
          : record;
      // Updating a published event is explicit; existing internal records are never migrated.
      const q = record.id
        ? client.from(table).update(fields).eq("id", record.id)
        : client.from(table).insert(fields);
      return json(checked(await q.select("id").single()));
    }
    if (id === "tokens" && !child) {
      const user = await eventActor(req, true);
      if (req.method === "GET")
        return json({
          tokens: checked(
            await client
              .from("event_api_tokens")
              .select("id,prefix,expires_at")
              .eq("user_id", user)
              .order("created_at", { ascending: false }),
          ),
        });
      if (req.method === "DELETE") {
        const p = z
          .object({ id: uuid })
          .strict()
          .parse(await body(req));
        checked(
          await client
            .from("event_api_tokens")
            .delete()
            .eq("id", p.id)
            .eq("user_id", user),
        );
        return json({ revoked: true });
      }
      if (req.method === "POST") {
        z.object({})
          .strict()
          .parse(await body(req));
        await limited(user, "event_token", 5);
        const token = "ntucc_event_" + randomBytes(32).toString("hex"),
          expires_at = new Date(Date.now() + 30 * 86400000).toISOString();
        const row = checked(
          await client
            .from("event_api_tokens")
            .insert({
              user_id: user,
              token_hash: hashToken(token),
              prefix: token.slice(0, 20),
              expires_at,
            })
            .select("id")
            .single(),
        );
        return json({ ...row, token, expires_at }, 201);
      }
      throw new HttpError(405, "METHOD_NOT_ALLOWED");
    }
    if (!id) {
      if (req.method !== "GET") throw new HttpError(405, "METHOD_NOT_ALLOWED");
      return json({
        events: checked(
          await client
            .from("public_events")
            .select(eventFields)
            .eq("is_published", true)
            .order("starts_at", { ascending: false })
            .limit(500),
        ),
        announcements: checked(
          await client
            .from("public_announcements")
            .select(announcementFields)
            .eq("is_published", true)
            .order("created_at", { ascending: false })
            .limit(500),
        ),
      });
    }
    uuid.parse(id);
    if (child === "registration") {
      const user = await eventActor(req);
      if (req.method === "GET")
        return json(
          checked(
            await client
              .from("event_registrations")
              .select("id,status")
              .eq("event_id", id)
              .eq("user_id", user)
              .maybeSingle(),
          ),
        );
      if (!["POST", "DELETE"].includes(req.method))
        throw new HttpError(405, "METHOD_NOT_ALLOWED");
      if (req.method === "POST")
        z.object({})
          .strict()
          .parse(await body(req));
      await limited(user, "event_registration", 30);
      const r = await client.rpc("register_public_event", {
        p_user: user,
        p_event: id,
        p_cancel: req.method === "DELETE",
      });
      if (r.error) {
        const code = [
          "EVENT_NOT_FOUND",
          "EMAIL_NOT_VERIFIED",
          "EVENT_CANCELLED",
          "REGISTRATION_CLOSED",
          "EVENT_FULL",
        ].find((c) => r.error.message.includes(c));
        if (code)
          throw new HttpError(code === "EVENT_NOT_FOUND" ? 404 : 409, code);
      }
      return json(checked(r));
    }
    if (child && child !== "calendar") throw new HttpError(404, "NOT_FOUND");
    if (req.method !== "GET") throw new HttpError(405, "METHOD_NOT_ALLOWED");
    const event = checked(
      await client
        .from("public_events")
        .select(eventFields)
        .eq("id", id)
        .eq("is_published", true)
        .maybeSingle(),
    );
    if (!event) throw new HttpError(404, "NOT_FOUND");
    if (child === "calendar")
      return new Response(eventCalendar(event), {
        headers: {
          "Content-Type": "text/calendar; charset=utf-8",
          "Content-Disposition": 'attachment; filename="event.ics"',
          "Cache-Control": "no-store",
        },
      });
    return json(event);
  } catch (e) {
    if (e instanceof z.ZodError)
      return json({ code: "VALIDATION_ERROR", issues: e.flatten() }, 400);
    return fail(e);
  }
}
