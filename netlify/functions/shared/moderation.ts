import { HttpError } from "./http.js";
import { isFeatureEnabled } from "./features.js";

export type ModerationType = "thread" | "reply" | "qa" | "pain_point" | "space";

type Db = {
  rpc: (
    fn: string,
    args?: Record<string, unknown>,
  ) => PromiseLike<{ data: any; error: any }>;
};

/**
 * Server functions read with the service role, which bypasses RLS, so content
 * hidden by `content_reports` moderation must be filtered here. A no-op (and no
 * extra query beyond the cached flag lookup) while the flag is off. Authors and
 * admins keep seeing their own / all content, same as the RLS policies.
 */
export async function hiddenIds(
  db: Db,
  viewerId: string,
  type: ModerationType,
  ids: string[],
): Promise<Set<string>> {
  if (!ids.length || !(await isFeatureEnabled(db, "content_reports")))
    return new Set();
  const { data, error } = await db.rpc("moderation_hidden_ids", {
    p_type: type,
    p_ids: [...new Set(ids)],
    p_viewer: viewerId,
  });
  if (error) throw new HttpError(503, "MODERATION_UNAVAILABLE");
  return new Set((data ?? []) as string[]);
}

export async function filterHidden<T>(
  db: Db,
  viewerId: string,
  type: ModerationType,
  rows: T[] | null | undefined,
): Promise<T[]> {
  const list = rows ?? [];
  const hidden = await hiddenIds(
    db,
    viewerId,
    type,
    list.map((r) => (r as { id: string }).id),
  );
  return hidden.size
    ? list.filter((r) => !hidden.has((r as { id: string }).id))
    : list;
}

export async function isHidden(
  db: Db,
  viewerId: string,
  type: ModerationType,
  id: string,
): Promise<boolean> {
  return (await hiddenIds(db, viewerId, type, [id])).has(id);
}
