import { registerFeature, type FeatureCtx } from "../feature-registry";
import "./polls.css";

type Poll = {
  id: string;
  creator_id: string;
  title: string;
  description: string;
  kind: "single" | "multiple";
  max_choices: number;
  is_anonymous: boolean;
  show_results: "always" | "after_vote" | "after_close";
  closes_at: string | null;
  attached_type: string | null;
  attached_id: string | null;
  status: "open" | "closed";
  created_at: string;
};
type ResultOption = {
  id: string;
  label: string;
  position: number;
  votes?: number;
  voters?: string[] | null;
};
type Results = {
  poll_id: string;
  is_closed: boolean;
  is_anonymous: boolean;
  visible: boolean;
  has_voted: boolean;
  my_options: string[];
  total_voters?: number;
  options: ResultOption[];
};

const ERRORS: Record<string, string> = {
  FEATURE_DISABLED: "投票功能目前未開啟",
  MEMBER_REQUIRED: "請先完成登入與通關",
  ADMIN_REQUIRED: "僅管理員可執行",
  FORBIDDEN: "沒有權限執行此操作",
  CREATE_NOT_ALLOWED: "目前僅管理員可建立投票",
  INVALID_POLL: "投票設定不正確（標題、選擇數或截止時間）",
  INVALID_OPTIONS: "選項需為 2–10 個、不可重複，每項 1–100 字",
  INVALID_ATTACHMENT: "附加的內容不存在",
  INVALID_CHOICES: "選擇的項目不符合規則",
  POLL_NOT_FOUND: "找不到此投票",
  POLL_CLOSED: "此投票已截止",
  PII_DETECTED: "偵測到個資（身分證字號或病歷號），請移除後再送出",
};
async function rpc<T = any>(
  ctx: FeatureCtx,
  fn: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  const { data, error } = await ctx.client!.rpc(fn, args);
  if (error) throw Error(ERRORS[error.message] ?? error.message);
  return data as T;
}
function isClosed(p: Poll) {
  return (
    p.status === "closed" ||
    (!!p.closes_at && new Date(p.closes_at).getTime() <= Date.now())
  );
}
function fmt(ts: string) {
  return new Date(ts).toLocaleString("zh-TW", {
    dateStyle: "medium",
    timeStyle: "short",
  });
}
const RESULT_LABEL = {
  always: "即時顯示結果",
  after_vote: "投票後顯示結果",
  after_close: "截止後顯示結果",
};

async function loadPolls(ctx: FeatureCtx, ids?: string[]) {
  let q = ctx
    .client!.from("polls")
    .select("*,poll_options(id,label,position)")
    .order("created_at", { ascending: false });
  if (ids) q = q.in("id", ids);
  const { data, error } = await q.limit(200);
  if (error) throw error;
  return (data ?? []) as (Poll & {
    poll_options: { id: string; label: string; position: number }[];
  })[];
}

/** Draw one poll (vote UI or results) into `box`. Re-renders itself after each action. */
async function drawPoll(
  box: HTMLElement,
  poll: Poll,
  ctx: FeatureCtx,
  onChange?: () => void,
) {
  const res = await rpc<Results>(ctx, "poll_results", { p_poll: poll.id });
  const closed = res.is_closed;
  const canVote = !closed;
  const canClose = !closed && (ctx.isAdmin || poll.creator_id === ctx.user?.id);
  const opts = [...res.options].sort((a, b) => a.position - b.position);
  const mine = new Set(res.my_options);
  const total = res.total_voters ?? 0;
  const max = Math.max(1, ...opts.map((o) => o.votes ?? 0));
  const input = poll.kind === "single" ? "radio" : "checkbox";
  const meta = [
    poll.kind === "single" ? "單選" : `複選（最多 ${poll.max_choices} 項）`,
    poll.is_anonymous ? "匿名" : "記名",
    RESULT_LABEL[poll.show_results],
    closed
      ? "已截止"
      : poll.closes_at
        ? `${fmt(poll.closes_at)} 截止`
        : "未設截止時間",
  ];
  const rows = opts
    .map((o) => {
      const bar =
        res.visible && o.votes !== undefined
          ? `<div class="poll-bar" role="img" aria-label="${ctx.esc(o.label)} ${o.votes} 票"><span style="width:${Math.round((o.votes / max) * 100)}%"></span></div><span class="poll-count">${o.votes} 票${total ? `（${Math.round((o.votes / total) * 100)}%）` : ""}</span>`
          : "";
      const voters =
        res.visible && o.voters?.length
          ? `<div class="poll-voters muted">${o.voters.map((v) => ctx.esc(v)).join("、")}</div>`
          : "";
      const pick = canVote
        ? `<input type="${input}" name="opt-${ctx.esc(poll.id)}" value="${ctx.esc(o.id)}" ${mine.has(o.id) ? "checked" : ""}>`
        : mine.has(o.id)
          ? '<span class="poll-mine" title="您的選擇" aria-label="您的選擇">✓</span>'
          : "";
      return `<label class="poll-option">${pick}<span class="poll-label">${ctx.esc(o.label)}</span>${bar}${voters}</label>`;
    })
    .join("");
  box.innerHTML = `<div class="poll-card"><div class="row"><h3>${ctx.esc(poll.title)}</h3><span class="badge">${closed ? "已截止" : "進行中"}</span></div>${poll.description ? `<p class="sub">${ctx.esc(poll.description)}</p>` : ""}<p class="muted poll-meta">${meta.map((m) => ctx.esc(m)).join(" · ")}</p><div class="poll-options">${rows}</div>${res.visible ? `<p class="muted">共 ${total} 人投票</p>` : '<p class="muted">結果將在符合條件後顯示。</p>'}<div class="actions">${canVote ? `<button data-vote>${res.has_voted ? "更新我的投票" : "送出投票"}</button>` : ""}${canClose ? '<button class="secondary" data-close>結束投票</button>' : ""}</div></div>`;
  const refresh = () => (onChange ? onChange() : drawPoll(box, poll, ctx));
  box.querySelector<HTMLButtonElement>("[data-vote]")?.addEventListener(
    "click",
    () =>
      void ctx.run(async () => {
        const picked = [
          ...box.querySelectorAll<HTMLInputElement>(
            ".poll-option input:checked",
          ),
        ].map((i) => i.value);
        if (!picked.length) throw Error("請至少選擇一個項目");
        if (picked.length > poll.max_choices)
          throw Error(`最多可選 ${poll.max_choices} 項`);
        await rpc(ctx, "cast_poll_vote", {
          p_poll: poll.id,
          p_options: picked,
        });
        ctx.toast("已記錄您的投票");
        await drawPoll(box, poll, ctx, onChange);
      }),
  );
  box.querySelector<HTMLButtonElement>("[data-close]")?.addEventListener(
    "click",
    () =>
      void ctx.run(async () => {
        if (!confirm("確定要結束這個投票嗎？結束後無法再投票。")) return;
        await rpc(ctx, "close_poll", { p_poll: poll.id });
        ctx.toast("投票已結束");
        await refresh();
      }),
  );
}

/**
 * Embed a poll inside another feature's page (announcement, event, thread).
 * Usage: `await renderPollEmbed(container, pollId, ctx)` — fetches the poll,
 * renders vote UI/results and keeps itself updated after voting or closing.
 * Does nothing when the `polls` flag is off or the poll cannot be read.
 */
export async function renderPollEmbed(
  container: HTMLElement,
  pollId: string,
  ctx: FeatureCtx,
) {
  container.innerHTML = "";
  if (!ctx.isEnabled("polls") || !ctx.client) return;
  try {
    const [poll] = await loadPolls(ctx, [pollId]);
    if (poll) await drawPoll(container, poll, ctx);
  } catch {
    container.innerHTML = "";
  }
}

function createForm(box: HTMLElement, ctx: FeatureCtx, done: () => void) {
  box.innerHTML = `<form class="panel poll-form"><h2>建立投票</h2>
<label>標題<input name="title" required maxlength="120"></label>
<label>說明（選填）<textarea name="description" maxlength="1000" rows="2"></textarea></label>
<label>選項（每行一個，2–10 項）<textarea name="options" required rows="4" placeholder="選項一&#10;選項二"></textarea></label>
<div class="two"><label>類型<select name="kind"><option value="single">單選</option><option value="multiple">複選</option></select></label>
<label>複選上限<input name="max_choices" type="number" min="2" max="10" value="2"></label></div>
<div class="two"><label>結果顯示<select name="show_results"><option value="always">即時顯示</option><option value="after_vote">投票後顯示</option><option value="after_close">截止後顯示</option></select></label>
<label>截止時間（選填）<input name="closes_at" type="datetime-local"></label></div>
<label class="check"><input name="is_anonymous" type="checkbox">匿名投票（不顯示投票者姓名）</label>
<p class="sub">請勿輸入身分證字號、病歷號等個資。</p>
<div class="actions"><button>建立</button><button type="button" class="ghost" data-cancel>取消</button></div></form>`;
  const form = box.querySelector("form")!;
  const kind = form.elements.namedItem("kind") as HTMLSelectElement;
  const max = form.elements.namedItem("max_choices") as HTMLInputElement;
  const sync = () => (max.disabled = kind.value === "single");
  kind.onchange = sync;
  sync();
  box.querySelector<HTMLButtonElement>("[data-cancel]")!.onclick = () =>
    (box.innerHTML = "");
  form.onsubmit = (e) => {
    e.preventDefault();
    void ctx.run(async () => {
      const f = new FormData(form);
      const options = String(f.get("options"))
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
      const reviewed = await ctx.review({
        title: f.get("title"),
        description: f.get("description"),
        options,
      });
      if (!reviewed) return;
      const p = reviewed.payload;
      const closes = String(f.get("closes_at") ?? "");
      await rpc(ctx, "create_poll", {
        p_title: p.title,
        p_description: p.description ?? "",
        p_kind: kind.value,
        p_max_choices: kind.value === "single" ? 1 : Number(max.value),
        p_is_anonymous: f.get("is_anonymous") === "on",
        p_show_results: f.get("show_results"),
        p_closes_at: closes ? new Date(closes).toISOString() : null,
        p_attached_type: null,
        p_attached_id: null,
        p_options: p.options,
      });
      ctx.toast("投票已建立");
      done();
    });
  };
}

async function renderPage(container: HTMLElement, ctx: FeatureCtx) {
  if (!ctx.client) {
    container.innerHTML =
      '<div class="panel"><h2>投票</h2><p class="sub">示範模式不提供投票，請連接 Supabase 後使用。</p></div>';
    return;
  }
  let tab: "open" | "closed" = "open";
  const settings = await ctx.client
    .from("poll_settings")
    .select("members_can_create")
    .maybeSingle();
  const canCreate = ctx.isAdmin || !!settings.data?.members_can_create;
  async function draw() {
    container.innerHTML = `<div class="row"><h2>投票與意見調查</h2>${canCreate ? '<button id="poll-new">＋ 建立投票</button>' : ""}</div><div id="poll-create"></div><div class="tabs" role="tablist"><button role="tab" class="${tab === "open" ? "" : "ghost"}" data-tab="open" aria-selected="${tab === "open"}">進行中</button><button role="tab" class="${tab === "closed" ? "" : "ghost"}" data-tab="closed" aria-selected="${tab === "closed"}">已結束</button></div><div id="poll-list" class="poll-list"><p class="sub">載入中…</p></div>`;
    container.querySelectorAll<HTMLButtonElement>("[data-tab]").forEach(
      (b) =>
        (b.onclick = () => {
          tab = b.dataset.tab as "open" | "closed";
          void draw();
        }),
    );
    container
      .querySelector<HTMLButtonElement>("#poll-new")
      ?.addEventListener("click", () =>
        createForm(
          container.querySelector<HTMLElement>("#poll-create")!,
          ctx,
          () => void draw(),
        ),
      );
    const list = container.querySelector<HTMLElement>("#poll-list")!;
    const polls = (await loadPolls(ctx)).filter(
      (p) => isClosed(p) === (tab === "closed"),
    );
    list.innerHTML = polls.length
      ? ""
      : `<div class="empty">${tab === "open" ? "目前沒有進行中的投票。" : "還沒有已結束的投票。"}</div>`;
    for (const p of polls) {
      const box = document.createElement("div");
      list.append(box);
      await drawPoll(box, p, ctx, () => void draw());
    }
  }
  await draw();
}

async function renderAdmin(container: HTMLElement, ctx: FeatureCtx) {
  if (!ctx.client) return;
  const load = async () => {
    const { data } = await ctx
      .client!.from("poll_settings")
      .select("members_can_create")
      .maybeSingle();
    const polls = (await loadPolls(ctx)).filter((p) => !isClosed(p));
    container.innerHTML = `<label class="check"><input id="poll-members-create" type="checkbox" ${data?.members_can_create ? "checked" : ""}>允許一般同仁建立投票</label>
<h3>進行中的投票</h3>${polls.map((p) => `<div class="list-item row"><span>${ctx.esc(p.title)}</span><button class="danger" data-close="${ctx.esc(p.id)}">結束</button></div>`).join("") || '<p class="sub">沒有進行中的投票。</p>'}`;
    container.querySelector<HTMLInputElement>(
      "#poll-members-create",
    )!.onchange = (e) =>
      void ctx.run(async () => {
        await rpc(ctx, "set_poll_settings", {
          p_members_can_create: (e.target as HTMLInputElement).checked,
        });
        ctx.toast("已更新投票設定");
      });
    container.querySelectorAll<HTMLButtonElement>("[data-close]").forEach(
      (b) =>
        (b.onclick = () =>
          void ctx.run(async () => {
            if (!confirm("確定要結束這個投票嗎？")) return;
            await rpc(ctx, "close_poll", { p_poll: b.dataset.close });
            ctx.toast("投票已結束");
            await load();
          })),
    );
  };
  await load();
}

registerFeature({
  key: "polls",
  nav: {
    id: "polls",
    label: "投票",
    iconPath: '<path d="M5 20V10m7 10V4m7 16v-7"/><path d="M3 20h18"/>',
  },
  render: renderPage,
  adminPanel: { id: "polls", label: "投票管理", render: renderAdmin },
});
