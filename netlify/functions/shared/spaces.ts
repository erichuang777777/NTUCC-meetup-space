import { z } from "zod";
import { parse } from "parse5";
import { db, type Actor } from "./auth-helper.js";
import { HttpError, checked } from "./http.js";
import { guard } from "./pii-guard.js";
export const LIST =
  "id,owner_id,title,category_tag,summary,highlights,slide_count,reference_links,has_cover,votes,vibe_counts,slot_order,session_id,visibility,created_at";
export function slideCount(html: string) {
  let count = 0;
  const visit = (n: any) => {
    const a = n.attrs ?? [];
    if (
      n.tagName &&
      (a.some((a: any) => a.name === "data-slide") ||
        (n.tagName === "section" &&
          a.some(
            (a: any) =>
              a.name === "class" && a.value.split(/\s+/).includes("slide"),
          )))
    )
      count++;
    for (const c of n.childNodes ?? []) visit(c);
  };
  visit(parse(html));
  return count;
}
const link = z.object({
  label: z.enum(["工具官網", "Prompt 範本", "開源專案", "臨床指引"]),
  title: z.string().min(1).max(120),
  url: z
    .string()
    .url()
    .refine((v) => new URL(v).protocol === "https:", "僅允許 HTTPS"),
});
export const spaceSchema = z
  .object({
    id: z.string().uuid().optional(),
    title: z.string().min(1).max(160),
    summary: z.string().min(1).max(3000),
    category_tag: z.enum(["實戰展示", "踩坑避雷"]).default("實戰展示"),
    highlights: z.array(z.string().max(300)).max(8).default([]),
    visibility: z.enum(["private", "public"]).default("private"),
    html_slides: z.string().max(1_500_000).optional(),
    reference_links: z.array(link).max(20).default([]),
    cover_image: z
      .string()
      .max(220000)
      .regex(/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/)
      .nullable()
      .optional(),
    force_override: z.boolean().default(false),
  })
  .strict();
export async function upsertSpace(
  raw: unknown,
  actor: Actor,
  channel: "web_ui" | "rest_api" | "mcp_server",
) {
  const parsed = spaceSchema.safeParse(raw);
  if (!parsed.success)
    throw new HttpError(400, "INVALID_SPACE", {
      issues: parsed.error.flatten(),
    });
  const { id, html_slides, force_override, ...fields } = parsed.data;
  let count: number | undefined;
  if (html_slides !== undefined) {
    count = slideCount(html_slides);
    if (count < 10 || count > 15)
      throw new HttpError(422, "SLIDE_COUNT_INVALID", { slide_count: count });
  }
  await guard(fields, force_override, actor, channel);
  if (html_slides !== undefined)
    await guard(html_slides, force_override, actor, channel);
  // Transactional RPC enforces ownership and stores HTML separately from public metadata.
  return checked(
    await db().rpc("save_space", {
      p_id: id ?? null,
      p_owner: actor.id,
      p_fields: fields,
      p_html: html_slides ?? null,
      p_count: count ?? null,
    }),
  );
}
export async function question(
  raw: unknown,
  actor: Actor,
  channel: "web_ui" | "rest_api" | "mcp_server",
) {
  const p = z
    .object({
      space_id: z.string().uuid(),
      question_text: z.string().min(1).max(2000),
      is_anonymous: z.boolean().default(false),
      cover_image: z
        .string()
        .max(220000)
        .regex(/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/)
        .nullable()
        .optional(),
      force_override: z.boolean().default(false),
    })
    .parse(raw);
  await guard(p.question_text, p.force_override, actor, channel);
  const client = db();
  const space = checked(
    await client
      .from("spaces")
      .select("id")
      .eq("id", p.space_id)
      .eq("visibility", "public")
      .maybeSingle(),
  );
  if (!space) throw new HttpError(404, "SPACE_NOT_FOUND");
  return checked(
    await client
      .from("space_qa")
      .insert({
        space_id: p.space_id,
        question_text: p.question_text,
        is_anonymous: p.is_anonymous,
        author_id: actor.id,
      })
      .select("id")
      .single(),
  );
}
export async function slides(id: string, actor: Actor | null) {
  if (!actor) throw new HttpError(401, "AUTH_REQUIRED");
  const client = db();
  const s = checked(
    await client
      .from("spaces")
      .select("owner_id,visibility")
      .eq("id", id)
      .maybeSingle(),
  );
  if (!s || (s.owner_id !== actor.id && s.visibility !== "public"))
    throw new HttpError(404, "SPACE_NOT_FOUND");
  return checked(
    await client
      .from("space_slides")
      .select("html_slides")
      .eq("space_id", id)
      .maybeSingle(),
  );
}
