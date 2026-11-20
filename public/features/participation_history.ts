import { registerFeature, type FeatureCtx } from "../feature-registry";
import "./participation_history.css";

type Item = {
  kind: string;
  item_id: string;
  title: string;
  occurred_at: string;
  status: string;
  checked_in: boolean;
};
type Summary = Record<string, number | boolean>;

const ICON: Record<string, string> = {
  event_registration: "📅",
  meetup_registration: "🍱",
  space: "🖥️",
  talk_proposal: "🎤",
  hosted_event: "🚩",
  feedback: "📝",
};
const KIND_LABEL: Record<string, string> = {
  event_registration: "活動",
  meetup_registration: "午餐聚會",
  space: "展示",
  talk_proposal: "投稿",
  hosted_event: "發起活動",
  feedback: "回饋問卷",
};
const STATUS_LABEL: Record<string, string> = {
  registered: "已報名",
  pending: "待審核",
  waitlisted: "候補中",
  cancelled: "已取消",
  rejected: "未通過",
  private: "私人",
  public: "公開",
  draft: "草稿",
  submitted: "已送出",
  accepted: "已接受",
  returned: "退回修改",
  scheduled: "已排入議程",
  withdrawn: "已撤回",
  approved: "已核准",
};
const ERRORS: Record<string, string> = {
  FEATURE_DISABLED: "此功能目前未開啟",
  MEMBER_REQUIRED: "僅限已驗證同仁使用",
};
function fail(error: { message?: string }): never {
  throw Error(ERRORS[error.message ?? ""] ?? error.message ?? "操作失敗");
}

const DEMO_ITEMS: Item[] = [
  {
    kind: "event_registration",
    item_id: "d1",
    title: "示範活動",
    occurred_at: new Date().toISOString(),
    status: "registered",
    checked_in: true,
  },
];
const DEMO_SUMMARY: Summary = {
  events_registered: 1,
  events_attended: 1,
  show_in_directory: false,
};

const TILES: [string, string][] = [
  ["events_registered", "報名活動"],
  ["events_attended", "已出席"],
  ["spaces", "我的展示"],
  ["talk_proposals", "投稿"],
  ["hosted_events", "發起活動"],
  ["feedback_submitted", "已填回饋"],
  ["polls_voted", "參與投票"],
  ["threads", "發起討論"],
  ["replies", "回覆"],
];

/** Group timeline items by YYYY-MM (items must already be newest first). */
export function groupByMonth(items: Item[]): [string, Item[]][] {
  const m = new Map<string, Item[]>();
  for (const it of items) {
    const d = new Date(it.occurred_at);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    m.set(key, [...(m.get(key) ?? []), it]);
  }
  return [...m.entries()];
}

async function render(root: HTMLElement, ctx: FeatureCtx) {
  const { esc, client } = ctx;
  async function rpc<T>(fn: string, args?: Record<string, unknown>) {
    const { data, error } = await client!.rpc(fn, args);
    if (error) fail(error);
    return data as T;
  }
  root.innerHTML = '<p class="sub">載入我的參與紀錄…</p>';
  let items: Item[] = [],
    sum: Summary = DEMO_SUMMARY;
  if (ctx.demo || !client) items = DEMO_ITEMS;
  else {
    [items, sum] = await Promise.all([
      rpc<Item[]>("my_participation", { p_limit: 200, p_offset: 0 }),
      rpc<Summary>("my_participation_summary"),
    ]);
  }
  const draw = () => {
    root.innerHTML = `<h2>我的參與</h2><p class="sub">僅本人可見的參與紀錄。</p>
<div class="ph-tiles">${TILES.map(([k, l]) => `<div class="ph-tile"><b>${Number(sum[k] ?? 0)}</b>${l}</div>`).join("")}</div>
<label class="ph-toggle"><input type="checkbox" id="ph-show" ${sum.show_in_directory ? "checked" : ""}/> 在同仁名錄顯示我的參與統計
<small>開啟後，已列於名錄的我，其他同仁只能看到「出席活動數、分享場次、發起討論數」三個彙總數字，看不到任何活動明細。需同時在名錄公開個人資料。隨時可關閉。</small></label>
${
  items.length
    ? groupByMonth(items)
        .map(
          ([mo, list]) =>
            `<h3 class="ph-month">${mo}</h3>${list
              .map(
                (i) =>
                  `<div class="ph-item"><span class="ph-icon" title="${esc(KIND_LABEL[i.kind] ?? i.kind)}">${ICON[i.kind] ?? "•"}</span><span style="flex:1">${esc(i.title)}</span>${i.checked_in ? '<span class="ph-status">已出席</span>' : ""}<span class="ph-status">${esc(STATUS_LABEL[i.status] ?? i.status)}</span></div>`,
              )
              .join("")}`,
        )
        .join("")
    : '<p class="sub">還沒有參與紀錄。</p>'
}`;
    root.querySelector<HTMLInputElement>("#ph-show")!.onchange = (e) => {
      const show = (e.target as HTMLInputElement).checked;
      void ctx.run(async () => {
        if (ctx.demo || !client) ctx.toast("預覽模式不會儲存");
        else await rpc("set_participation_visibility", { p_show: show });
        sum = { ...sum, show_in_directory: show };
        ctx.toast(show ? "已在名錄顯示統計" : "已隱藏統計");
        draw();
      });
    };
  };
  draw();
}

/**
 * Helper for member_directory cards: renders the opt-in aggregate counts
 * (出席活動 / 分享 / 發起討論) of `userId` into `container`. Renders nothing
 * when the member has not opted in, is not listed, is blocked, or either flag is off.
 * Usage: `void renderParticipationBadge(el, member.user_id, ctx)`.
 */
export async function renderParticipationBadge(
  container: HTMLElement,
  userId: string,
  ctx: FeatureCtx,
) {
  if (
    ctx.demo ||
    !ctx.client ||
    !ctx.isEnabled("participation_history") ||
    !ctx.isEnabled("member_directory")
  )
    return;
  const { data, error } = await ctx.client.rpc("member_participation_summary", {
    p_user: userId,
  });
  if (error || !data) return;
  const d = data as {
    events_attended: number;
    talks_given: number;
    threads_started: number;
  };
  container.innerHTML = `<span class="ph-badge"><span>出席活動 ${Number(d.events_attended)}</span><span>分享 ${Number(d.talks_given)}</span><span>發起討論 ${Number(d.threads_started)}</span></span>`;
}

registerFeature({
  key: "participation_history",
  nav: {
    id: "participation_history",
    label: "我的參與",
    iconPath: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  },
  render,
});
