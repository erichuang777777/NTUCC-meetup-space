import { z } from "zod";
import { db, authenticate, requireInteractive } from "./shared/auth-helper.js";
import { requireFeature } from "./shared/features.js";
import { body, fail, HttpError, json } from "./shared/http.js";
import { guard } from "./shared/pii-guard.js";

const uuid = z.string().uuid();
const iso = z.iso.datetime({ offset: true });
const requestSchema = z
  .object({
    id: uuid.optional(),
    title: z.string().trim().min(1).max(120),
    description: z.string().max(3000).default(""),
    location: z.string().max(200).default(""),
    starts_at: iso,
    ends_at: iso,
    capacity: z.number().int().min(1).max(10000).nullable().optional(),
    force_override: z.boolean().optional(),
  })
  .strict()
  .refine((e) => Date.parse(e.ends_at) > Date.parse(e.starts_at), "dates");
const reviewSchema = z
  .object({
    decision: z.enum(["approve", "return"]),
    note: z.string().max(1000).optional(),
    publish: z.boolean().default(false),
    public: z.boolean().default(false),
    force_override: z.boolean().optional(),
  })
  .strict();
const revokeSchema = z
  .object({
    note: z.string().max(1000).optional(),
    force_override: z.boolean().optional(),
  })
  .strict();

const STATUS: Record<string, number> = {
  FEATURE_DISABLED: 404,
  MEMBER_REQUIRED: 403,
  ADMIN_REQUIRED: 403,
  REQUEST_NOT_FOUND: 404,
  REQUEST_LOCKED: 409,
  INVALID_STATE: 409,
  EVENT_IN_PAST: 409,
  RATE_LIMITED: 429,
  INVALID_REQUEST: 400,
  INVALID_DECISION: 400,
  NOTE_REQUIRED: 400,
};
function rpcResult(r: { data: any; error: any }) {
  if (!r.error) return r.data;
  const code = Object.keys(STATUS).find((c) =>
    String(r.error.message ?? "").includes(c),
  );
  if (!code) throw new HttpError(400, "DATABASE_ERROR");
  throw new HttpError(STATUS[code], code);
}

/**
 * /api/v1/hosted-events
 *   POST   /                    save (create/edit) a draft or returned request
 *   POST   /:id/submit          submit for review (5 per 30 days)
 *   POST   /:id/cancel          host withdraws a non-approved request
 *   GET    /:id/registrations   host: registrations of THEIR approved event
 *   POST   /:id/review          admin: approve | return
 *   POST   /:id/revoke          admin: unpublish + remove host staff right
 */
export default async function handler(req: Request) {
  try {
    const path = new URL(req.url).pathname
      .replace(/^.*\/hosted-events(?:-api)?\/?/, "")
      .split("/")
      .filter(Boolean);
    const [id, child] = path;
    if (path.length > 2) throw new HttpError(404, "NOT_FOUND");
    if (id && !uuid.safeParse(id).success)
      throw new HttpError(400, "INVALID_ID");
    const client = db();
    await requireFeature(client, "member_hosted_events");
    const actor = (await authenticate(req))!;
    requireInteractive(actor);

    if (!id) {
      if (req.method !== "POST") throw new HttpError(405, "METHOD_NOT_ALLOWED");
      const input = requestSchema.parse(await body(req));
      await guard(
        {
          title: input.title,
          description: input.description,
          location: input.location,
        },
        input.force_override === true,
        actor,
        "web_ui",
      );
      return json(
        rpcResult(
          await client.rpc("save_hosted_event_request", {
            p_actor: actor.id,
            p_id: input.id ?? null,
            p_title: input.title,
            p_description: input.description,
            p_location: input.location,
            p_starts: input.starts_at,
            p_ends: input.ends_at,
            p_capacity: input.capacity ?? null,
          }),
        ),
        input.id ? 200 : 201,
      );
    }
    if (child === "registrations") {
      if (req.method !== "GET") throw new HttpError(405, "METHOD_NOT_ALLOWED");
      const page = z.coerce
        .number()
        .int()
        .min(1)
        .max(200)
        .parse(new URL(req.url).searchParams.get("page") ?? 1);
      return json(
        rpcResult(
          await client.rpc("hosted_event_registrations", {
            p_actor: actor.id,
            p_id: id,
            p_page: page,
          }),
        ),
      );
    }
    if (req.method !== "POST") throw new HttpError(405, "METHOD_NOT_ALLOWED");
    if (child === "submit" || child === "cancel") {
      z.object({})
        .strict()
        .parse(await body(req));
      return json(
        rpcResult(
          await client.rpc(
            child === "submit"
              ? "submit_hosted_event_request"
              : "cancel_hosted_event_request",
            { p_actor: actor.id, p_id: id },
          ),
        ),
      );
    }
    if (child === "review") {
      const input = reviewSchema.parse(await body(req));
      await guard(
        { note: input.note ?? "" },
        input.force_override === true,
        actor,
        "web_ui",
      );
      return json(
        rpcResult(
          await client.rpc("review_hosted_event", {
            p_actor: actor.id,
            p_id: id,
            p_decision: input.decision,
            p_note: input.note ?? null,
            p_publish: input.publish,
            p_public: input.public,
          }),
        ),
      );
    }
    if (child === "revoke") {
      const input = revokeSchema.parse(await body(req));
      await guard(
        { note: input.note ?? "" },
        input.force_override === true,
        actor,
        "web_ui",
      );
      return json(
        rpcResult(
          await client.rpc("revoke_hosted_event", {
            p_actor: actor.id,
            p_id: id,
            p_note: input.note ?? null,
          }),
        ),
      );
    }
    throw new HttpError(404, "NOT_FOUND");
  } catch (e) {
    if (e instanceof z.ZodError) return json({ code: "VALIDATION_ERROR" }, 400);
    return fail(e);
  }
}
