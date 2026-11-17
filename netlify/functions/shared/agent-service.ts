import { z } from "zod";
import { db, requireScope, type Actor } from "./auth-helper.js";
import { checked, HttpError } from "./http.js";
import { guard } from "./pii-guard.js";
import { LIST } from "./spaces.js";
export const paging = z.object({
  offset: z.coerce.number().int().min(0).max(100000).default(0),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
const uuid = z.string().uuid();
export const PROJECT_LIST =
  LIST + ",owner:profiles!spaces_owner_id_fkey(display_name,department)";
export async function listProjects(actor: Actor, input: unknown) {
  requireScope(actor, "projects:read");
  const p = paging
    .extend({
      query: z.string().max(100).default(""),
      mine: z.boolean().default(false),
    })
    .parse(input);
  let q = db().from("spaces").select(PROJECT_LIST, { count: "exact" });
  q = p.mine ? q.eq("owner_id", actor.id) : q.eq("visibility", "public");
  if (p.query) q = q.ilike("title", "%" + p.query.replace(/[%_]/g, "") + "%");
  const r = await q
    .order("created_at", { ascending: false })
    .order("id")
    .range(p.offset, p.offset + p.limit - 1);
  return {
    projects: checked(r),
    total: r.count,
    offset: p.offset,
    limit: p.limit,
  };
}
export async function getProject(actor: Actor, id: string) {
  requireScope(actor, "projects:read");
  const s: any = checked(
    await db()
      .from("spaces")
      .select(PROJECT_LIST)
      .eq("id", uuid.parse(id))
      .maybeSingle(),
  );
  if (!s || (s.visibility !== "public" && s.owner_id !== actor.id))
    throw new HttpError(404, "PROJECT_NOT_FOUND");
  return s;
}
export async function listDiscussions(
  actor: Actor,
  spaceId: string,
  input: unknown,
) {
  requireScope(actor, "discussions:read");
  await getProject(actor, spaceId);
  const p = paging
    .extend({ kind: z.enum(["question", "experience", "resource"]).optional() })
    .parse(input);
  let q = db()
    .from("discussion_threads_read")
    .select(
      "id,space_id,title,kind,author_id,author_name,is_pinned,is_resolved,reply_count,created_at,last_activity_at",
      { count: "exact" },
    )
    .eq("space_id", spaceId);
  if (p.kind) q = q.eq("kind", p.kind);
  const r = await q
    .order("is_pinned", { ascending: false })
    .order("last_activity_at", { ascending: false })
    .order("id")
    .range(p.offset, p.offset + p.limit - 1);
  return {
    threads: checked(r),
    total: r.count,
    offset: p.offset,
    limit: p.limit,
  };
}
export async function readDiscussion(actor: Actor, id: string, input: unknown) {
  requireScope(actor, "discussions:read");
  const p = paging.parse(input);
  const t = checked(
    await db()
      .from("discussion_threads_read")
      .select(
        "id,space_id,title,body,kind,author_id,author_name,is_pinned,is_resolved,created_at",
      )
      .eq("id", uuid.parse(id))
      .maybeSingle(),
  );
  if (!t) throw new HttpError(404, "THREAD_NOT_FOUND");
  await getProject(actor, t.space_id);
  const r = await db()
    .from("discussion_replies_read")
    .select("id,thread_id,author_id,author_name,body,created_at", {
      count: "exact",
    })
    .eq("thread_id", id)
    .order("created_at")
    .order("id")
    .range(p.offset, p.offset + p.limit - 1);
  return {
    thread: t,
    replies: checked(r),
    total: r.count,
    offset: p.offset,
    limit: p.limit,
  };
}
export async function memberProfile(actor: Actor, id: string) {
  requireScope(actor, "projects:read");
  const p = checked(
    await db()
      .from("profiles")
      .select("id,display_name,department,accepts_messages")
      .eq("id", uuid.parse(id))
      .eq("passcode_verified", true)
      .maybeSingle(),
  );
  if (!p) throw new HttpError(404, "MEMBER_NOT_FOUND");
  return {
    id: p.id,
    display_name: p.display_name,
    department: p.department,
    accepts_messages: p.accepts_messages,
  };
}
const CONVERSATION =
  "id,member_low,member_high,last_message_at,low:profiles!private_conversations_member_low_fkey(id,display_name,department),high:profiles!private_conversations_member_high_fkey(id,display_name,department)";
function present(c: any, actor: Actor) {
  const peer = c.member_low === actor.id ? c.high : c.low;
  return {
    id: c.id,
    last_message_at: c.last_message_at,
    other: {
      id: peer.id,
      display_name: peer.display_name,
      department: peer.department,
    },
  };
}
export async function inbox(actor: Actor, input: unknown) {
  requireScope(actor, "messages:read");
  const p = paging.parse(input);
  const r = await db()
    .from("private_conversations")
    .select(CONVERSATION, { count: "exact" })
    .or(`member_low.eq.${actor.id},member_high.eq.${actor.id}`)
    .order("last_message_at", { ascending: false })
    .order("id")
    .range(p.offset, p.offset + p.limit - 1);
  return {
    conversations: (checked(r) ?? []).map((c: any) => present(c, actor)),
    total: r.count,
    offset: p.offset,
    limit: p.limit,
  };
}
export async function conversationMessages(
  actor: Actor,
  id: string,
  input: unknown,
) {
  requireScope(actor, "messages:read");
  const p = paging.parse(input);
  const c = checked(
    await db()
      .from("private_conversations")
      .select(CONVERSATION)
      .eq("id", uuid.parse(id))
      .maybeSingle(),
  );
  if (!c || ![c.member_low, c.member_high].includes(actor.id))
    throw new HttpError(404, "CONVERSATION_NOT_FOUND");
  const r = await db()
    .from("private_messages")
    .select("id,conversation_id,sender_id,body,project_id,created_at", {
      count: "exact",
    })
    .eq("conversation_id", id)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .range(p.offset, p.offset + p.limit - 1);
  return {
    conversation: present(c, actor),
    messages: checked(r),
    total: r.count,
    offset: p.offset,
    limit: p.limit,
  };
}
export const messageSchema = z
  .object({
    recipient_id: uuid,
    body: z.string().trim().min(1).max(6000),
    project_id: uuid.optional(),
    client_request_id: uuid.optional(),
    force_override: z.boolean().default(false),
  })
  .strict();
export async function sendMessage(
  actor: Actor,
  input: unknown,
  channel: "web_ui" | "rest_api" | "mcp_server",
) {
  requireScope(actor, "messages:write");
  const p = messageSchema.parse(input);
  await guard(p.body, p.force_override, actor, channel);
  const r = await db().rpc("send_private_message", {
    p_sender: actor.id,
    p_recipient: p.recipient_id,
    p_body: p.body,
    p_project: p.project_id ?? null,
    p_request: p.client_request_id ?? null,
  });
  if (r.error) {
    const code = String(r.error.message);
    if (r.error.code === "23505")
      throw new HttpError(409, "IDEMPOTENCY_CONFLICT");
    if (code.includes("RATE_LIMITED")) throw new HttpError(429, "RATE_LIMITED");
    if (code.includes("IDEMPOTENCY_CONFLICT"))
      throw new HttpError(409, "IDEMPOTENCY_CONFLICT");
    if (code.includes("PROJECT_NOT_FOUND"))
      throw new HttpError(404, "PROJECT_NOT_FOUND");
    if (code.includes("CONTACT_UNAVAILABLE"))
      throw new HttpError(403, "CONTACT_UNAVAILABLE");
    throw new HttpError(400, "MESSAGE_FAILED");
  }
  return r.data;
}
export async function contactSettings(actor: Actor) {
  requireScope(actor, "messages:read");
  const preference = checked(
    await db()
      .from("profiles")
      .select("accepts_messages")
      .eq("id", actor.id)
      .single(),
  );
  const blocks = checked(
    await db()
      .from("contact_blocks")
      .select(
        "blocked_user_id,member:profiles!contact_blocks_blocked_user_id_fkey(display_name,department)",
      )
      .eq("owner_id", actor.id),
  );
  return {
    ...preference,
    blocked_user_ids: (blocks ?? []).map((b: any) => b.blocked_user_id),
    blocked_members: (blocks ?? []).map((b: any) => ({
      user_id: b.blocked_user_id,
      display_name: b.member?.display_name ?? "同仁",
      department: b.member?.department ?? "",
    })),
  };
}
export async function setPreference(actor: Actor, input: unknown) {
  requireScope(actor, "messages:write");
  const p = z.object({ accepts_messages: z.boolean() }).strict().parse(input);
  checked(await db().from("profiles").update(p).eq("id", actor.id));
  return p;
}
export async function blockMember(actor: Actor, input: unknown) {
  requireScope(actor, "messages:write");
  const p = z
    .object({ user_id: uuid, blocked: z.boolean() })
    .strict()
    .parse(input);
  const r = await db().rpc("set_contact_block", {
    p_owner: actor.id,
    p_target: p.user_id,
    p_blocked: p.blocked,
  });
  if (r.error) throw new HttpError(400, "CONTACT_UNAVAILABLE");
  return { ok: true };
}
