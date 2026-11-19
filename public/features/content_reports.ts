import { registerFeature, type FeatureCtx } from "../feature-registry";
import { isEnabled } from "../features";
import "./content_reports.css";

export type ReportTarget = "thread" | "reply" | "qa" | "pain_point" | "space";

const TYPE_LABEL: Record<string, string> = {
  thread: "討論主題",
  reply: "討論回覆",
  qa: "問答",
  pain_point: "痛點",
  space: "展示",
};
const REASONS: [string, string][] = [
  ["pii", "含有個資或病人資訊"],
  ["harassment", "騷擾或不當言論"],
  ["spam", "垃圾或洗版內容"],
  ["incorrect", "資訊錯誤或誤導"],
  ["other", "其他"],
];
const REASON_LABEL = Object.fromEntries(REASONS);
const ERRORS: Record<string, string> = {
  ALREADY_REPORTED: "您已檢舉過這則內容，管理員處理中",
  REPORT_RATE_LIMITED: "今日檢舉次數已達上限（20 次）",
  CANNOT_REPORT_OWN: "無法檢舉自己的內容",
  TARGET_NOT_FOUND: "找不到這則內容，可能已被移除",
  PII_DETECTED: "說明中含有個資，請移除後再送出",
  FEATURE_DISABLED: "檢舉功能目前未開放",
  MEMBER_REQUIRED: "請先完成同仁驗證",
  ADMIN_REQUIRED: "需要管理員權限",
  ALREADY_RESOLVED: "此檢舉已被處理",
};
const friendly = (m: string) => ERRORS[m] ?? m ?? "操作失敗";
const escAttr = (v: unknown) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );

/**
 * Attribute string to splice into a card/article opening tag. Empty while the
 * flag is off, so existing markup is unchanged. A 檢舉 button is injected
 * next to the element by the observer below.
 */
export function reportAttrs(
  type: ReportTarget,
  id: unknown,
  authorId?: unknown,
): string {
  if (!isEnabled("content_reports") || !id) return "";
  return ` data-report-type="${type}" data-report-id="${escAttr(id)}"${authorId ? ` data-report-author="${escAttr(authorId)}"` : ""}`;
}

/** Opens the report dialog for any reportable target. */
export function openReportDialog(
  ctx: FeatureCtx,
  type: ReportTarget,
  id: string,
): Promise<boolean> {
  return new Promise((resolve) => {
    if (!ctx.client) {
      ctx.toast("示範模式無法送出檢舉");
      return resolve(false);
    }
    const dlg = document.createElement("dialog");
    dlg.className = "report-dialog";
    dlg.innerHTML = `<form method="dialog" class="report-form"><h3>檢舉${ctx.esc(TYPE_LABEL[type] ?? "內容")}</h3><p class="sub">檢舉僅管理員可見，作者不會知道是誰檢舉。請勿在說明中填寫個資。</p><label>原因<select name="reason">${REASONS.map(([v, l]) => `<option value="${v}">${ctx.esc(l)}</option>`).join("")}</select></label><label>補充說明（選填，500 字內）<textarea name="detail" maxlength="500" rows="4"></textarea></label><div class="row"><button type="button" class="ghost" data-cancel>取消</button><button type="submit" class="danger">送出檢舉</button></div></form>`;
    document.body.append(dlg);
    let done = false;
    const close = (ok: boolean) => {
      if (done) return;
      done = true;
      dlg.close();
      dlg.remove();
      resolve(ok);
    };
    dlg
      .querySelector("[data-cancel]")!
      .addEventListener("click", () => close(false));
    dlg.addEventListener("cancel", () => close(false));
    dlg.querySelector("form")!.addEventListener("submit", (ev) => {
      ev.preventDefault();
      const f = new FormData(ev.target as HTMLFormElement);
      const submit = dlg.querySelector<HTMLButtonElement>("[type=submit]")!;
      submit.disabled = true;
      void (async () => {
        let ok = false;
        try {
          const reviewed = await ctx.review({
            detail: String(f.get("detail") ?? ""),
          });
          if (!reviewed) return;
          const { error } = await ctx.client!.rpc("report_content", {
            p_type: type,
            p_id: id,
            p_reason: String(f.get("reason")),
            p_detail: reviewed.payload.detail || null,
          });
          if (error) throw new Error(friendly(error.message));
          ctx.toast("已送出檢舉，感謝您協助維護社群");
          ok = true;
        } catch (e) {
          ctx.toast(e instanceof Error ? e.message : "檢舉失敗");
        } finally {
          submit.disabled = false;
          if (ok) close(true);
        }
      })();
    });
    dlg.showModal();
  });
}

// ---- inline 檢舉 buttons and 已隱藏 badges for any element carrying data-report-* ----
let latestCtx: FeatureCtx | null = null;
let observer: MutationObserver | null = null;
let pending = false;
function decorate() {
  pending = false;
  const ctx = latestCtx;
  if (!ctx || !isEnabled("content_reports")) return;
  const hiddenCheck = new Map<string, Map<string, HTMLElement[]>>();
  document
    .querySelectorAll<HTMLElement>("[data-report-type][data-report-id]")
    .forEach((el) => {
      if (el.dataset.reportDone) return;
      el.dataset.reportDone = "1";
      const type = el.dataset.reportType as ReportTarget,
        id = el.dataset.reportId!;
      const author = el.dataset.reportAuthor;
      if (author && author === ctx.user?.id) {
        // own content: no report button, but show the hidden marker if moderated
      } else {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "ghost report-btn";
        b.textContent = "檢舉";
        b.setAttribute("aria-label", `檢舉這則${TYPE_LABEL[type] ?? "內容"}`);
        b.addEventListener("click", (ev) => {
          ev.stopPropagation();
          void openReportDialog(latestCtx ?? ctx, type, id);
        });
        el.append(b);
      }
      if (!hiddenCheck.has(type)) hiddenCheck.set(type, new Map());
      const m = hiddenCheck.get(type)!;
      m.set(id, [...(m.get(id) ?? []), el]);
    });
  if (!ctx.client) return;
  for (const [type, m] of hiddenCheck)
    void (async () => {
      const { data } = await ctx.client!.rpc("moderation_hidden_visible", {
        p_type: type,
        p_ids: [...m.keys()],
      });
      for (const id of (data ?? []) as string[])
        for (const el of m.get(id) ?? []) {
          const s = document.createElement("span");
          s.className = "badge orange report-hidden";
          s.textContent = "已隱藏（僅作者與管理員可見）";
          el.prepend(s);
        }
    })().catch(() => {});
}
function start(ctx: FeatureCtx) {
  latestCtx = ctx;
  if (observer || typeof MutationObserver === "undefined") return;
  observer = new MutationObserver(() => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(decorate);
  });
  observer.observe(document.body, { childList: true, subtree: true });
  decorate();
}

// ---- admin panel ----
async function renderAdmin(container: HTMLElement, ctx: FeatureCtx) {
  const e = ctx.esc;
  let status: string = "open";
  const rpc = async (fn: string, args: Record<string, unknown> = {}) => {
    if (!ctx.client) throw new Error("示範模式不支援");
    const { data, error } = await ctx.client.rpc(fn, args);
    if (error) throw new Error(friendly(error.message));
    return data;
  };
  const fmt = (t: string | null) =>
    t ? new Date(t).toLocaleString("zh-TW", { hour12: false }) : "—";
  async function draw() {
    let queue: any[] = [],
      history: any[] = [];
    try {
      [queue, history] = await Promise.all([
        rpc("admin_report_queue", { p_status: status || null, p_limit: 50 }),
        rpc("admin_moderation_history", { p_limit: 30 }),
      ]);
    } catch (err) {
      container.innerHTML = `<p class="empty">${e(err instanceof Error ? err.message : "載入失敗")}</p>`;
      return;
    }
    container.innerHTML = `<div class="row"><label>狀態<select id="cr-status">${[
      ["open", "待處理"],
      ["dismissed", "已駁回"],
      ["actioned", "已處置"],
      ["", "全部"],
    ]
      .map(
        ([v, l]) =>
          `<option value="${v}" ${v === status ? "selected" : ""}>${l}</option>`,
      )
      .join(
        "",
      )}</select></label><button class="ghost" id="cr-refresh">重新整理</button></div>${
      (queue ?? [])
        .map((r: any) => {
          const p = r.preview ?? {};
          return `<div class="list-item report-item" data-rid="${e(r.id)}"><div class="row"><span><b>${e(TYPE_LABEL[r.target_type] ?? r.target_type)}</b> · ${e(REASON_LABEL[r.reason] ?? r.reason)} ${p.hidden ? '<span class="badge orange">已隱藏</span>' : ""}<br><span class="sub">檢舉人 ${e(r.reporter_name)} · ${e(fmt(r.created_at))}${r.status !== "open" ? ` · ${r.status === "dismissed" ? "已駁回" : "已處置"} ${e(fmt(r.handled_at))}` : ""}</span></span></div>${r.detail ? `<p class="sub">說明：${e(r.detail)}</p>` : ""}<blockquote class="report-preview">${p.title ? `<b>${e(p.title)}</b><br>` : ""}${p.body ? e(p.body) : '<span class="muted">（內容已不存在）</span>'}<br><span class="sub">作者：${e(p.author_name ?? "—")}</span></blockquote>${r.resolution_note ? `<p class="sub">處理備註：${e(r.resolution_note)}</p>` : ""}${
            r.status === "open"
              ? `<label>處理備註（選填）<input class="cr-note" maxlength="500"></label><div class="actions">${p.hidden ? `<button class="ghost" data-act="unhide">取消隱藏</button>` : `<button class="danger" data-act="hide">隱藏內容</button>`}<button class="secondary" data-act="actioned">標記已處理</button><button class="ghost" data-act="dismissed">駁回</button></div>`
              : ""
          }</div>`;
        })
        .join("") || '<p class="empty">沒有符合的檢舉</p>'
    }<h3>處置紀錄</h3>${
      (history ?? [])
        .map(
          (h: any) =>
            `<div class="list-item"><span class="sub">${e(fmt(h.created_at))} · ${e(h.actor_name ?? "系統")} · ${e({ hide: "隱藏", unhide: "取消隱藏", dismiss: "駁回", action: "已處置" }[h.action as "hide"] ?? h.action)} ${e(TYPE_LABEL[h.target_type] ?? h.target_type)}${h.note ? ` · ${e(h.note)}` : ""}</span></div>`,
        )
        .join("") || '<p class="empty">尚無紀錄</p>'
    }`;
    container
      .querySelector<HTMLSelectElement>("#cr-status")!
      .addEventListener("change", (ev) => {
        status = (ev.target as HTMLSelectElement).value;
        void draw();
      });
    container
      .querySelector("#cr-refresh")!
      .addEventListener("click", () => void draw());
    container.querySelectorAll<HTMLElement>("[data-act]").forEach((btn) =>
      btn.addEventListener("click", () =>
        ctx.run(async () => {
          const item = btn.closest<HTMLElement>(".report-item")!;
          const r = queue.find((q: any) => q.id === item.dataset.rid);
          const reviewed = await ctx.review({
            note: item.querySelector<HTMLInputElement>(".cr-note")!.value,
          });
          if (!reviewed) return;
          const note = reviewed.payload.note || null;
          const act = btn.dataset.act;
          if (act === "hide" || act === "unhide")
            await rpc("moderate_content", {
              p_type: r.target_type,
              p_id: r.target_id,
              p_hidden: act === "hide",
              p_note: note,
            });
          else
            await rpc("resolve_report", {
              p_id: r.id,
              p_status: act,
              p_note: note,
            });
          ctx.toast("已更新");
          await draw();
        }),
      ),
    );
  }
  await draw();
}

registerFeature({
  key: "content_reports",
  topbar(ctx) {
    start(ctx);
    return null;
  },
  adminPanel: {
    id: "content-reports",
    label: "檢舉與版務審核",
    render: renderAdmin,
  },
});
