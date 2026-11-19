import { registerFeature, type FeatureCtx } from "../feature-registry";
import { isEnabled } from "../features";
import "./talk_proposals.css";

type Proposal = {
  id: string;
  title: string;
  abstract: string;
  category_tag: "實戰展示" | "踩坑避雷";
  duration_minutes: number;
  preferred_event_id: string | null;
  pain_point_id: string | null;
  status:
    "draft" | "submitted" | "accepted" | "returned" | "scheduled" | "withdrawn";
  reviewer_note: string | null;
  scheduled_event_id: string | null;
  created_at: string;
};
type EventLite = { id: string; title: string; starts_at: string };
export type ProposalDraft = Partial<
  Pick<
    Proposal,
    | "id"
    | "title"
    | "abstract"
    | "category_tag"
    | "duration_minutes"
    | "preferred_event_id"
    | "pain_point_id"
  >
>;

const STATUS_LABEL: Record<Proposal["status"], string> = {
  draft: "草稿",
  submitted: "審核中",
  accepted: "已接受",
  returned: "退回修改",
  scheduled: "已排入議程",
  withdrawn: "已撤回",
};
const DURATIONS = [5, 10, 15, 20];
const ERRORS: Record<string, string> = {
  FEATURE_DISABLED: "徵稿功能目前未開啟",
  MEMBER_REQUIRED: "請先完成登入與通關",
  ADMIN_REQUIRED: "僅管理員可執行",
  PROPOSAL_NOT_FOUND: "找不到這份投稿",
  NOT_EDITABLE: "投稿審核中或已定案，無法編輯",
  INVALID_TRANSITION: "目前的狀態無法執行這個操作",
  INVALID_PROPOSAL: "投稿內容不完整或格式不正確（標題 120 字、摘要 1500 字內）",
  INVALID_STATUS: "不支援的審核結果",
  INVALID_NOTE: "審核意見過長（上限 1000 字）",
  NOTE_REQUIRED: "退回時請填寫意見",
  EVENT_NOT_FOUND: "找不到指定的活動",
  PAIN_POINT_NOT_FOUND: "找不到指定的痛點",
  AGENDA_FULL: "該活動議程已滿 30 項",
  PII_DETECTED: "偵測到個資，請移除後再送出",
};
const friendly = (m: string) => ERRORS[m] ?? m ?? "操作失敗";

async function rpc<T = any>(
  ctx: FeatureCtx,
  fn: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  const { data, error } = await ctx.client!.rpc(fn, args);
  if (error) throw Error(friendly(error.message));
  return data as T;
}
async function api(
  ctx: FeatureCtx,
  path: string,
  method: string,
  payload: unknown,
) {
  const { data: s } = await ctx.client!.auth.getSession();
  if (!s.session) throw Error("請重新登入");
  const res = await fetch(`/api/v1/talk-proposals${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${s.session.access_token}`,
    },
    body: JSON.stringify(payload ?? {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (data.code === "PII_DETECTED")
      ctx.toast("後端偵測到個資，請重新檢視內容");
    throw Error(friendly(data.code));
  }
  return data;
}
const fmtDate = (s: string) =>
  new Date(s).toLocaleDateString("zh-TW", { month: "numeric", day: "numeric" });
async function loadEvents(ctx: FeatureCtx): Promise<EventLite[]> {
  if (!ctx.client) return [];
  const { data } = await ctx.client
    .from("public_events")
    .select("id,title,starts_at")
    .gte("ends_at", new Date().toISOString())
    .order("starts_at");
  return (data ?? []) as EventLite[];
}

/** Proposal editor. Saves through the API after the shared PII dialog. */
function proposalForm(
  box: HTMLElement,
  ctx: FeatureCtx,
  initial: ProposalDraft,
  events: EventLite[],
  done: () => void,
) {
  const { esc } = ctx;
  const editing = !!initial.id;
  box.innerHTML = `<form class="panel tp-form"><h2>${editing ? "編輯投稿" : "我要投稿"}</h2>
<label>題目（120 字內）<input name="title" required maxlength="120" value="${esc(initial.title ?? "")}"></label>
<label>摘要（1500 字內，請勿輸入個資或病人資訊）<textarea name="abstract" required maxlength="1500" rows="6">${esc(initial.abstract ?? "")}</textarea></label>
<div class="two"><label>類型<select name="category_tag">${["實戰展示", "踩坑避雷"].map((c) => `<option ${c === (initial.category_tag ?? "實戰展示") ? "selected" : ""}>${c}</option>`).join("")}</select></label>
<label>預計時長<select name="duration_minutes">${DURATIONS.map((d) => `<option value="${d}" ${d === (initial.duration_minutes ?? 10) ? "selected" : ""}>${d} 分鐘</option>`).join("")}</select></label></div>
<label>希望場次（選填）<select name="preferred_event_id"><option value="">無特別希望</option>${events.map((e) => `<option value="${esc(e.id)}" ${e.id === initial.preferred_event_id ? "selected" : ""}>${esc(fmtDate(e.starts_at))} ${esc(e.title)}</option>`).join("")}</select></label>
${initial.pain_point_id ? `<p class="sub">此投稿將連結到你選擇的痛點。</p>` : ""}
<div class="actions"><button data-act="draft">儲存草稿</button><button data-act="submit" class="secondary">儲存並送出審核</button><button type="button" class="ghost" data-cancel>取消</button></div></form>`;
  const form = box.querySelector("form")!;
  box.querySelector<HTMLButtonElement>("[data-cancel]")!.onclick = () => {
    box.innerHTML = "";
    done();
  };
  let submit = false;
  form
    .querySelectorAll<HTMLButtonElement>("[data-act]")
    .forEach((b) => (b.onclick = () => (submit = b.dataset.act === "submit")));
  form.onsubmit = (e) => {
    e.preventDefault();
    const wantSubmit = submit;
    void ctx.run(async () => {
      const f = new FormData(form);
      const reviewed = await ctx.review({
        title: f.get("title"),
        abstract: f.get("abstract"),
      });
      if (!reviewed) return;
      const body = {
        title: String(reviewed.payload.title),
        abstract: String(reviewed.payload.abstract),
        category_tag: f.get("category_tag"),
        duration_minutes: Number(f.get("duration_minutes")),
        preferred_event_id: f.get("preferred_event_id") || null,
        pain_point_id: initial.pain_point_id ?? null,
        submit: wantSubmit,
        force_override: reviewed.force_override,
      };
      await api(
        ctx,
        initial.id ? `/${initial.id}` : "",
        initial.id ? "PUT" : "POST",
        body,
      );
      ctx.toast(wantSubmit ? "已送出審核" : "草稿已儲存");
      box.innerHTML = "";
      done();
    });
  };
}

/** Opens the proposal form in a modal (used by the pain-point "我來解這個痛點" button). */
export async function openProposalDialog(
  ctx: FeatureCtx,
  draft: ProposalDraft,
) {
  const events = await loadEvents(ctx);
  const d = document.createElement("dialog");
  d.className = "tp-dialog";
  const box = document.createElement("div");
  d.append(box);
  document.body.append(d);
  d.addEventListener("close", () => d.remove());
  proposalForm(box, ctx, draft, events, () => d.close());
  d.showModal();
}

// ---------- member page ----------
async function renderPage(container: HTMLElement, ctx: FeatureCtx) {
  const { esc } = ctx;
  if (!ctx.client) {
    container.innerHTML =
      '<div class="panel"><h2>徵稿</h2><p class="sub">示範模式不提供徵稿，請連接 Supabase 後使用。</p></div>';
    return;
  }
  const events = await loadEvents(ctx);
  const eventTitle = (id: string | null) =>
    events.find((e) => e.id === id)?.title;
  async function draw() {
    container.innerHTML = `<div class="row"><h2>徵稿與講者報名</h2><button id="tp-new">＋ 我要投稿</button></div><div id="tp-form"></div>
<section><h3>我的投稿</h3><div id="tp-mine" class="tp-list"><p class="sub">載入中…</p></div></section>
<section><h3>已接受的分享</h3><div id="tp-accepted" class="tp-list"><p class="sub">載入中…</p></div></section>`;
    const formBox = container.querySelector<HTMLElement>("#tp-form")!;
    const open = (draft: ProposalDraft) => {
      proposalForm(formBox, ctx, draft, events, () => void draw());
      formBox.scrollIntoView?.({ block: "nearest" });
    };
    container.querySelector<HTMLButtonElement>("#tp-new")!.onclick = () =>
      open({});
    await ctx.run(async () => {
      const [mine, accepted] = await Promise.all([
        ctx
          .client!.from("talk_proposals")
          .select("*")
          .eq("proposer_id", ctx.user.id)
          .order("created_at", { ascending: false }),
        rpc<any[]>(ctx, "list_accepted_talks"),
      ]);
      if (mine.error) throw Error(friendly(mine.error.message));
      const rows = (mine.data ?? []) as Proposal[];
      container.querySelector("#tp-mine")!.innerHTML = rows.length
        ? rows
            .map((p) => {
              const editable = p.status === "draft" || p.status === "returned";
              const withdrawable = [
                "draft",
                "submitted",
                "returned",
                "accepted",
              ].includes(p.status);
              return `<article class="tp-card" data-id="${esc(p.id)}"><div class="row"><div><strong>${esc(p.title)}</strong><div class="sub">${esc(p.category_tag)} · ${p.duration_minutes} 分鐘${eventTitle(p.preferred_event_id) ? ` · 希望：${esc(eventTitle(p.preferred_event_id))}` : ""}</div></div><span class="tp-status tp-${p.status}">${STATUS_LABEL[p.status]}</span></div>
<p class="detail-summary">${esc(p.abstract)}</p>${p.status === "returned" && p.reviewer_note ? `<p class="tp-note">管理員意見：${esc(p.reviewer_note)}</p>` : ""}
<div class="actions">${editable ? `<button class="secondary" data-edit>編輯</button><button data-submit>送出審核</button>` : ""}${withdrawable ? `<button class="ghost" data-withdraw>撤回</button>` : ""}</div></article>`;
            })
            .join("")
        : '<p class="empty">還沒有投稿。把你的實戰經驗或踩坑心得分享給大家吧。</p>';
      container.querySelectorAll<HTMLElement>(".tp-card").forEach((card) => {
        const p = rows.find((r) => r.id === card.dataset.id)!;
        const on = (sel: string, fn: () => Promise<void>) => {
          const b = card.querySelector<HTMLButtonElement>(sel);
          if (b) b.onclick = () => void ctx.run(fn);
        };
        const edit = card.querySelector<HTMLButtonElement>("[data-edit]");
        if (edit) edit.onclick = () => open(p);
        on("[data-submit]", async () => {
          await api(ctx, `/${p.id}/submit`, "POST", {});
          ctx.toast("已送出審核");
          await draw();
        });
        on("[data-withdraw]", async () => {
          if (!confirm("確定要撤回這份投稿嗎？撤回後無法恢復。")) return;
          await api(ctx, `/${p.id}/withdraw`, "POST", {});
          ctx.toast("已撤回");
          await draw();
        });
      });
      container.querySelector("#tp-accepted")!.innerHTML = accepted.length
        ? accepted
            .map(
              (t) =>
                `<article class="tp-card"><strong>${esc(t.title)}</strong><div class="sub">${esc(t.proposer_name)} · ${esc(t.category_tag)} · ${t.duration_minutes} 分鐘 · ${t.status === "scheduled" ? "已排入議程" : "已接受"}</div></article>`,
            )
            .join("")
        : '<p class="empty">目前還沒有已接受的分享</p>';
    });
  }
  await draw();
}

// ---------- admin panel ----------
async function renderAdmin(box: HTMLElement, ctx: FeatureCtx) {
  const { esc } = ctx;
  if (!ctx.client) {
    box.innerHTML = `<p class="empty">示範模式不提供徵稿審核。</p>`;
    return;
  }
  const events = await loadEvents(ctx);
  async function load() {
    const rows = await rpc<any[]>(ctx, "talk_proposals_admin_list");
    const order = ["submitted", "accepted", "returned", "scheduled"];
    rows.sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status));
    box.innerHTML = rows.length
      ? `<div class="tp-list">${rows
          .map(
            (p) =>
              `<article class="tp-card" data-id="${esc(p.id)}"><div class="row"><div><strong>${esc(p.title)}</strong><div class="sub">${esc(p.proposer_name)} · ${esc(p.category_tag)} · ${p.duration_minutes} 分鐘${p.preferred_event_title ? ` · 希望：${esc(p.preferred_event_title)}` : ""}${p.pain_point_title ? ` · 痛點：${esc(p.pain_point_title)}` : ""}${p.scheduled_event_title ? ` · 已排入：${esc(p.scheduled_event_title)}` : ""}</div></div><span class="tp-status tp-${p.status}">${STATUS_LABEL[p.status as Proposal["status"]]}</span></div>
<details><summary>摘要</summary><p class="detail-summary">${esc(p.abstract)}</p></details>${p.reviewer_note ? `<p class="tp-note">已留意見：${esc(p.reviewer_note)}</p>` : ""}
${
  p.status === "submitted"
    ? `<label>審核意見（退回時必填）<textarea data-note rows="2" maxlength="1000"></textarea></label><div class="actions"><button data-accept>接受</button><button class="secondary" data-return>退回修改</button></div>`
    : p.status === "accepted"
      ? `<div class="actions"><select data-event>${events.map((e) => `<option value="${esc(e.id)}" ${e.id === p.preferred_event_id ? "selected" : ""}>${esc(fmtDate(e.starts_at))} ${esc(e.title)}</option>`).join("")}</select><button data-schedule ${events.length ? "" : "disabled"}>排入議程</button></div>`
      : ""
}</article>`,
          )
          .join("")}</div>`
      : `<p class="empty">目前沒有待審核的投稿</p>`;
    box.querySelectorAll<HTMLElement>(".tp-card").forEach((card) => {
      const id = card.dataset.id!;
      const note = () =>
        card.querySelector<HTMLTextAreaElement>("[data-note]")?.value.trim() ??
        "";
      const act = (sel: string, fn: () => Promise<void>) => {
        const b = card.querySelector<HTMLButtonElement>(sel);
        if (b) b.onclick = () => void ctx.run(fn);
      };
      const review = async (status: "accepted" | "returned") => {
        let text: string | null = note() || null;
        if (status === "returned" && !text) throw Error(ERRORS.NOTE_REQUIRED);
        if (text) {
          const r = await ctx.review({ note: text });
          if (!r) return;
          text = String(r.payload.note);
        }
        await rpc(ctx, "review_talk_proposal", {
          p_id: id,
          p_status: status,
          p_note: text,
        });
        ctx.toast(status === "accepted" ? "已接受" : "已退回");
        await load();
      };
      act("[data-accept]", () => review("accepted"));
      act("[data-return]", () => review("returned"));
      act("[data-schedule]", async () => {
        const ev = card.querySelector<HTMLSelectElement>("[data-event]")!.value;
        await rpc(ctx, "schedule_talk_proposal", { p_id: id, p_event_id: ev });
        ctx.toast("已排入活動議程");
        await load();
      });
    });
  }
  await ctx.run(load);
}

// ---------- pain-point integration (hook used by app.ts painView) ----------
/**
 * Adds a 「已有人認領」 badge and a 「我來解這個痛點」 button to each pain-point card
 * rendered by app.ts. No-op while the flag is off, without a client, or in demo mode.
 */
export async function decoratePainPoints(root: HTMLElement, ctx: FeatureCtx) {
  if (!isEnabled("talk_proposals") || !ctx.client || ctx.demo) return;
  let counts = new Map<string, number>();
  try {
    const { data, error } = await ctx.client.rpc("pain_point_claim_counts");
    if (error) return;
    counts = new Map(
      ((data ?? []) as { pain_point_id: string; claims: number }[]).map((r) => [
        r.pain_point_id,
        r.claims,
      ]),
    );
  } catch {
    return;
  }
  root.querySelectorAll<HTMLElement>("[data-pain-vote]").forEach((vote) => {
    const id = vote.dataset.painVote!;
    const card = vote.closest<HTMLElement>(".pain-item");
    if (!card || card.querySelector(".tp-pain")) return;
    const title = card.querySelector("h3")?.textContent ?? "";
    const wrap = document.createElement("div");
    wrap.className = "tp-pain";
    if (counts.get(id)) {
      const badge = document.createElement("span");
      badge.className = "tp-badge";
      badge.textContent = "已有人認領";
      wrap.append(badge);
    }
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "secondary";
    btn.textContent = "我來解這個痛點";
    btn.onclick = () =>
      void openProposalDialog(ctx, {
        pain_point_id: id,
        title: title ? `解決：${title}`.slice(0, 120) : "",
      });
    wrap.append(btn);
    card.append(wrap);
  });
}

registerFeature({
  key: "talk_proposals",
  nav: {
    id: "talk_proposals",
    label: "徵稿",
    iconPath:
      '<path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Z"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
  },
  render: renderPage,
  adminPanel: { id: "talk_proposals", label: "徵稿審核", render: renderAdmin },
});
