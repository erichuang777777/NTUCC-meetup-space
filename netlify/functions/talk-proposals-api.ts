import { z } from "zod";
import { db, authenticate, requireInteractive } from "./shared/auth-helper.js";
import { requireFeature } from "./shared/features.js";
import { body, fail, HttpError, json } from "./shared/http.js";
import { guard } from "./shared/pii-guard.js";

const uuid = z.string().uuid();
const proposalSchema = z
  .object({
    title: z.string().trim().min(1).max(120),
    abstract: z.string().trim().min(1).max(1500),
    category_tag: z.enum(["實戰展示", "踩坑避雷"]),
    duration_minutes: z.union([
      z.literal(5),
      z.literal(10),
      z.literal(15),
      z.literal(20),
    ]),
    preferred_event_id: uuid.nullable().optional(),
    pain_point_id: uuid.nullable().optional(),
    submit: z.boolean().optional(),
    force_override: z.boolean().optional(),
  })
  .strict();
const emptySchema = z
  .object({ force_override: z.boolean().optional() })
  .strict();

const STATUS: Record<string, number> = {
  FEATURE_DISABLED: 404,
  PROPOSAL_NOT_FOUND: 404,
  EVENT_NOT_FOUND: 404,
  PAIN_POINT_NOT_FOUND: 404,
  MEMBER_REQUIRED: 403,
  NOT_EDITABLE: 409,
  INVALID_TRANSITION: 409,
  INVALID_PROPOSAL: 400,
};
function rpcResult(r: { data: any; error: any }) {
  if (!r.error) return r.data;
  const code = Object.keys(STATUS).find((c) =>
    String(r.error.message ?? "").includes(c),
  );
  if (!code) throw new HttpError(400, "DATABASE_ERROR");
  throw new HttpError(STATUS[code], code);
}

export default async function handler(req: Request) {
  try {
    const path = new URL(req.url).pathname
      .replace(/^.*\/talk-proposals(?:-api)?\/?/, "")
      .split("/")
      .filter(Boolean);
    const [id, action] = path;
    if (
      path.length > 2 ||
      (action && action !== "submit" && action !== "withdraw")
    )
      throw new HttpError(404, "NOT_FOUND");
    if (id && !uuid.safeParse(id).success)
      throw new HttpError(400, "INVALID_ID");
    const client = db();
    await requireFeature(client, "talk_proposals");
    const actor = (await authenticate(req))!;
    requireInteractive(actor);

    if (action) {
      if (req.method !== "POST") throw new HttpError(405, "METHOD_NOT_ALLOWED");
      emptySchema.parse(await body(req).catch(() => ({})));
      return json(
        rpcResult(
          await client.rpc(
            action === "submit"
              ? "submit_talk_proposal"
              : "withdraw_talk_proposal",
            { p_actor: actor.id, p_id: id },
          ),
        ),
      );
    }
    if (id ? req.method !== "PUT" : req.method !== "POST")
      throw new HttpError(405, "METHOD_NOT_ALLOWED");
    const input = proposalSchema.parse(await body(req));
    // title and abstract are free text shown to admins and (once accepted) to members
    await guard(
      { title: input.title, abstract: input.abstract },
      input.force_override === true,
      actor,
      "web_ui",
    );
    let row = rpcResult(
      await client.rpc("upsert_talk_proposal", {
        p_actor: actor.id,
        p_id: id ?? null,
        p_title: input.title,
        p_abstract: input.abstract,
        p_category: input.category_tag,
        p_duration: input.duration_minutes,
        p_preferred_event: input.preferred_event_id ?? null,
        p_pain: input.pain_point_id ?? null,
      }),
    );
    if (input.submit)
      row = rpcResult(
        await client.rpc("submit_talk_proposal", {
          p_actor: actor.id,
          p_id: row.id,
        }),
      );
    return json(row, id ? 200 : 201);
  } catch (e) {
    if (e instanceof z.ZodError) return json({ code: "VALIDATION_ERROR" }, 400);
    return fail(e);
  }
}
