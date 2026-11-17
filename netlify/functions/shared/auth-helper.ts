import { createClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import { HttpError, checked } from "./http.js";
export function db() {
  const url = process.env.SUPABASE_URL,
    key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new HttpError(503, "SERVER_NOT_CONFIGURED");
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
export const hashToken = (token: string) =>
  createHash("sha256").update(token).digest("hex");
export type Actor = {
  id: string;
  role: string;
  passcode_verified: boolean;
  scopes?: string[];
};
export function requireScope(actor: Actor, scope: string) {
  if (actor.scopes && !actor.scopes.includes(scope))
    throw new HttpError(403, "TOKEN_SCOPE_REQUIRED", { required_scope: scope });
}
export function requireInteractive(actor: Actor) {
  if (actor.scopes) throw new HttpError(403, "INTERACTIVE_LOGIN_REQUIRED");
}
export async function authenticate(
  req: Request,
  required = true,
): Promise<Actor | null> {
  const token = req.headers.get("authorization")?.match(/^Bearer (\S+)$/i)?.[1];
  if (!token) {
    if (required) throw new HttpError(401, "AUTH_REQUIRED");
    return null;
  }
  const client = db();
  let id: string;
  let scopes: string[] | undefined;
  if (token.startsWith("ntucc_sk_")) {
    const entry = checked(
      await client
        .from("user_api_tokens")
        .select("id,user_id,scopes")
        .eq("token_hash", hashToken(token))
        .maybeSingle(),
    );
    if (!entry) throw new HttpError(401, "INVALID_TOKEN");
    id = entry.user_id;
    if (!Array.isArray(entry.scopes))
      throw new HttpError(403, "TOKEN_SCOPE_REQUIRED");
    scopes = entry.scopes;
    checked(
      await client
        .from("user_api_tokens")
        .update({ last_used_at: new Date().toISOString() })
        .eq("id", entry.id),
    );
  } else {
    const { data, error } = await client.auth.getUser(token);
    if (error || !data.user) throw new HttpError(401, "INVALID_TOKEN");
    id = data.user.id;
  }
  const profile = checked(
    await client
      .from("profiles")
      .select("id,role,passcode_verified")
      .eq("id", id)
      .single(),
  ) as Actor;
  if (!profile.passcode_verified) throw new HttpError(403, "PASSCODE_REQUIRED");
  return { ...profile, scopes };
}
export function admin(actor: Actor) {
  if (actor.role !== "admin") throw new HttpError(403, "ADMIN_REQUIRED");
}
