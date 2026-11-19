import { HttpError } from "./http.js";

type Rpc = {
  rpc: (
    fn: string,
    args?: Record<string, unknown>,
  ) => PromiseLike<{ data: any; error: any }>;
};

const TTL_MS = 15_000;
const cache = new Map<string, { value: boolean; at: number }>();

export function clearFeatureCache() {
  cache.clear();
}

/** Unknown keys and any RPC failure resolve to false (fail closed). */
export async function isFeatureEnabled(
  db: Rpc,
  key: string,
  now = Date.now(),
): Promise<boolean> {
  const hit = cache.get(key);
  if (hit && now - hit.at < TTL_MS) return hit.value;
  const { data, error } = await db.rpc("is_feature_enabled", { p_key: key });
  if (error) return false;
  const value = data === true;
  cache.set(key, { value, at: now });
  return value;
}

/** Throws HttpError(404, FEATURE_DISABLED); `fail()` renders { code, feature }. */
export async function requireFeature(db: Rpc, key: string): Promise<void> {
  if (!(await isFeatureEnabled(db, key)))
    throw new HttpError(404, "FEATURE_DISABLED", { feature: key });
}
