import type { SupabaseClient } from "@supabase/supabase-js";

export type FeatureFlag = {
  key: string;
  enabled: boolean;
  label: string;
  description: string | null;
  updated_by: string | null;
  updated_at: string | null;
};

let flags: FeatureFlag[] = [];
let byKey = new Map<string, boolean>();
// DEMO ONLY: with no Supabase client (local preview with sample data) every
// flag is treated as enabled so unfinished features can be previewed.
// This is never true when a client exists, so production stays flag-gated.
let demoAll = false;

/** Fails closed: if the table is missing (013 not applied) or unreadable, all flags are off. */
export async function loadFeatureFlags(
  client: SupabaseClient | null,
): Promise<void> {
  if (!client) {
    demoAll = true;
    flags = [];
    byKey = new Map();
    return;
  }
  demoAll = false;
  try {
    const { data, error } = await client
      .from("feature_flags")
      .select("key,enabled,label,description,updated_by,updated_at")
      .order("key");
    if (error) throw error;
    flags = (data ?? []) as FeatureFlag[];
  } catch {
    flags = [];
  }
  byKey = new Map(flags.map((f) => [f.key, f.enabled]));
}

export function isEnabled(key: string): boolean {
  return demoAll || byKey.get(key) === true;
}

export function allFlags(): FeatureFlag[] {
  return flags;
}

export function isDemoFlags(): boolean {
  return demoAll;
}
