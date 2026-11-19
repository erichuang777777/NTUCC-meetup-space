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
const questionSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9_-]{1,40}$/),
    type: z.enum(["rating", "single", "text"]),
    label: z.string().trim().min(1).max(200),
    options: z.array(z.string().trim().min(1).max(100)).max(10).optional(),
    required: z.boolean().optional(),
  })
  .strict();
const formSchema = z
  .object({
    questions: z.array(questionSchema).min(1).max(15),
    opens_at: z.iso.datetime({ offset: true }).nullable().optional(),
    closes_at: z.iso.datetime({ offset: true }),
    is_anonymous: z.boolean().default(false),
    force_override: z.boolean().optional(),
  })
  .strict();
const submitSchema = z
  .object({
    answers: z.record(
      z.string().max(40),
      z.union([z.number(), z.string().max(2000), z.null()]),
    ),
    force_override: z.boolean().optional(),
  })
  .strict();

const STATUS: Record<string, number> = {
  FEATURE_DISABLED: 404,
  FEEDBACK_UNAVAILABLE: 404,
  FORM_NOT_FOUND: 404,
  EVENT_NOT_FOUND: 404,
  NOT_ELIGIBLE: 403,
  ADMIN_REQUIRED: 403,
  FEEDBACK_NOT_OPEN: 409,
  FEEDBACK_CLOSED: 409,
  ALREADY_SUBMITTED: 409,
  FORM_LOCKED: 409,
  INVALID_ANSWERS: 400,
  INVALID_QUESTIONS: 400,
  INVALID_WINDOW: 400,
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
      .replace(/^.*\/event-feedback(?:-api)?\/?/, "")
      .split("/")
      .filter(Boolean);
    const [eventId, child] = path;
    if (!eventId || path.length > 2 || (child && child !== "form"))
      throw new HttpError(404, "NOT_FOUND");
    if (!uuid.safeParse(eventId).success)
      throw new HttpError(400, "INVALID_ID");
    const client = db();
    await requireFeature(client, "event_feedback");
    const actor = (await authenticate(req))!;
    requireInteractive(actor);
    if (child === "form") {
      if (req.method !== "PUT") throw new HttpError(405, "METHOD_NOT_ALLOWED");
      admin(actor);
      const input = formSchema.parse(await body(req));
      // question labels and options are free text shown to members
      await guard(
        input.questions.map((q) => [q.label, q.options ?? []]),
        input.force_override === true,
        actor,
        "web_ui",
      );
      return json(
        rpcResult(
          await client.rpc("upsert_event_feedback_form", {
            p_actor: actor.id,
            p_event: eventId,
            p_questions: input.questions,
            p_opens: input.opens_at ?? null,
            p_closes: input.closes_at,
            p_anonymous: input.is_anonymous,
          }),
        ),
      );
    }
    if (req.method !== "POST") throw new HttpError(405, "METHOD_NOT_ALLOWED");
    const input = submitSchema.parse(await body(req));
    // only text answers can carry PII, but scanning everything is cheap and safe
    await guard(input.answers, input.force_override === true, actor, "web_ui");
    const answers = Object.fromEntries(
      Object.entries(input.answers).filter(([, v]) => v !== null),
    );
    return json(
      rpcResult(
        await client.rpc("submit_event_feedback", {
          p_user: actor.id,
          p_event: eventId,
          p_answers: answers,
        }),
      ),
      201,
    );
  } catch (e) {
    if (e instanceof z.ZodError) return json({ code: "VALIDATION_ERROR" }, 400);
    return fail(e);
  }
}
