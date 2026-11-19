import { registerFeature, type FeatureCtx } from "../feature-registry";
import "./event_feedback.css";

type Question = {
  id: string;
  type: "rating" | "single" | "text";
  label: string;
  options?: string[];
  required?: boolean;
};
const TYPE_LABEL: Record<Question["type"], string> = {
  rating: "評分（1–5）",
  single: "單選",
  text: "開放文字",
};

async function token(ctx: FeatureCtx) {
  const { data } = await ctx.client!.auth.getSession();
  if (!data.session) throw Error("請重新登入");
  return data.session.access_token;
}
async function api(ctx: FeatureCtx, path: string, method: string, body: any) {
  const res = await fetch(`/api/v1/event-feedback/${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${await token(ctx)}`,
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (data.code === "PII_DETECTED")
      ctx.toast("後端偵測到個資，請重新檢視內容");
    throw Error(ERRORS[data.code] ?? data.code ?? "請求失敗");
  }
  return data;
}
const ERRORS: Record<string, string> = {
  NOT_ELIGIBLE: "僅已報到的同仁可填寫此問卷",
  ALREADY_SUBMITTED: "你已經填寫過這份問卷",
  FEEDBACK_CLOSED: "問卷已截止",
  FEEDBACK_NOT_OPEN: "問卷尚未開放",
  FEEDBACK_UNAVAILABLE: "問卷尚未發布",
  INVALID_ANSWERS: "答案不完整或格式不正確",
  FORM_LOCKED: "已有人填寫，無法修改題目或匿名設定",
  INVALID_QUESTIONS: "題目格式不正確（1–15 題，單選需 2–10 個不重複選項）",
  INVALID_WINDOW: "截止時間必須晚於開放時間",
  PII_DETECTED: "偵測到個資",
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
const fmt = (s: string | null) =>
  s ? new Date(s).toLocaleString("zh-TW", { hour12: false }) : "—";
const toLocalInput = (s: string | null) => {
  const d = s ? new Date(s) : new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);
};

/** CSV with BOM for Excel; cells starting with = + - @ are neutralised. */
export function toCsv(rows: (string | number | null | undefined)[][]) {
  const cell = (v: unknown) => {
    let s = v == null ? "" : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return `"${s.replace(/"/g, '""')}"`;
  };
  return "﻿" + rows.map((r) => r.map(cell).join(",")).join("\r\n");
}
export function exportRows(exp: any) {
  const qs: Question[] = exp.questions;
  const head = [
    ...(exp.is_anonymous ? [] : ["填答者", "填答時間"]),
    ...qs.map((q) => q.label),
  ];
  const body = (exp.rows as any[]).map((r) => [
    ...(exp.is_anonymous ? [] : [r.respondent_name, r.submitted_at]),
    ...qs.map((q) => r.answers?.[q.id] ?? ""),
  ]);
  return [head, ...body];
}
function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------- admin panel ----------
async function renderAdmin(box: HTMLElement, ctx: FeatureCtx) {
  const { esc } = ctx;
  if (!ctx.client) {
    box.innerHTML = `<p class="empty">示範模式不提供問卷管理。</p>`;
    return;
  }
  const events: any[] = await rpc(ctx, "event_feedback_admin_list");
  box.innerHTML = events.length
    ? events
        .map(
          (e) =>
            `<div class="list-item row"><div><strong>${esc(e.title)}</strong><div class="sub">${esc(fmt(e.starts_at))} · ${
              !e.form ? "尚未設定問卷" : e.form.published_at ? "已發布" : "草稿"
            }</div></div><div class="actions">${
              e.can_edit
                ? `<button class="secondary" data-edit="${e.event_id}">${e.form ? "編輯問卷" : "建立問卷"}</button>`
                : ""
            }${e.form?.published_at ? `<button class="ghost" data-sum="${e.event_id}">結果</button>` : ""}</div></div>`,
        )
        .join("")
    : `<p class="empty">尚無活動</p>`;
  const holder = document.createElement("div");
  holder.className = "fb-holder";
  box.append(holder);
  box.querySelectorAll<HTMLElement>("[data-edit]").forEach(
    (b) =>
      (b.onclick = () =>
        editor(
          holder,
          ctx,
          events.find((e) => e.event_id === b.dataset.edit),
          () => renderAdmin(box, ctx),
        )),
  );
  box.querySelectorAll<HTMLElement>("[data-sum]").forEach(
    (b) =>
      (b.onclick = () =>
        void ctx.run(() =>
          summary(
            holder,
            ctx,
            events.find((e) => e.event_id === b.dataset.sum),
          ),
        )),
  );
}

function editor(
  holder: HTMLElement,
  ctx: FeatureCtx,
  ev: any,
  done: () => void,
) {
  const { esc } = ctx;
  const form = ev.form;
  const published = !!form?.published_at;
  let qs: Question[] = form?.questions?.length
    ? structuredClone(form.questions)
    : [{ id: "overall", type: "rating", label: "整體滿意度", required: true }];
  const draw = () => {
    holder.innerHTML = `<div class="panel fb-editor"><h3>${esc(ev.title)} — 回饋問卷</h3>
<div class="fb-fields"><label>開放時間<input type="datetime-local" id="fb-open" value="${toLocalInput(form?.opens_at ?? ev.ends_at)}"></label>
<label>截止時間<input type="datetime-local" id="fb-close" value="${toLocalInput(form?.closes_at ?? new Date(Date.parse(ev.ends_at) + 7 * 864e5).toISOString())}"></label>
<label class="fb-check"><input type="checkbox" id="fb-anon" ${form?.is_anonymous ? "checked" : ""}> 匿名（管理員看不到填答者）</label></div>
${qs
  .map(
    (q, i) => `<div class="fb-q" data-i="${i}"><div class="row">
<select data-f="type" aria-label="題型">${(Object.keys(TYPE_LABEL) as Question["type"][]).map((t) => `<option value="${t}" ${q.type === t ? "selected" : ""}>${TYPE_LABEL[t]}</option>`).join("")}</select>
<input data-f="label" value="${esc(q.label)}" maxlength="200" placeholder="題目" aria-label="題目">
<label class="fb-check"><input type="checkbox" data-f="required" ${q.required ? "checked" : ""}> 必填</label>
<button type="button" class="ghost" data-del="${i}" aria-label="刪除題目">✕</button></div>
${q.type === "single" ? `<textarea data-f="options" rows="3" placeholder="每行一個選項（2–10 個）" aria-label="選項">${esc((q.options ?? []).join("\n"))}</textarea>` : ""}</div>`,
  )
  .join("")}
<div class="actions"><button type="button" class="ghost" id="fb-add" ${qs.length >= 15 ? "disabled" : ""}>＋ 新增題目（${qs.length}/15）</button>
<button type="button" id="fb-save">儲存問卷</button>
${form && !published ? `<button type="button" class="secondary" id="fb-publish">發布並通知已報到者</button>` : ""}
<button type="button" class="ghost" id="fb-cancel">關閉</button></div></div>`;
    const read = () =>
      holder.querySelectorAll<HTMLElement>(".fb-q").forEach((row) => {
        const q = qs[Number(row.dataset.i)];
        row.querySelectorAll<HTMLInputElement>("[data-f]").forEach((f) => {
          if (f.dataset.f === "label") q.label = f.value;
          if (f.dataset.f === "required") q.required = f.checked;
          if (f.dataset.f === "options")
            q.options = f.value
              .split("\n")
              .map((s) => s.trim())
              .filter(Boolean);
        });
      });
    holder.querySelectorAll<HTMLSelectElement>("select[data-f=type]").forEach(
      (s) =>
        (s.onchange = () => {
          read();
          const q = qs[Number(s.closest<HTMLElement>(".fb-q")!.dataset.i)];
          q.type = s.value as Question["type"];
          if (q.type === "single") q.options ??= ["選項 1", "選項 2"];
          else delete q.options;
          draw();
        }),
    );
    holder.querySelectorAll<HTMLElement>("[data-del]").forEach(
      (b) =>
        (b.onclick = () => {
          read();
          qs.splice(Number(b.dataset.del), 1);
          draw();
        }),
    );
    holder.querySelector<HTMLElement>("#fb-add")!.onclick = () => {
      read();
      qs.push({ id: "q" + Date.now().toString(36), type: "text", label: "" });
      draw();
    };
    holder.querySelector<HTMLElement>("#fb-cancel")!.onclick = () =>
      (holder.innerHTML = "");
    holder.querySelector<HTMLElement>("#fb-save")!.onclick = () => {
      read();
      void ctx.run(async () => {
        const payload = {
          questions: qs.map((q) => ({
            id: q.id,
            type: q.type,
            label: q.label.trim(),
            required: !!q.required,
            ...(q.type === "single" ? { options: q.options } : {}),
          })),
        };
        // PII review of question text before it leaves the browser
        const reviewed = await ctx.review(payload);
        if (!reviewed) return;
        await api(ctx, `${ev.event_id}/form`, "PUT", {
          questions: reviewed.payload.questions,
          opens_at: new Date(
            holder.querySelector<HTMLInputElement>("#fb-open")!.value,
          ).toISOString(),
          closes_at: new Date(
            holder.querySelector<HTMLInputElement>("#fb-close")!.value,
          ).toISOString(),
          is_anonymous:
            holder.querySelector<HTMLInputElement>("#fb-anon")!.checked,
          force_override: reviewed.force_override,
        });
        ctx.toast("問卷已儲存");
        done();
      });
    };
    holder.querySelector<HTMLElement>("#fb-publish")?.addEventListener(
      "click",
      () =>
        void ctx.run(async () => {
          if (!confirm("發布後會通知所有已報到的同仁，且無法取消發布。確定？"))
            return;
          const r = await rpc(ctx, "publish_event_feedback", {
            p_event: ev.event_id,
          });
          ctx.toast(`問卷已發布，通知 ${r.notified} 位同仁`);
          done();
        }),
    );
  };
  draw();
  holder.scrollIntoView?.({ behavior: "smooth", block: "nearest" });
}

async function summary(holder: HTMLElement, ctx: FeatureCtx, ev: any) {
  const { esc } = ctx;
  const s = await rpc(ctx, "event_feedback_summary", { p_event: ev.event_id });
  holder.innerHTML = `<div class="panel fb-summary"><h3>${esc(ev.title)} — 回饋結果</h3>
<p class="sub">回收 ${s.response_count} / 已報到 ${s.eligible_count} 人 · ${s.is_anonymous ? "匿名問卷" : "具名問卷"}</p>
${(s.questions as any[])
  .map((q) => {
    if (q.type === "rating")
      return `<div class="fb-sq"><strong>${esc(q.label)}</strong><div>平均 ${q.average ?? "—"}（${q.answered} 份）</div><div class="fb-dist">${[1, 2, 3, 4, 5].map((n) => `<span>${n} 分：${q.distribution[n]}</span>`).join("")}</div></div>`;
    if (q.type === "single")
      return `<div class="fb-sq"><strong>${esc(q.label)}</strong><ul>${Object.entries(
        q.counts as Record<string, number>,
      )
        .map(([o, n]) => `<li>${esc(o)}：${n}</li>`)
        .join("")}</ul></div>`;
    return `<div class="fb-sq"><strong>${esc(q.label)}</strong>${q.texts.length ? `<ul>${(q.texts as string[]).map((t) => `<li>${esc(t)}</li>`).join("")}</ul>` : `<p class="empty">尚無回答</p>`}</div>`;
  })
  .join("")}
<div class="actions"><button type="button" id="fb-csv">匯出 CSV</button><button type="button" class="ghost" id="fb-close-sum">關閉</button></div></div>`;
  holder.querySelector<HTMLElement>("#fb-close-sum")!.onclick = () =>
    (holder.innerHTML = "");
  holder.querySelector<HTMLElement>("#fb-csv")!.onclick = () =>
    void ctx.run(async () => {
      const exp = await rpc(ctx, "event_feedback_export", {
        p_event: ev.event_id,
      });
      download(`feedback-${ev.event_id}.csv`, toCsv(exportRows(exp)));
    });
}

// ---------- member page ----------
async function renderMember(box: HTMLElement, ctx: FeatureCtx) {
  const { esc } = ctx;
  box.innerHTML = `<h2>活動回饋</h2><p class="sub">只有已報到的活動才會出現在這裡。</p><div id="fb-list">讀取中…</div>`;
  const list = box.querySelector<HTMLElement>("#fb-list")!;
  if (!ctx.client) {
    list.innerHTML = `<p class="empty">示範模式沒有回饋問卷。</p>`;
    return;
  }
  const forms: any[] = await rpc(ctx, "my_event_feedback_forms");
  const show = () => {
    list.innerHTML = forms.length
      ? forms
          .map(
            (f, i) =>
              `<div class="list-item row"><div><strong>${esc(f.event_title)}</strong><div class="sub">${
                f.submitted
                  ? "已填寫，感謝回饋"
                  : f.state === "open"
                    ? `填寫至 ${esc(fmt(f.closes_at))}`
                    : f.state === "upcoming"
                      ? `${esc(fmt(f.opens_at))} 開放`
                      : "已截止"
              }${f.is_anonymous ? " · 匿名" : ""}</div></div>${
                !f.submitted && f.state === "open"
                  ? `<button data-fill="${i}">填寫問卷</button>`
                  : ""
              }</div>`,
          )
          .join("")
      : `<p class="empty">目前沒有可填寫的問卷</p>`;
    list
      .querySelectorAll<HTMLElement>("[data-fill]")
      .forEach(
        (b) =>
          (b.onclick = () =>
            fill(
              list,
              ctx,
              forms[Number(b.dataset.fill)],
              show,
              (f) => (f.submitted = true),
            )),
      );
  };
  show();
}

function fill(
  host: HTMLElement,
  ctx: FeatureCtx,
  f: any,
  back: () => void,
  mark: (f: any) => void,
) {
  const { esc } = ctx;
  const qs: Question[] = f.questions;
  host.innerHTML = `<form class="panel fb-form"><h3>${esc(f.event_title)}</h3>
<p class="sub">${f.is_anonymous ? "此問卷為匿名，管理員看不到你的姓名。" : "此問卷為具名，管理員可看到你的姓名。"}請勿填寫病人個資。</p>
${qs
  .map((q) => {
    const req = q.required ? ` <span class="fb-req">*必填</span>` : "";
    if (q.type === "rating")
      return `<fieldset class="fb-q"><legend>${esc(q.label)}${req}</legend><div class="fb-stars">${[1, 2, 3, 4, 5].map((n) => `<label><input type="radio" name="${esc(q.id)}" value="${n}"> ${n}</label>`).join("")}</div></fieldset>`;
    if (q.type === "single")
      return `<fieldset class="fb-q"><legend>${esc(q.label)}${req}</legend>${(q.options ?? []).map((o) => `<label class="fb-opt"><input type="radio" name="${esc(q.id)}" value="${esc(o)}"> ${esc(o)}</label>`).join("")}</fieldset>`;
    return `<label class="fb-q">${esc(q.label)}${req}<textarea name="${esc(q.id)}" rows="3" maxlength="2000"></textarea></label>`;
  })
  .join("")}
<div class="actions"><button type="submit">送出</button><button type="button" class="ghost" id="fb-back">返回</button></div></form>`;
  host.querySelector<HTMLElement>("#fb-back")!.onclick = back;
  host.querySelector<HTMLFormElement>("form")!.onsubmit = (ev) => {
    ev.preventDefault();
    const fd = new FormData(ev.target as HTMLFormElement);
    const answers: Record<string, string | number> = {};
    for (const q of qs) {
      const v = fd.get(q.id);
      if (typeof v !== "string" || !v.trim()) {
        if (q.required) return ctx.toast(`請回答：${q.label}`);
        continue;
      }
      answers[q.id] = q.type === "rating" ? Number(v) : v;
    }
    void ctx.run(async () => {
      const reviewed = await ctx.review({ answers });
      if (!reviewed) return;
      await api(ctx, f.event_id, "POST", {
        answers: reviewed.payload.answers,
        force_override: reviewed.force_override,
      });
      mark(f);
      host.innerHTML = `<div class="panel fb-done"><h3>感謝你的回饋</h3><p class="sub">我們已收到你的回答。</p><div class="actions"><button type="button" id="fb-ok">完成</button></div></div>`;
      host.querySelector<HTMLElement>("#fb-ok")!.onclick = back;
    });
  };
}

registerFeature({
  key: "event_feedback",
  nav: {
    id: "event_feedback",
    label: "活動回饋",
    iconPath: "M4 4h16v12H8l-4 4V4z",
  },
  render: renderMember,
  adminPanel: {
    id: "event_feedback",
    label: "會後回饋問卷",
    render: renderAdmin,
  },
});
