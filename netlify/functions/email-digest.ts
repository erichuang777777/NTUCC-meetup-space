import { db } from "./shared/auth-helper.js";
import { requireFeature } from "./shared/features.js";
import { fail, json } from "./shared/http.js";

type Client = Parameters<typeof requireFeature>[0];

/** Builds one digest per daily-mode member; idempotent (SQL tracks digested notifications). */
export async function runEmailDigest(client: Client, now = new Date()) {
  await requireFeature(client, "email_notifications");
  const { data, error } = await client.rpc("build_email_digests", {
    p_now: now.toISOString(),
  });
  if (error) throw new Error("DIGEST_FAILED");
  return { digests: Number(data ?? 0) };
}

export default async () => {
  try {
    return json(await runEmailDigest(db()));
  } catch (e) {
    return fail(e);
  }
};

// 00:17 UTC = 08:17 Asia/Taipei
export const config = { schedule: "17 0 * * *" };
