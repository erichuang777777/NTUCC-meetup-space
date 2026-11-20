import { authenticate } from "./auth-helper.js";

/**
 * True only for a request carrying a valid interactive login of a verified member.
 * Members-only events (audience = 'members', F10) are shown to these viewers and hidden from everyone else.
 * Never throws: bad/missing credentials simply mean "public viewer".
 */
export async function isMemberViewer(req: Request): Promise<boolean> {
  if (!req.headers.get("authorization")) return false;
  try {
    const actor = await authenticate(req, false);
    return !!actor && !actor.scopes;
  } catch {
    return false;
  }
}
