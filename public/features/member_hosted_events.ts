import { registerFeature, type FeatureCtx } from "../feature-registry";

const STATUS_LABEL: Record<string, string> = {
  draft: "草稿",
  submitted: "審核中",
  approved: "已核准",
  returned: "已退回",
  cancelled: "已取消／撤下",
};
const ERRORS: Record<string, string> = {
  MEMBER_REQUIRED: "需要通過院內驗證的同仁身分",
  ADMIN_REQUIRED: "需要管理員權限",
  REQUEST_NOT_FOUND: "找不到此活動提案",
  REQUEST_LOCKED: "審核中或已核准的提案無法修改",
  INVALID_STATE: "目前狀態無法執行此操作",
  EVENT_IN_PAST: "活動時間已過，請修改日期",
  RATE_LIMITED: "30 天內最多送審 5 次，請稍後再試",
  INVALID_REQUEST:
    "欄位格式不正確（標題 ≤120、說明 ≤3000、地點 ≤200，結束需晚於開始）",
  NOTE_REQUIRED: "退回時必須填寫意見（≤1000 字）",
  PII_DETECTED: "偵測到個資，請重新檢視內容",
  FEATURE_DISABLED: "此功能尚未開啟",
};

async function api(
  ctx: FeatureCtx,
  path: string,
  method: string,
  payload?: unknown,
) {
  const { data } = await ctx.client!.auth.getSession();
  if (!data.session) throw Error("請重新登入");
  const res = await fetch(`/api/v1/hosted-events${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${data.session.access_token}`,
    },
    body: method === "GET" ? undefined : JSON.stringify(payload ?? {}),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw Error(ERRORS[out.code] ?? out.code ?? "請求失敗");
  return out;
}
const fmt = (s: string | null) =>
  s ? new Date(s).toLocaleString("zh-TW", { hour12: false }) : "—";
const toLocalInput = (s: string | null) => {
  const d = s ? new Date(s) : new Date(Date.now() + 7 * 864e5);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);
};

// ---------- member page ----------
async function renderMember(box: HTMLElement, ctx: FeatureCtx) {
  const { esc } = ctx;
  if (!ctx.client) {
    box.innerHTML = `<section class="panel"><h2>發起活動</h2><p class="empty">示範模式不提供發起活動。</p></section>`;
    return;
  }
  const { data: rows, error } = await ctx.client
    .from("hosted_event_requests")
    .select("*")
    .eq("host_id", ctx.user.id)
    .order("created_at", { ascending: false });
  if (error) throw error;
  const list: any[] = rows ?? [];
  box.innerHTML = `<section class="panel"><div class="row"><h2>發起活動</h2><button type="button" id="he-new">＋ 新提案</button></div>
<p class="sub">提出讀書會、科內小聚等活動，經管理員審核後上架。核准後活動預設僅限院內同仁，你可管理報名名單並為本活動現場報到。</p>
<div id="he-form"></div>
${
  list.length
    ? list
        .map(
          (r) =>
            `<div class="list-item"><div class="row"><div><strong>${esc(r.title)}</strong>
<div class="sub">${esc(fmt(r.starts_at))} – ${esc(fmt(r.ends_at))} · ${esc(r.location)}</div></div>
<span class="pill">${esc(STATUS_LABEL[r.status] ?? r.status)}</span></div>
${r.reviewer_note ? `<p class="sub">管理員意見：${esc(r.reviewer_note)}</p>` : ""}
<div class="actions">${
              r.status === "draft" || r.status === "returned"
                ? `<button type="button" class="secondary" data-edit="${esc(r.id)}">編輯</button><button type="button" data-submit="${esc(r.id)}">送審</button>`
                : ""
            }${
              ["draft", "submitted", "returned"].includes(r.status)
                ? `<button type="button" class="ghost" data-cancel="${esc(r.id)}">取消提案</button>`
                : ""
            }${
              r.status === "approved" && r.event_id
                ? `<button type="button" class="secondary" data-regs="${esc(r.id)}">報名名單</button><a class="button secondary" href="#event-checkin/${esc(r.event_id)}">現場報到</a>`
                : ""
            }</div><div class="he-regs" data-for="${esc(r.id)}"></div></div>`,
        )
        .join("")
    : `<p class="empty">尚未提出任何活動。</p>`
}</section>`;
  const reload = () => renderMember(box, ctx);
  const form = box.querySelector<HTMLElement>("#he-form")!;
  const edit = (r?: any) => {
    form.innerHTML = `<form class="panel he-edit"><h3>${r ? "編輯提案" : "新提案"}</h3>
<label>活動名稱<input name="title" maxlength="120" required value="${esc(r?.title ?? "")}"></label>
<label>說明<textarea name="description" rows="5" maxlength="3000">${esc(r?.description ?? "")}</textarea></label>
<label>地點<input name="location" maxlength="200" value="${esc(r?.location ?? "")}"></label>
<label>開始<input name="starts_at" type="datetime-local" required value="${toLocalInput(r?.starts_at ?? null)}"></label>
<label>結束<input name="ends_at" type="datetime-local" required value="${toLocalInput(r?.ends_at ?? new Date(Date.now() + 7 * 864e5 + 36e5).toISOString())}"></label>
<label>名額（可留白，預設 100）<input name="capacity" type="number" min="1" max="10000" value="${r?.capacity ?? ""}"></label>
<p class="sub">請勿填入個資（電話、身分證、Email 等）。</p>
<div class="actions"><button type="submit">儲存草稿</button><button type="button" class="ghost" id="he-close">關閉</button></div></form>`;
    form.querySelector<HTMLElement>("#he-close")!.onclick = () =>
      (form.innerHTML = "");
    form.querySelector("form")!.onsubmit = (ev) => {
      ev.preventDefault();
      const f = new FormData(ev.target as HTMLFormElement);
      void ctx.run(async () => {
        const payload = {
          title: String(f.get("title")).trim(),
          description: String(f.get("description")),
          location: String(f.get("location")),
        };
        const reviewed = await ctx.review(payload);
        if (!reviewed) return;
        const cap = String(f.get("capacity") ?? "");
        await api(ctx, "", "POST", {
          ...(r ? { id: r.id } : {}),
          ...reviewed.payload,
          starts_at: new Date(String(f.get("starts_at"))).toISOString(),
          ends_at: new Date(String(f.get("ends_at"))).toISOString(),
          capacity: cap ? Number(cap) : null,
          force_override: reviewed.force_override,
        });
        ctx.toast("草稿已儲存");
        await reload();
      });
    };
  };
  box.querySelector<HTMLElement>("#he-new")!.onclick = () => edit();
  const byId = (id?: string) => list.find((r) => r.id === id);
  box
    .querySelectorAll<HTMLElement>("[data-edit]")
    .forEach((b) => (b.onclick = () => edit(byId(b.dataset.edit))));
  box.querySelectorAll<HTMLElement>("[data-submit]").forEach(
    (b) =>
      (b.onclick = () =>
        void ctx.run(async () => {
          await api(ctx, `/${b.dataset.submit}/submit`, "POST");
          ctx.toast("已送出審核");
          await reload();
        })),
  );
  box.querySelectorAll<HTMLElement>("[data-cancel]").forEach(
    (b) =>
      (b.onclick = () =>
        void ctx.run(async () => {
          if (!confirm("確定取消這個提案？")) return;
          await api(ctx, `/${b.dataset.cancel}/cancel`, "POST");
          await reload();
        })),
  );
  box.querySelectorAll<HTMLElement>("[data-regs]").forEach(
    (b) =>
      (b.onclick = () =>
        void ctx.run(async () => {
          const out = await api(ctx, `/${b.dataset.regs}/registrations`, "GET");
          const holder = box.querySelector<HTMLElement>(
            `.he-regs[data-for="${b.dataset.regs}"]`,
          )!;
          holder.innerHTML = `<p class="sub">已報名 ${out.registered} 人 · 已報到 ${out.checked_in} 人</p><ul>${(
            out.registrations as any[]
          )
            .map(
              (g) =>
                `<li>${esc(g.applicant_name ?? "—")} · ${esc(g.organization ?? "")} · ${esc(g.status)}${g.checked_in_at ? " · 已報到" : ""}</li>`,
            )
            .join("")}</ul>`;
        })),
  );
}

// ---------- admin panel ----------
async function renderAdmin(box: HTMLElement, ctx: FeatureCtx) {
  const { esc } = ctx;
  if (!ctx.client) {
    box.innerHTML = `<p class="empty">示範模式不提供審核。</p>`;
    return;
  }
  const { data, error } = await ctx.client.rpc("hosted_event_admin_list");
  if (error) throw error;
  const rows: any[] = data ?? [];
  box.innerHTML = rows.length
    ? rows
        .map(
          (r) =>
            `<div class="list-item" data-id="${esc(r.id)}"><div class="row"><div><strong>${esc(r.title)}</strong>
<div class="sub">發起人：${esc(r.host_name ?? "—")} · ${esc(fmt(r.starts_at))} · ${esc(r.location)} · 名額 ${esc(r.capacity ?? "預設 100")}</div></div>
<span class="pill">${esc(STATUS_LABEL[r.status] ?? r.status)}</span></div>
<p class="public-prose">${esc(r.description)}</p>${r.reviewer_note ? `<p class="sub">意見：${esc(r.reviewer_note)}</p>` : ""}
${
  r.status === "submitted"
    ? `<label>意見（退回必填）<input class="he-note" maxlength="1000"></label>
<label class="fb-check"><input type="checkbox" class="he-publish" checked> 核准後立即上架（僅院內同仁可見）</label>
<label class="fb-check"><input type="checkbox" class="he-public"> 公開給外部訪客（預設不勾選）</label>
<div class="actions"><button type="button" data-act="approve">核准</button><button type="button" class="secondary" data-act="return">退回</button></div>`
    : r.status === "approved"
      ? `<div class="actions"><input class="he-note" maxlength="1000" placeholder="撤下原因（選填）" aria-label="撤下原因"><button type="button" class="secondary" data-act="revoke">撤下活動</button></div>`
      : ""
}</div>`,
        )
        .join("")
    : `<p class="empty">沒有待審的提案</p>`;
  box.querySelectorAll<HTMLElement>("[data-act]").forEach(
    (b) =>
      (b.onclick = () =>
        void ctx.run(async () => {
          const item = b.closest<HTMLElement>(".list-item")!;
          const note =
            item.querySelector<HTMLInputElement>(".he-note")?.value.trim() ??
            "";
          const reviewed = await ctx.review({ note });
          if (!reviewed) return;
          const id = item.dataset.id;
          if (b.dataset.act === "revoke") {
            if (!confirm("撤下後活動將下架，發起人失去報到權限。確定？"))
              return;
            await api(ctx, `/${id}/revoke`, "POST", {
              note: reviewed.payload.note,
              force_override: reviewed.force_override,
            });
          } else {
            await api(ctx, `/${id}/review`, "POST", {
              decision: b.dataset.act,
              note: reviewed.payload.note || undefined,
              publish:
                item.querySelector<HTMLInputElement>(".he-publish")?.checked ??
                false,
              public:
                item.querySelector<HTMLInputElement>(".he-public")?.checked ??
                false,
              force_override: reviewed.force_override,
            });
          }
          ctx.toast("已完成");
          await renderAdmin(box, ctx);
        })),
  );
}

registerFeature({
  key: "member_hosted_events",
  nav: {
    id: "hosted-events",
    label: "發起活動",
    iconPath: '<path d="M12 5v14M5 12h14"/>',
  },
  render: renderMember,
  adminPanel: {
    id: "hosted-events-review",
    label: "同仁發起活動審核",
    render: renderAdmin,
  },
});
