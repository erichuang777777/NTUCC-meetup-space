import { scanValue } from "../../../public/pii.js";
import { db, type Actor } from "./auth-helper.js";
import { HttpError, checked } from "./http.js";
export async function guard(
  value: unknown,
  override: boolean,
  actor: Actor,
  channel: "web_ui" | "rest_api" | "mcp_server",
) {
  const found = scanValue(value);
  if (!found.length) return;
  if (!override)
    throw new HttpError(422, "PII_DETECTED", { detected_items: found });
  checked(
    await db()
      .from("pii_override_logs")
      .insert({
        user_id: actor.id,
        source_channel: channel,
        matched_types: [...new Set(found.map((x) => x.type))],
      }),
  );
}
