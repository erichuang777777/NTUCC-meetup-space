import { z } from "zod";
import { db, type Actor } from "./auth-helper.js";
import { checked, HttpError } from "./http.js";
import { guard } from "./pii-guard.js";
const uuid = z.string().uuid();
const createSchema = z.object({
  space_id: uuid,
  title: z.string().trim().min(1).max(160),
  body: z.string().trim().min(1).max(6000),
  kind: z.enum(["question", "experience", "resource"]),
});
const replySchema = z.object({
  thread_id: uuid,
  body: z.string().trim().min(1).max(6000),
});
async function publicSpace(id: string) {
  const s = checked(
    await db()
      .from("spaces")
      .select("id,owner_id")
      .eq("id", id)
      .eq("visibility", "public")
      .maybeSingle(),
  );
  if (!s) throw new HttpError(404, "SPACE_NOT_FOUND");
  return s;
}
async function thread(id: string) {
  const t = checked(
    await db()
      .from("discussion_threads")
      .select("id,space_id,is_hidden")
      .eq("id", id)
      .maybeSingle(),
  );
  if (!t || t.is_hidden) throw new HttpError(404, "THREAD_NOT_FOUND");
  return t;
}
export async function discussionAction(
  action: string,
  payload: unknown,
  override: boolean,
  actor: Actor,
  channel: "web_ui" | "rest_api",
) {
  if (action === "thread_create") {
    const p = createSchema.parse(payload);
    await publicSpace(p.space_id);
    await guard({ title: p.title, body: p.body }, override, actor, channel);
    if (
      !checked(
        await db().rpc("consume_quota", {
          p_user: actor.id,
          p_action: "discussion",
          p_limit: 40,
        }),
      )
    )
      throw new HttpError(429, "RATE_LIMITED");
    return checked(
      await db()
        .from("discussion_threads")
        .insert({ ...p, author_id: actor.id })
        .select("id")
        .single(),
    );
  }
  if (action === "thread_reply") {
    const p = replySchema.parse(payload);
    const t = await thread(p.thread_id);
    await publicSpace(t.space_id);
    await guard(p.body, override, actor, channel);
    if (
      !checked(
        await db().rpc("consume_quota", {
          p_user: actor.id,
          p_action: "discussion",
          p_limit: 40,
        }),
      )
    )
      throw new HttpError(429, "RATE_LIMITED");
    return checked(
      await db()
        .from("discussion_replies")
        .insert({ ...p, author_id: actor.id })
        .select("id")
        .single(),
    );
  }
  const p = z
    .object({
      thread_id: uuid,
      operation: z.enum(["pin", "resolve", "hide_thread", "hide_reply"]),
      value: z.boolean(),
      reply_id: uuid.optional(),
    })
    .parse(payload);
  const t = await thread(p.thread_id),
    s = await publicSpace(t.space_id);
  if (s.owner_id !== actor.id && actor.role !== "admin")
    throw new HttpError(403, "MODERATOR_REQUIRED");
  if (p.operation === "hide_reply") {
    if (!p.reply_id) throw new HttpError(400, "REPLY_ID_REQUIRED");
    const result = checked(
      await db()
        .from("discussion_replies")
        .update({ is_hidden: p.value })
        .eq("id", p.reply_id)
        .eq("thread_id", p.thread_id)
        .select("id")
        .maybeSingle(),
    );
    if (!result) throw new HttpError(404, "REPLY_NOT_FOUND");
    return result;
  }
  const column = {
    pin: "is_pinned",
    resolve: "is_resolved",
    hide_thread: "is_hidden",
  }[p.operation];
  return checked(
    await db()
      .from("discussion_threads")
      .update({ [column]: p.value })
      .eq("id", p.thread_id)
      .select("id")
      .single(),
  );
}
