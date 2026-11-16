import { randomBytes } from "node:crypto";
import { z } from "zod";
import { authenticate, admin, db, hashToken } from "./shared/auth-helper.js";
import { body, checked, fail, HttpError, json } from "./shared/http.js";
import { LIST, upsertSpace, question, slides } from "./shared/spaces.js";
import { guard } from "./shared/pii-guard.js";
const uuid = z.string().uuid();
async function staff(actor: { id: string; role: string }, session_id: string) {
  if (actor.role === "admin") return;
  const own = checked(
    await db()
      .from("spaces")
      .select("id")
      .eq("owner_id", actor.id)
      .eq("session_id", session_id)
      .eq("visibility", "public")
      .not("slot_order", "is", null)
      .limit(1),
  );
  if (!own?.length) throw new HttpError(403, "STAFF_REQUIRED");
}

export default async (req: Request) => {
  try {
    const path = new URL(req.url).pathname;
    const tail = path.replace(/^.*\/(?:spaces-api|spaces)\/?/, "");
    if (req.method === "GET") {
      if (!tail)
        return json(
          checked(
            await db()
              .from("spaces")
              .select(LIST)
              .eq("visibility", "public")
              .order("votes", { ascending: false }),
          ),
        );
      const id = uuid.parse(tail.replace(/\/slides$/, ""));
      return json(await slides(id, await authenticate(req)));
    }
    if (req.method !== "POST") return json({ code: "METHOD_NOT_ALLOWED" }, 405);
    const actor = (await authenticate(req))!,
      input = await body(req);
    const action = input.action ?? "upsert",
      payload = input.action ? (input.payload ?? {}) : input,
      force_override = z.boolean().default(false).parse(input.force_override);
    const channel = req.headers
      .get("authorization")
      ?.startsWith("Bearer ntucc_sk_")
      ? "rest_api"
      : "web_ui";
    switch (action) {
      case "upsert":
        return json({
          id: await upsertSpace(
            { ...payload, force_override },
            actor,
            input.action ? channel : "rest_api",
          ),
        });
      case "question":
        return json(
          await question({ ...payload, force_override }, actor, channel),
        );
      case "profile": {
        const p = z
          .object({
            display_name: z.string().min(1).max(80),
            department: z.string().min(1).max(80),
          })
          .parse(payload);
        await guard(p, force_override, actor, channel);
        checked(await db().from("profiles").update(p).eq("id", actor.id));
        return json({ ok: true });
      }
      case "token_create": {
        const token = "ntucc_sk_" + randomBytes(32).toString("hex");
        checked(
          await db()
            .from("user_api_tokens")
            .insert({
              user_id: actor.id,
              token_prefix: token.slice(0, 16),
              token_hash: hashToken(token),
            }),
        );
        return json({ token }, 201);
      }
      case "token_revoke":
        checked(
          await db()
            .from("user_api_tokens")
            .delete()
            .eq("id", uuid.parse(payload.id))
            .eq("user_id", actor.id),
        );
        return json({ ok: true });
      case "vote": {
        const p = z
          .object({
            target_type: z.enum(["space", "qa", "pain_point"]),
            target_id: uuid,
          })
          .parse(payload);
        checked(
          await db().rpc("cast_vote", {
            p_user: actor.id,
            p_type: p.target_type,
            p_target: p.target_id,
          }),
        );
        return json({ ok: true });
      }
      case "vibe": {
        const p = z
          .object({
            space_id: uuid,
            kind: z.enum(["mindblown", "need_this", "pii_safe", "want_link"]),
          })
          .parse(payload);
        checked(
          await db().rpc("add_vibe", {
            p_user: actor.id,
            p_space: p.space_id,
            p_kind: p.kind,
          }),
        );
        return json({ ok: true });
      }
      case "pain": {
        const p = z
          .object({
            title: z.string().min(1).max(160),
            department: z.string().max(80),
            scenario: z.string().min(1).max(3000),
            time_cost: z.string().max(300),
            ideal_outcome: z.string().max(2000),
          })
          .parse(payload);
        await guard(p, force_override, actor, channel);
        return json(
          checked(
            await db()
              .from("pain_points")
              .insert({ ...p, proposer_id: actor.id })
              .select("id")
              .single(),
          ),
          201,
        );
      }
      case "register": {
        const p = z
          .object({
            session_id: uuid,
            meal_preference: z.enum(["葷食", "素食", "不需餐盒"]),
          })
          .parse(payload);
        const session = checked(
          await db()
            .from("meetup_sessions")
            .select("id")
            .eq("id", p.session_id)
            .eq("is_active", true)
            .maybeSingle(),
        );
        if (!session) throw new HttpError(404, "NO_ACTIVE_SESSION");
        checked(
          await db()
            .from("registrations")
            .upsert(
              { ...p, user_id: actor.id },
              { onConflict: "user_id,session_id", ignoreDuplicates: true },
            ),
        );
        return json({ ok: true });
      }
      case "checkin": {
        const p = z
          .object({ session_id: uuid, user_id: uuid.optional() })
          .parse(payload);
        if (p.user_id && p.user_id !== actor.id)
          await staff(actor, p.session_id);
        const active = checked(
          await db()
            .from("meetup_sessions")
            .select("id")
            .eq("id", p.session_id)
            .eq("is_active", true)
            .maybeSingle(),
        );
        if (!active) throw new HttpError(404, "NO_ACTIVE_SESSION");
        const updated = checked(
          await db()
            .from("registrations")
            .update({
              checked_in: true,
              checked_in_at: new Date().toISOString(),
            })
            .eq("session_id", p.session_id)
            .eq("user_id", p.user_id ?? actor.id)
            .select("id")
            .maybeSingle(),
        );
        if (!updated) throw new HttpError(404, "REGISTRATION_NOT_FOUND");
        return json({ ok: true });
      }
      case "resolve": {
        const p = z
          .object({ id: uuid, speaker_reply: z.string().max(2000).default("") })
          .parse(payload);
        await guard(p, force_override, actor, channel);
        const q = checked(
          await db()
            .from("space_qa")
            .select("space_id")
            .eq("id", p.id)
            .single(),
        );
        if (!q) throw new HttpError(404, "QUESTION_NOT_FOUND");
        const s = checked(
          await db()
            .from("spaces")
            .select("owner_id")
            .eq("id", q.space_id)
            .single(),
        );
        if (!s) throw new HttpError(404, "SPACE_NOT_FOUND");
        if (s.owner_id !== actor.id) throw new HttpError(403, "OWNER_REQUIRED");
        checked(
          await db()
            .from("space_qa")
            .update({ is_resolved: true, speaker_reply: p.speaker_reply })
            .eq("id", p.id),
        );
        return json({ ok: true });
      }
      case "announcement": {
        admin(actor);
        const p = z
          .object({
            title: z.string().min(1).max(160),
            category: z.enum(["場地異動", "資安紅線", "教育學分", "活動公告"]),
            content: z.string().min(1).max(5000),
            is_pinned: z.boolean(),
          })
          .parse(payload);
        await guard(p, force_override, actor, channel);
        checked(
          await db()
            .from("announcements")
            .insert({ ...p, author_id: actor.id }),
        );
        return json({ ok: true });
      }
      case "pin": {
        admin(actor);
        const p = z.object({ id: uuid, is_pinned: z.boolean() }).parse(payload);
        checked(
          await db()
            .from("announcements")
            .update({ is_pinned: p.is_pinned })
            .eq("id", p.id),
        );
        return json({ ok: true });
      }
      case "session": {
        admin(actor);
        const p = z
          .object({
            title: z.string().min(1).max(160),
            session_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
            start_time: z.string().regex(/^\d{2}:\d{2}$/),
            location: z.string().max(300),
            credits: z.string().max(300),
          })
          .parse(payload);
        await guard(p, force_override, actor, channel);
        checked(await db().rpc("activate_session", { p_fields: p }));
        return json({ ok: true });
      }
      case "schedule": {
        admin(actor);
        const p = z
          .object({
            id: uuid,
            session_id: uuid,
            slot_order: z.number().int().min(0).max(100),
          })
          .parse(payload);
        checked(
          await db()
            .from("spaces")
            .update({ session_id: p.session_id, slot_order: p.slot_order })
            .eq("id", p.id)
            .eq("visibility", "public"),
        );
        return json({ ok: true });
      }
      case "registrations": {
        await staff(actor, uuid.parse(payload.session_id));
        return json(
          checked(
            await db()
              .from("registrations")
              .select(
                "id,user_id,meal_preference,checked_in,checked_in_at,profiles(display_name,department)",
              )
              .eq("session_id", uuid.parse(payload.session_id)),
          ),
        );
      }
      default:
        throw new HttpError(400, "UNKNOWN_ACTION");
    }
  } catch (e) {
    if (e instanceof z.ZodError)
      return json({ code: "VALIDATION_ERROR", issues: e.flatten() }, 400);
    return fail(e);
  }
};
