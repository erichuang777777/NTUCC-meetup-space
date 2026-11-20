import {
  authenticate,
  admin,
  db,
  requireInteractive,
} from "./shared/auth-helper.js";
import { runEmailDispatch } from "./email-dispatch.js";
import { requireFeature } from "./shared/features.js";
import { fail, HttpError, json } from "./shared/http.js";

/** Admin-only: queue a test email to the caller (max 3/hour, enforced in SQL) and dispatch immediately. */
export default async function handler(req: Request) {
  try {
    if (req.method !== "POST") throw new HttpError(405, "METHOD_NOT_ALLOWED");
    const client = db();
    await requireFeature(client, "email_notifications");
    const actor = (await authenticate(req))!;
    requireInteractive(actor);
    admin(actor);
    const r = await client.rpc("enqueue_test_email", { p_actor: actor.id });
    if (r.error) {
      const m = String(r.error.message ?? "");
      if (m.includes("RATE_LIMITED")) throw new HttpError(429, "RATE_LIMITED");
      if (m.includes("ADMIN_REQUIRED"))
        throw new HttpError(403, "ADMIN_REQUIRED");
      throw new HttpError(400, "DATABASE_ERROR");
    }
    const result = await runEmailDispatch(client);
    return json({ queued: true, ...result });
  } catch (e) {
    return fail(e);
  }
}
