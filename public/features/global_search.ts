import { registerFeature, type FeatureCtx } from "../feature-registry";
import "./global_search.css";

const TYPES: { type: string; label: string }[] = [
  { type: "announcement", label: "公告" },
  { type: "event", label: "活動" },
  { type: "space", label: "展示" },
  { type: "thread", label: "討論" },
  { type: "reply", label: "回覆" },
  { type: "pain_point", label: "痛點" },
  { type: "talk", label: "投稿" },
  { type: "member", label: "同仁" },
];
const label = (t: string) => TYPES.find((x) => x.type === t)?.label ?? t;

type Hit = {
  type: string;
  id: string;
  title: string;
  snippet: string;
  link: string;
  created_at: string;
  score: number;
};

function go(link: string) {
  if (link.startsWith("#")) location.hash = link.slice(1);
}

function open(ctx: FeatureCtx) {
  const client = ctx.client;
  if (!client || document.querySelector(".gs-overlay")) return;
  const ov = document.createElement("div");
  ov.className = "gs-overlay";
  ov.innerHTML = `<div class="gs-panel" role="dialog" aria-modal="true" aria-label="全站搜尋"><input type="search" maxlength="100" placeholder="搜尋公告、活動、展示、討論…（至少 2 個字）" aria-label="搜尋關鍵字"><div class="gs-chips"></div><div class="gs-results" aria-live="polite"></div></div>`;
  const input = ov.querySelector<HTMLInputElement>("input")!;
  const chips = ov.querySelector<HTMLElement>(".gs-chips")!;
  const out = ov.querySelector<HTMLElement>(".gs-results")!;
  const active = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let seq = 0;

  const close = () => {
    clearTimeout(timer);
    seq++;
    document.removeEventListener("keydown", onKey, true);
    ov.remove();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  };
  document.addEventListener("keydown", onKey, true);
  ov.addEventListener("mousedown", (e) => {
    if (e.target === ov) close();
  });

  for (const t of TYPES) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "secondary gs-chip";
    b.textContent = t.label;
    b.setAttribute("aria-pressed", "false");
    b.onclick = () => {
      if (active.has(t.type)) active.delete(t.type);
      else active.add(t.type);
      b.setAttribute("aria-pressed", String(active.has(t.type)));
      void search();
    };
    chips.append(b);
  }

  async function search() {
    clearTimeout(timer);
    const q = input.value.trim();
    const mine = ++seq;
    if (q.length < 2) {
      out.innerHTML = '<p class="muted">請輸入至少 2 個字。</p>';
      return;
    }
    out.innerHTML = '<p class="muted">搜尋中…</p>';
    const { data, error } = await client!.rpc("global_search", {
      p_query: q,
      p_types: active.size ? [...active] : null,
      p_limit: 40,
      p_offset: 0,
    });
    if (mine !== seq) return;
    if (error) {
      out.innerHTML = `<p class="muted">搜尋失敗：${ctx.esc(error.message)}</p>`;
      return;
    }
    const hits = (data ?? []) as Hit[];
    if (!hits.length) {
      out.innerHTML = '<p class="muted">找不到符合的內容。</p>';
      return;
    }
    out.innerHTML = "";
    for (const t of TYPES) {
      const group = hits.filter((h) => h.type === t.type);
      if (!group.length) continue;
      const sec = document.createElement("section");
      sec.className = "gs-group";
      sec.innerHTML = `<h3>${ctx.esc(t.label)}（${group.length}）</h3>`;
      for (const h of group) {
        const a = document.createElement("button");
        a.type = "button";
        a.className = "gs-item";
        a.innerHTML = `<b>${ctx.esc(h.title)}</b><small>${ctx.esc(h.snippet)}</small>`;
        a.setAttribute("aria-label", `${label(h.type)}：${h.title}`);
        a.onclick = () => {
          close();
          go(h.link);
        };
        sec.append(a);
      }
      out.append(sec);
    }
  }

  input.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => void search(), 300);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void search();
    }
  });
  document.body.append(ov);
  input.focus();
}

function topbar(ctx: FeatureCtx): HTMLElement | null {
  if (!ctx.client || !ctx.user || !ctx.profile?.passcode_verified) return null;
  const btn = document.createElement("button");
  btn.className = "secondary gs-btn";
  btn.setAttribute("aria-label", "全站搜尋");
  btn.innerHTML =
    '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>';
  btn.onclick = () => open(ctx);
  return btn;
}

registerFeature({ key: "global_search", topbar });
