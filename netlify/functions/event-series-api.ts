import { z } from "zod";
import {
  db,
  authenticate,
  admin,
  requireInteractive,
} from "./shared/auth-helper.js";
import { requireFeature } from "./shared/features.js";
import { body, fail, HttpError, json } from "./shared/http.js";
import { guard } from "./shared/pii-guard.js";

const uuid = z.string().uuid();
const createSchema = z
  .object({
    title: z.string().trim().min(1).max(80),
    description: z.string().max(1000).default(""),
    slug: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]{1,38}$/)
      .optional(),
    force_override: z.boolean().optional(),
  })
  .strict();
const updateSchema = z
  .object({
    title: z.string().trim().min(1).max(80),
    description: z.string().max(1000).default(""),
    archived: z.boolean().optional(),
    force_override: z.boolean().optional(),
  })
  .strict();

const STATUS: Record<string, number> = {
  FEATURE_DISABLED: 404,
  SERIES_NOT_FOUND: 404,
  ADMIN_REQUIRED: 403,
  SLUG_TAKEN: 409,
  INVALID_SERIES: 400,
  INVALID_SLUG: 400,
};
function rpcResult(r: { data: any; error: any }) {
  if (!r.error) return r.data;
  const code = Object.keys(STATUS).find((c) =>
    String(r.error.message ?? "").includes(c),
  );
  if (!code) throw new HttpError(400, "DATABASE_ERROR");
  throw new HttpError(STATUS[code], code);
}

/** Series create/update (free text => PII guard). Clone/assign are admin RPCs called directly by the UI. */
export default async function handler(req: Request) {
  try {
    const path = new URL(req.url).pathname
      .replace(/^.*\/event-series(?:-api)?\/?/, "")
      .split("/")
      .filter(Boolean);
    if (path.length > 1) throw new HttpError(404, "NOT_FOUND");
    const client = db();
    await requireFeature(client, "event_series");
    const actor = (await authenticate(req))!;
    requireInteractive(actor);
    admin(actor);
    if (!path.length) {
      if (req.method !== "POST") throw new HttpError(405, "METHOD_NOT_ALLOWED");
      const input = createSchema.parse(await body(req));
      await guard(
        [input.title, input.description],
        input.force_override === true,
        actor,
        "web_ui",
      );
      return json(
        rpcResult(
          await client.rpc("create_event_series", {
            p_actor: actor.id,
            p_title: input.title,
            p_description: input.description,
            p_slug: input.slug ?? null,
          }),
        ),
        201,
      );
    }
    if (!uuid.safeParse(path[0]).success)
      throw new HttpError(400, "INVALID_ID");
    if (req.method !== "PUT") throw new HttpError(405, "METHOD_NOT_ALLOWED");
    const input = updateSchema.parse(await body(req));
    await guard(
      [input.title, input.description],
      input.force_override === true,
      actor,
      "web_ui",
    );
    return json(
      rpcResult(
        await client.rpc("update_event_series", {
          p_actor: actor.id,
          p_id: path[0],
          p_title: input.title,
          p_description: input.description,
          p_archived: input.archived ?? null,
        }),
      ),
    );
  } catch (e) {
    if (e instanceof z.ZodError) return json({ code: "VALIDATION_ERROR" }, 400);
    return fail(e);
  }
}
