import type { SupabaseClient } from "@supabase/supabase-js";
import { isEnabled } from "./features";

export type PiiReview = (
  payload: any,
) => Promise<{ payload: any; force_override: boolean } | null>;

/** Everything a feature module may need; built fresh by app.ts on each render. */
export type FeatureCtx = {
  client: SupabaseClient | null;
  user: any;
  profile: any;
  /** true when running without Supabase (sample-data preview) */
  demo: boolean;
  isAdmin: boolean;
  esc: (s: unknown) => string;
  toast: (msg: string) => void;
  /** run an async action; failures are shown as a toast */
  run: (fn: () => Promise<any>) => Promise<void>;
  /**
   * PII guard: scans payload (any string/array/object) and, if PII is found,
   * opens the shared #pii dialog. Resolves { payload (possibly masked),
   * force_override } or null when the user cancelled. Same function app.ts
   * uses before every submission.
   */
  review: PiiReview;
  /** switch page (sets location.hash and re-renders) */
  navigate: (page: string) => void;
  isEnabled: (key: string) => boolean;
  /** open the private-messages page with a conversation draft to this user */
  openMessage: (userId: string) => void;
};

export type FeatureDef = {
  key: string;
  nav?: { id: string; label: string; iconPath: string };
  adminPanel?: {
    id: string;
    label: string;
    render: (container: HTMLElement, ctx: FeatureCtx) => void | Promise<void>;
  };
  /** renders the page whose id equals nav.id (or the feature key when no nav) */
  render?: (container: HTMLElement, ctx: FeatureCtx) => void | Promise<void>;
  /** element appended to .top-actions (e.g. a bell); return null for nothing */
  topbar?: (ctx: FeatureCtx) => HTMLElement | null;
};

const features = new Map<string, FeatureDef>();

export function registerFeature(def: FeatureDef) {
  features.set(def.key, def);
}
export function registeredFeatures(): FeatureDef[] {
  return [...features.values()];
}
export function enabledFeatures(): FeatureDef[] {
  return registeredFeatures().filter((f) => isEnabled(f.key));
}
export function featureNavs(): NonNullable<FeatureDef["nav"]>[] {
  return enabledFeatures().flatMap((f) => (f.nav ? [f.nav] : []));
}
/** the enabled feature that owns a page id, if any */
export function featureForPage(page: string): FeatureDef | undefined {
  return enabledFeatures().find(
    (f) => f.render && (f.nav ? f.nav.id === page : f.key === page),
  );
}
export function featureAdminPanels() {
  return enabledFeatures().flatMap((f) =>
    f.adminPanel ? [{ key: f.key, ...f.adminPanel }] : [],
  );
}
export function featureTopbars() {
  return enabledFeatures().flatMap((f) => (f.topbar ? [f.topbar] : []));
}
