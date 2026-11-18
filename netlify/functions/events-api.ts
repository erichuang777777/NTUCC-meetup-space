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
  "id,title,description,location,starts_at,ends_at,registration_closes_at,capacity,status,updated_at,sequence,checkin_opens_at,checkin_closes_at";
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
    checkin_opens_at: z.iso.datetime({offset:true}).nullable().optional(),
    checkin_closes_at: z.iso.datetime({offset:true}).nullable().optional(),
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
  ).refine(e => (!e.checkin_opens_at && !e.checkin_closes_at) ||
    (!!e.checkin_opens_at && !!e.checkin_closes_at && Date.parse(e.checkin_closes_at)>Date.parse(e.checkin_opens_at)), "Invalid check-in window");
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
    if (id === "manage") {
      const actor = (await authenticate(req))!;
      requireInteractive(actor);
      admin(actor);
      if (child === "unpublish") {
        if (req.method !== "POST") throw new HttpError(405,"METHOD_NOT_ALLOWED");
        const input=z.object({kind:z.enum(["event","announcement"]),id:uuid}).strict().parse(await body(req));
        await limited(actor.id,"public_event_manage",30);
        return json(checked(await client.from(input.kind==="event"?"public_events":"public_announcements").update({is_published:false}).eq("id",input.id).select("id").single()));
      }
      if (child === "staff") {
        const input=z.object({event_id:uuid,user_id:uuid}).strict().parse(await body(req));
        if (!["POST","DELETE"].includes(req.method)) throw new HttpError(405,"METHOD_NOT_ALLOWED");
        const profile=checked(await client.from("profiles").select("passcode_verified").eq("id",input.user_id).maybeSingle());
        if (req.method==="POST" && !profile?.passcode_verified) throw new HttpError(403,"STAFF_MUST_BE_MEMBER");
        await limited(actor.id,"public_event_manage",30);
        checked(await (req.method==="POST"?client.from("event_staff").upsert(input):client.from("event_staff").delete().eq("event_id",input.event_id).eq("user_id",input.user_id)));
        return json({ok:true});
      }
      if (child) {
        uuid.parse(child);
        if (req.method !== "GET") throw new HttpError(405, "METHOD_NOT_ALLOWED");
        const params = new URL(req.url).searchParams;
        const page = z.coerce.number().int().min(1).max(200).parse(params.get("page") ?? 1);
        const event = checked(await client.from("public_events").select("id").eq("id", child).maybeSingle());
        if (!event) throw new HttpError(404, "NOT_FOUND");
        const counts = await Promise.all(["registered", "cancelled"].map(status =>
          client.from("event_registrations").select("id", {count: "exact", head: true}).eq("event_id", child).eq("status", status)));
        counts.forEach(checked);
        const rows = checked(await client.from("event_registrations")
          .select("id,user_id,status,updated_at,checked_in_at").eq("event_id", child)
          .order("updated_at", {ascending: false}).order("id")
          .range((page-1)*50, page*50-1)) ?? [];
        const profiles = rows.length ? checked(await client.from("profiles")
          .select("id,display_name,email").in("id", rows.map(r => r.user_id))) ?? [] : [];
        const byId = new Map(profiles.map(p => [p.id, p]));
        return json({registrations: rows.map(r => ({...r,
          display_name: byId.get(r.user_id)?.display_name ?? null,
          email: byId.get(r.user_id)?.email ?? null})),
          registered: counts[0].count ?? 0, cancelled: counts[1].count ?? 0,
          total: (counts[0].count ?? 0)+(counts[1].count ?? 0), page, page_size: 50});
      }
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
      await guard(input.kind === "event" ? {title:record.title,description:(record as any).description,location:(record as any).location} : {title:record.title,content:(record as any).content}, false, actor, "rest_api");
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
    if (id === "staff" && !child) {
      if (req.method!=="GET") throw new HttpError(405,"METHOD_NOT_ALLOWED");
      const actor=(await authenticate(req))!; requireInteractive(actor);
      let q=client.from("public_events").select("id,title,starts_at,ends_at").eq("is_published",true).eq("status","scheduled");
      if(actor.role!=="admin") {
        const rows=checked(await client.from("event_staff").select("event_id").eq("user_id",actor.id)) ?? [];
        if(!rows.length) return json({events:[]});
        q=q.in("id",rows.map(r=>r.event_id));
      }
      return json({events:checked(await q.order("starts_at").limit(500))});
    }
    uuid.parse(id);
    if(child === "ticket") {
      if(req.method!=="GET") throw new HttpError(405,"METHOD_NOT_ALLOWED");
      const user=await eventActor(req); await limited(user,"event_ticket",60);
      const result=await client.rpc("event_ticket",{p_user:user,p_event:id,p_token:"ntucc_ticket_"+randomBytes(32).toString("hex")});
      if(result.error?.message.includes("TICKET_UNAVAILABLE")) throw new HttpError(404,"TICKET_UNAVAILABLE");
      return json(checked(result));
    }
    if(child === "check-in") {
      if(req.method!=="POST") throw new HttpError(405,"METHOD_NOT_ALLOWED");
      const actor=(await authenticate(req))!;requireInteractive(actor);
      const input=z.object({token:z.string().regex(/^ntucc_ticket_[a-f0-9]{64}$/)}).strict().parse(await body(req));
      await limited(actor.id,"event_checkin",120);
      const result=await client.rpc("check_in_public_event",{p_actor:actor.id,p_event:id,p_token:input.token});
      const code=["STAFF_REQUIRED","CHECKIN_UNAVAILABLE","CHECKIN_CLOSED","INVALID_TICKET"].find(c=>result.error?.message.includes(c));
      if(code) throw new HttpError(code==="STAFF_REQUIRED"?403:409,code);
      return json(checked(result));
    }
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
