import { registerFeature, type FeatureCtx } from "../feature-registry";
import "./event_archive.css";

const ERRORS: Record<string, string> = {
  FEATURE_DISABLED: "活動回顧功能目前未開啟",
  MEMBER_REQUIRED: "請先完成登入與通關",
  ADMIN_REQUIRED: "僅管理員可執行",
  ARCHIVE_NOT_FOUND: "找不到此活動回顧（可能尚未發布）",
  EVENT_NOT_FOUND: "找不到此活動",
  INVALID_ARCHIVE:
    "內容格式不符（摘要 3000 字內、亮點至多 10 則、投影片連結至多 20 筆、相關展示至多 20 個）",
  INVALID_URL: "投影片連結必須是 https:// 開頭且不含空白",
  SPACE_NOT_FOUND: "相關展示必須是公開展示",
  PII_DETECTED: "偵測到個資（身分證字號、病歷號或病患姓名等），請移除後再送出",
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
const fmt = (s: string) =>
  new Date(s).toLocaleDateString("zh-TW", { dateStyle: "medium" });
let openEvent: string | null = null;

// ---------- member: list + archive page ----------
async function renderMember(box: HTMLElement, ctx: FeatureCtx) {
  if (!ctx.client) {
    box.innerHTML = `<p class="empty">示範模式不提供活動回顧。</p>`;
    return;
  }
  if (openEvent) return renderPage(box, ctx, openEvent);
  const { esc } = ctx;
  let series: any[] = [];
  if (ctx.isEnabled("event_series"))
    try {
      series = await rpc(ctx, "list_event_series");
    } catch {
      series = [];
    }
  box.innerHTML = `<h2>活動回顧</h2>
   <form class="ea-filters"><select name="series"><option value="">全部系列</option>${series
     .map((s) => `<option value="${esc(s.id)}">${esc(s.title)}</option>`)
     .join(
       "",
     )}</select><input name="q" maxlength="80" placeholder="搜尋活動名稱"><button>搜尋</button></form>
   <div data-list></div>`;
  const form = box.querySelector<HTMLFormElement>("form")!;
  const list = box.querySelector<HTMLElement>("[data-list]")!;
  const load = async () => {
    const f = new FormData(form);
    const rows: any[] = await rpc(ctx, "list_event_archives", {
      p_series: String(f.get("series") ?? "") || null,
      p_query: String(f.get("q") ?? "").trim() || null,
      p_limit: 50,
      p_offset: 0,
    });
    list.innerHTML = rows.length
      ? rows
          .map(
            (r) =>
              `<div class="list-item"><div><strong>${esc(r.title)}</strong><div class="sub">${esc(fmt(r.starts_at))}${r.series_title ? " · " + esc(r.series_title) : ""}</div><p>${esc(r.summary)}</p></div><button class="ghost" data-open="${esc(r.event_id)}">查看回顧</button></div>`,
          )
          .join("")
      : `<p class="empty">尚無符合的活動回顧</p>`;
    list.querySelectorAll<HTMLElement>("[data-open]").forEach((b) => {
      b.onclick = () => {
        openEvent = b.dataset.open!;
        void ctx.run(() => renderMember(box, ctx));
      };
    });
  };
  form.onsubmit = (ev) => {
    ev.preventDefault();
    void ctx.run(load);
  };
  await load();
}

async function renderPage(box: HTMLElement, ctx: FeatureCtx, id: string) {
  const { esc } = ctx;
  let d: any;
  try {
    d = await rpc(ctx, "event_archive_page", { p_event: id });
  } catch (e) {
    openEvent = null;
    throw e;
  }
  const ev = d.event;
  const fb = d.feedback;
  box.innerHTML = `<p><button class="ghost" data-back>← 回到列表</button></p>
   <h2>${esc(ev.title)}</h2>
   <p class="sub">${esc(fmt(ev.starts_at))}${ev.location ? " · " + esc(ev.location) : ""}${ev.series_title ? " · " + esc(ev.series_title) : ""}${d.published ? "" : " · 草稿預覽（尚未發布）"}</p>
   ${d.summary ? `<p>${esc(d.summary)}</p>` : ""}
   ${d.highlights.length ? `<h3>活動亮點</h3><ul>${d.highlights.map((h: string) => `<li>${esc(h)}</li>`).join("")}</ul>` : ""}
   ${d.agenda.length ? `<h3>議程</h3><ul>${d.agenda.map((a: any) => `<li>${esc(a.time)} ${esc(a.title)}${a.speaker ? "（" + esc(a.speaker) + "）" : ""}</li>`).join("")}</ul>` : ""}
   ${d.slides_links.length ? `<h3>投影片與資料</h3><ul>${d.slides_links.map((l: any) => `<li><a href="${esc(l.url)}" target="_blank" rel="noopener noreferrer">${esc(l.title)}</a></li>`).join("")}</ul>` : ""}
   ${
     d.spaces.length
       ? `<h3>相關展示與高票 Q&A</h3>${d.spaces
           .map(
             (s: any) =>
               `<div class="list-item"><div><strong>${esc(s.title)}</strong> <span class="sub">${esc(s.category_tag)}</span><p>${esc(s.summary)}</p>${
                 s.qa.length
                   ? `<ul class="ea-qa">${s.qa.map((q: any) => `<li>${esc(q.question_text)}（${esc(q.upvotes)} 讚）${q.speaker_reply ? `<div class="sub">回覆：${esc(q.speaker_reply)}</div>` : ""}</li>`).join("")}</ul>`
                   : ""
               }</div></div>`,
           )
           .join("")}`
       : ""
   }
   ${d.photos.length ? `<h3>活動照片</h3><div class="ea-photos">${d.photos.map((p: any) => `<img loading="lazy" alt="活動照片" src="${esc(p.url)}">`).join("")}</div>` : ""}
   ${
     fb
       ? `<h3>回饋摘要</h3><p class="sub">共 ${esc(fb.response_count)} 份回覆${fb.ratings.length ? "" : "（回覆數較少時不顯示平均分數）"}</p>${
           fb.ratings.length
             ? `<ul>${fb.ratings.map((r: any) => `<li>${esc(r.label)}：${esc(r.average)} / 5（${esc(r.answered)} 人）</li>`).join("")}</ul>`
             : ""
         }`
       : ""
   }`;
  box.querySelector<HTMLElement>("[data-back]")!.onclick = () => {
    openEvent = null;
    void ctx.run(() => renderMember(box, ctx));
  };
}

// ---------- admin panel ----------
const lines = (s: string) =>
  s
    .split("\n")
    .map((x) => x.trim())
    .filter(Boolean);
async function renderAdmin(box: HTMLElement, ctx: FeatureCtx) {
  const { esc } = ctx;
  if (!ctx.client) {
    box.innerHTML = `<p class="empty">示範模式不提供活動回顧管理。</p>`;
    return;
  }
  const events: any[] = await rpc(ctx, "event_archive_admin_list");
  box.innerHTML = events.length
    ? events
        .map(
          (e) =>
            `<div class="list-item ea-row" data-event="${esc(e.event_id)}"><div><strong>${esc(e.title)}</strong><div class="sub">${esc(fmt(e.starts_at))} · ${e.is_published ? "已上架" : "草稿活動"} · ${e.has_archive ? (e.published ? "回顧已發布" : "回顧草稿") : "尚無回顧"}</div></div><button class="ghost" data-edit>編輯回顧</button></div>`,
        )
        .join("") + `<div data-editor></div>`
    : `<p class="empty">尚無活動</p>`;
  box.querySelectorAll<HTMLElement>("[data-event]").forEach((row) => {
    row.querySelector<HTMLElement>("[data-edit]")!.onclick = () =>
      editor(
        box,
        ctx,
        events.find((e) => e.event_id === row.dataset.event),
        () => renderAdmin(box, ctx),
      );
  });
}
function editor(
  box: HTMLElement,
  ctx: FeatureCtx,
  e: any,
  reload: () => Promise<void>,
) {
  const { esc } = ctx;
  const host = box.querySelector<HTMLElement>("[data-editor]")!;
  host.innerHTML = `<form class="ea-form"><h3>活動回顧：${esc(e.title)}</h3>
   <label>摘要（3000 字內）<textarea name="summary" rows="4" maxlength="3000">${esc(e.summary ?? "")}</textarea></label>
   <label>亮點（每行一則，至多 10 則）<textarea name="highlights" rows="5">${esc((e.highlights ?? []).join("\n"))}</textarea></label>
   <label>投影片連結（每行：標題 | https://網址，至多 20 筆）<textarea name="slides" rows="4">${esc((e.slides_links ?? []).map((l: any) => `${l.title} | ${l.url}`).join("\n"))}</textarea></label>
   <label>相關展示 ID（每行一個公開展示，至多 20 個）<textarea name="spaces" rows="3">${esc((e.related_space_ids ?? []).join("\n"))}</textarea></label>
   <div class="ea-row"><button type="button" class="ghost" data-draft>自動產生草稿</button>
   <button type="button" data-save="0">儲存草稿</button><button type="button" data-save="1" class="secondary">儲存並發布</button>
   ${e.published ? `<button type="button" data-save="unpublish" class="ghost">取消發布</button>` : ""}</div></form>`;
  const form = host.querySelector<HTMLFormElement>("form")!;
  const field = (n: string) =>
    form.elements.namedItem(n) as HTMLTextAreaElement;
  host.querySelector<HTMLElement>("[data-draft]")!.onclick = () =>
    void ctx.run(async () => {
      const d = await rpc(ctx, "generate_event_archive_draft", {
        p_event: e.event_id,
      });
      if (!field("summary").value.trim()) field("summary").value = d.summary;
      field("highlights").value = d.highlights.join("\n");
      field("spaces").value = d.related_space_ids.join("\n");
      ctx.toast("已帶入草稿，請檢查後再儲存");
    });
  form.onsubmit = (ev) => ev.preventDefault();
  host.querySelectorAll<HTMLButtonElement>("[data-save]").forEach((b) => {
    b.onclick = () =>
      void ctx.run(async () => {
        const mode = b.dataset.save;
        const slides = lines(field("slides").value).map((l) => {
          const i = l.lastIndexOf("|");
          if (i < 0) throw Error("投影片連結格式：標題 | https://網址");
          return { title: l.slice(0, i).trim(), url: l.slice(i + 1).trim() };
        });
        const payload = {
          summary: field("summary").value.trim(),
          highlights: lines(field("highlights").value),
          slides_links: slides,
        };
        const r = await ctx.review(payload);
        if (!r) return;
        await rpc(ctx, "save_event_archive", {
          p_event: e.event_id,
          p_summary: r.payload.summary,
          p_highlights: r.payload.highlights,
          p_slides: r.payload.slides_links,
          p_related: lines(field("spaces").value),
          p_publish: mode === "1",
        });
        ctx.toast(
          mode === "1"
            ? "已發布"
            : mode === "unpublish"
              ? "已取消發布"
              : "已儲存",
        );
        await reload();
      });
  });
}

registerFeature({
  key: "event_archive",
  nav: {
    id: "event_archive",
    label: "活動回顧",
    iconPath: "M4 5h16v14H4zM4 9h16M8 13h8",
  },
  render: renderMember,
  adminPanel: {
    id: "event_archive",
    label: "活動回顧管理",
    render: renderAdmin,
  },
});
