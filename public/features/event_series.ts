import { registerFeature, type FeatureCtx } from "../feature-registry";
import "./event_series.css";

const ERRORS: Record<string, string> = {
  FEATURE_DISABLED: "活動系列功能目前未開啟",
  ADMIN_REQUIRED: "僅管理員可執行",
  MEMBER_REQUIRED: "請先完成登入與通關",
  SERIES_NOT_FOUND: "找不到此系列",
  EVENT_NOT_FOUND: "找不到來源活動",
  INVALID_WINDOW: "結束時間必須晚於開始時間",
  INVALID_SERIES: "系列名稱需 1–80 字、說明至多 1000 字",
  INVALID_SLUG: "網址代稱僅可使用小寫英數與連字號（2–39 字）",
  SLUG_TAKEN: "此網址代稱已被使用",
  PII_DETECTED: "偵測到個資（身分證字號或病歷號），請移除後再送出",
};
async function rpc(
  ctx: FeatureCtx,
  fn: string,
  args?: Record<string, unknown>,
) {
  const { data, error } = await ctx.client!.rpc(fn, args);
  if (error) throw Error(ERRORS[error.message] ?? error.message);
  return data;
}
async function api(
  ctx: FeatureCtx,
  path: string,
  method: string,
  payload: any,
) {
  const { data } = await ctx.client!.auth.getSession();
  if (!data.session) throw Error("請重新登入");
  const res = await fetch(`/api/v1/event-series${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${data.session.access_token}`,
    },
    body: JSON.stringify(payload),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw Error(ERRORS[out.code] ?? out.code ?? "請求失敗");
  return out;
}
const fmt = (s: string) =>
  new Date(s).toLocaleString("zh-TW", { hour12: false });

// ---------- admin panel ----------
async function renderAdmin(box: HTMLElement, ctx: FeatureCtx) {
  const { esc } = ctx;
  if (!ctx.client) {
    box.innerHTML = `<p class="empty">示範模式不提供活動系列管理。</p>`;
    return;
  }
  const [series, events]: [any[], any[]] = await Promise.all([
    rpc(ctx, "list_event_series"),
    rpc(ctx, "event_series_admin_events"),
  ]);
  const reload = () => void ctx.run(() => renderAdmin(box, ctx));
  const opts = (sel: string | null) =>
    `<option value="">（不屬於任何系列）</option>` +
    series
      .filter((s) => !s.archived || s.id === sel)
      .map(
        (s) =>
          `<option value="${esc(s.id)}" ${s.id === sel ? "selected" : ""}>${esc(s.title)}</option>`,
      )
      .join("");
  box.innerHTML = `<form class="es-form" data-new><h3>新增系列</h3>
    <label>系列名稱（80 字內）<input name="title" required maxlength="80" placeholder="每月 AI Meetup"></label>
    <label>說明（1000 字內）<textarea name="description" maxlength="1000" rows="2"></textarea></label>
    <button>建立系列</button></form>
   <h3>系列</h3>${
     series.length
       ? series
           .map(
             (s) =>
               `<form class="list-item es-row" data-series="${esc(s.id)}"><input name="title" value="${esc(s.title)}" required maxlength="80"><textarea name="description" maxlength="1000" rows="1">${esc(s.description)}</textarea><label class="check"><input type="checkbox" name="archived" ${s.archived ? "checked" : ""}>封存</label><button class="secondary">儲存</button></form>`,
           )
           .join("")
       : `<p class="empty">尚無系列</p>`
   }
   <h3>活動歸屬與複製</h3>${
     events.length
       ? events
           .map(
             (e) =>
               `<div class="list-item es-event" data-event="${esc(e.id)}"><div><strong>${esc(e.title)}</strong><div class="sub">${esc(fmt(e.starts_at))} · ${e.is_published ? "已上架" : "草稿"}</div></div><select data-assign>${opts(e.series_id)}</select><button class="ghost" data-clone>複製上一場</button></div>`,
           )
           .join("")
       : `<p class="empty">尚無活動</p>`
   }
   <form class="es-form" data-clonebox hidden><h3>複製活動：<span data-cname></span></h3>
    <p class="sub">帶入地點、名額、議程、問卷題目與報名／報到時段（依新日期平移）；新活動為未上架草稿，不複製任何報名、報到或照片。</p>
    <label>新開始時間<input type="datetime-local" name="starts" required></label>
    <label>新結束時間<input type="datetime-local" name="ends" required></label>
    <button>建立草稿</button> <button type="button" class="ghost" data-cancel>取消</button></form>`;

  const newForm = box.querySelector<HTMLFormElement>("[data-new]")!;
  newForm.onsubmit = (ev) => {
    ev.preventDefault();
    void ctx.run(async () => {
      const f = new FormData(newForm);
      const payload = {
        title: String(f.get("title")).trim(),
        description: String(f.get("description") ?? ""),
      };
      const r = await ctx.review(payload);
      if (!r) return;
      await api(ctx, "", "POST", {
        ...r.payload,
        ...(r.force_override ? { force_override: true } : {}),
      });
      ctx.toast("已建立系列");
      await renderAdmin(box, ctx);
    });
  };
  box.querySelectorAll<HTMLFormElement>("[data-series]").forEach((form) => {
    form.onsubmit = (ev) => {
      ev.preventDefault();
      void ctx.run(async () => {
        const f = new FormData(form);
        const r = await ctx.review({
          title: String(f.get("title")).trim(),
          description: String(f.get("description") ?? ""),
        });
        if (!r) return;
        await api(ctx, `/${form.dataset.series}`, "PUT", {
          ...r.payload,
          archived: f.get("archived") === "on",
          ...(r.force_override ? { force_override: true } : {}),
        });
        ctx.toast("已儲存");
        await renderAdmin(box, ctx);
      });
    };
  });
  box.querySelectorAll<HTMLSelectElement>("[data-assign]").forEach((sel) => {
    sel.onchange = () =>
      void ctx.run(async () => {
        await rpc(ctx, "assign_event_series", {
          p_event: sel.closest<HTMLElement>("[data-event]")!.dataset.event,
          p_series: sel.value || null,
        });
        ctx.toast("已更新歸屬");
      });
  });
  const cbox = box.querySelector<HTMLFormElement>("[data-clonebox]")!;
  let source = "";
  box.querySelectorAll<HTMLElement>("[data-clone]").forEach((b) => {
    b.onclick = () => {
      const row = b.closest<HTMLElement>("[data-event]")!;
      source = row.dataset.event!;
      cbox.querySelector("[data-cname]")!.textContent =
        row.querySelector("strong")!.textContent;
      cbox.hidden = false;
      cbox.scrollIntoView?.({ block: "nearest" });
    };
  });
  cbox.querySelector<HTMLElement>("[data-cancel]")!.onclick = () => {
    cbox.hidden = true;
  };
  cbox.onsubmit = (ev) => {
    ev.preventDefault();
    void ctx.run(async () => {
      const f = new FormData(cbox);
      // datetime-local has no zone; the Taipei team enters Asia/Taipei times
      const iso = (v: unknown) => new Date(`${v}:00+08:00`).toISOString();
      await rpc(ctx, "clone_event", {
        p_source: source,
        p_starts_at: iso(f.get("starts")),
        p_ends_at: iso(f.get("ends")),
      });
      ctx.toast("已建立草稿，請至活動管理確認後上架");
      reload();
    });
  };
}

// ---------- member page ----------
async function renderMember(box: HTMLElement, ctx: FeatureCtx) {
  const { esc } = ctx;
  if (!ctx.client) {
    box.innerHTML = `<h2>活動系列</h2><p class="empty">示範模式不提供活動系列。</p>`;
    return;
  }
  const series: any[] = await rpc(ctx, "list_event_series");
  box.innerHTML = `<h2>活動系列</h2><div class="es-list">${
    series.length
      ? series
          .map(
            (s) =>
              `<article class="list-item es-series" data-id="${esc(s.id)}"><h3>${esc(s.title)}${s.archived ? "（已封存）" : ""}</h3>${s.description ? `<p>${esc(s.description)}</p>` : ""}<p class="sub">即將舉辦 ${esc(s.upcoming)} 場 · 歷屆 ${esc(s.past)} 場</p><button class="secondary" data-open>查看活動</button><div class="es-events"></div></article>`,
          )
          .join("")
      : `<p class="empty">尚無活動系列</p>`
  }</div>`;
  box.querySelectorAll<HTMLElement>(".es-series").forEach((card) => {
    const target = card.querySelector<HTMLElement>(".es-events")!;
    card.querySelector<HTMLElement>("[data-open]")!.onclick = () =>
      void ctx.run(async () => {
        const events: any[] = await rpc(ctx, "event_series_events", {
          p_series: card.dataset.id,
        });
        const group = (past: boolean, title: string) => {
          const rows = events
            .filter((e) => e.is_past === past)
            .sort((a, b) =>
              past
                ? b.starts_at.localeCompare(a.starts_at)
                : a.starts_at.localeCompare(b.starts_at),
            );
          return rows.length
            ? `<h4>${title}</h4><ul>${rows.map((e) => `<li><a href="#event/${esc(e.id)}">${esc(e.title)}</a> <span class="sub">${esc(fmt(e.starts_at))}${e.status === "cancelled" ? " · 已取消" : ""}</span></li>`).join("")}</ul>`
            : "";
        };
        target.innerHTML =
          group(false, "即將舉辦") + group(true, "歷屆活動") ||
          `<p class="empty">尚無已上架的活動</p>`;
      });
  });
}

registerFeature({
  key: "event_series",
  nav: {
    id: "event_series",
    label: "活動系列",
    iconPath: "M4 6h16M4 12h16M4 18h10",
  },
  render: renderMember,
  adminPanel: {
    id: "event_series",
    label: "活動系列與複製",
    render: renderAdmin,
  },
});
