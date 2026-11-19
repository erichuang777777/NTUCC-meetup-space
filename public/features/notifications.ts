import { registerFeature, type FeatureCtx } from "../feature-registry";
import "./notifications.css";

const PAGE_SIZE = 20;
const POLL_MS = 60_000;
export const NOTIFICATION_TYPES: { type: string; label: string }[] = [
  { type: "private_message", label: "新私訊" },
  { type: "discussion_reply", label: "討論串有新回覆" },
  { type: "registration_review", label: "報名審核結果" },
  { type: "event_reminder", label: "活動前提醒" },
  { type: "event_feedback", label: "會後問卷開放" },
  { type: "report_handled", label: "檢舉處理結果" },
  { type: "content_hidden", label: "內容被隱藏" },
  { type: "talk_proposal_reviewed", label: "投稿審核結果" },
];

type Row = {
  id: string;
  type: string;
  title: string;
  body: string | null;
  link: string | null;
  read_at: string | null;
  created_at: string;
};

// Module-level so a re-render (which rebuilds the topbar) can dispose the previous subscription.
let teardown: (() => void) | null = null;
const badges = new Set<HTMLElement>();
let refreshCount: (() => Promise<void>) | null = null;

function setBadge(n: number) {
  for (const b of badges) {
    if (!b.isConnected) {
      badges.delete(b);
      continue;
    }
    b.textContent = n > 99 ? "99+" : String(n);
    b.hidden = n <= 0;
    b.parentElement?.setAttribute(
      "aria-label",
      n > 0 ? `通知，${n} 則未讀` : "通知",
    );
  }
}

function go(link: string | null) {
  if (!link) return;
  if (link.startsWith("#")) location.hash = link.slice(1);
  else if (link.startsWith("/") && !link.startsWith("//"))
    location.assign(link);
}

function topbar(ctx: FeatureCtx): HTMLElement | null {
  teardown?.();
  teardown = null;
  const client = ctx.client;
  if (!client || !ctx.user || !ctx.profile?.passcode_verified) return null;
  const btn = document.createElement("button");
  btn.className = "secondary notif-bell";
  btn.setAttribute("aria-label", "通知");
  btn.innerHTML =
    '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg>';
  const badge = document.createElement("span");
  badge.className = "notif-badge";
  badge.hidden = true;
  btn.append(badge);
  badges.add(badge);
  btn.onclick = () => ctx.navigate("notifications");

  const refresh = async () => {
    const { count, error } = await client
      .from("notifications")
      .select("id", { count: "exact", head: true })
      .is("read_at", null);
    if (!error) setBadge(count ?? 0);
  };
  refreshCount = refresh;
  void refresh();
  const timer = setInterval(() => {
    if (!btn.isConnected) return teardown?.();
    void refresh();
  }, POLL_MS);
  let channel: ReturnType<typeof client.channel> | null = null;
  try {
    channel = client
      .channel(`notifications-${ctx.user.id}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "notifications",
          filter: `user_id=eq.${ctx.user.id}`,
        },
        () => {
          void refresh();
          window.dispatchEvent(new Event("notifications-changed"));
        },
      )
      .subscribe();
  } catch {
    channel = null; // polling still keeps the badge fresh
  }
  teardown = () => {
    clearInterval(timer);
    if (channel) void client.removeChannel(channel);
    badges.delete(badge);
    refreshCount = null;
    teardown = null;
  };
  return btn;
}

async function render(container: HTMLElement, ctx: FeatureCtx) {
  const client = ctx.client;
  if (!client) {
    container.innerHTML =
      '<section class="panel"><h2>通知</h2><p class="muted">示例預覽模式沒有通知。</p></section>';
    return;
  }
  let pageNo = 0;
  let total = 0;
  let rows: Row[] = [];
  let prefs = new Map<string, boolean>();
  let unread = 0;
  const onChange = () => void load();
  window.addEventListener("notifications-changed", onChange);

  async function load() {
    if (!container.isConnected) {
      window.removeEventListener("notifications-changed", onChange);
      return;
    }
    const from = pageNo * PAGE_SIZE;
    const [list, unreadRes, prefRes] = await Promise.all([
      client!
        .from("notifications")
        .select("id,type,title,body,link,read_at,created_at", {
          count: "exact",
        })
        .order("created_at", { ascending: false })
        .range(from, from + PAGE_SIZE - 1),
      client!
        .from("notifications")
        .select("id", { count: "exact", head: true })
        .is("read_at", null),
      client!.from("notification_preferences").select("type,enabled"),
    ]);
    if (list.error) throw list.error;
    rows = (list.data ?? []) as Row[];
    total = list.count ?? 0;
    unread = unreadRes.count ?? 0;
    prefs = new Map((prefRes.data ?? []).map((p: any) => [p.type, p.enabled]));
    setBadge(unread);
    draw();
  }

  function draw() {
    const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    container.innerHTML = `<section class="panel notif-page"><div class="notif-head"><h2>通知</h2><button id="notif-all" class="secondary" ${unread ? "" : "disabled"}>全部標為已讀</button></div>
      <ul class="notif-list">${
        rows
          .map(
            (r) =>
              `<li><button class="notif-item${r.read_at ? "" : " unread"}" data-id="${ctx.esc(r.id)}"><strong>${ctx.esc(r.title)}</strong>${r.body ? `<span>${ctx.esc(r.body)}</span>` : ""}<time>${ctx.esc(new Date(r.created_at).toLocaleString("zh-TW"))}</time></button></li>`,
          )
          .join("") || '<li class="muted">目前沒有通知</li>'
      }</ul>
      <div class="notif-pager"><button id="notif-prev" class="secondary" ${pageNo === 0 ? "disabled" : ""}>上一頁</button><span>${pageNo + 1} / ${pages}</span><button id="notif-next" class="secondary" ${pageNo + 1 >= pages ? "disabled" : ""}>下一頁</button></div>
      <h3>通知偏好</h3><p class="muted">關閉後將不再收到該類型的站內通知。</p>
      <div class="notif-prefs">${NOTIFICATION_TYPES.map(
        (t) =>
          `<label><input type="checkbox" data-type="${t.type}" ${prefs.get(t.type) === false ? "" : "checked"}/> ${t.label}</label>`,
      ).join("")}</div></section>`;
    const q = <T extends HTMLElement>(s: string) =>
      container.querySelector<T>(s)!;
    q("#notif-all").onclick = () =>
      void ctx.run(async () => {
        const { error } = await client!.rpc("mark_all_notifications_read");
        if (error) throw error;
        await load();
      });
    q("#notif-prev").onclick = () => {
      pageNo--;
      void ctx.run(load);
    };
    q("#notif-next").onclick = () => {
      pageNo++;
      void ctx.run(load);
    };
    container.querySelectorAll<HTMLElement>(".notif-item").forEach((el) => {
      el.onclick = () =>
        void ctx.run(async () => {
          const row = rows.find((r) => r.id === el.dataset.id);
          if (!row) return;
          if (!row.read_at) {
            const { error } = await client!.rpc("mark_notifications_read", {
              p_ids: [row.id],
            });
            if (error) throw error;
            void refreshCount?.();
          }
          go(row.link);
          if (!row.link) await load();
        });
    });
    container
      .querySelectorAll<HTMLInputElement>(".notif-prefs input")
      .forEach((el) => {
        el.onchange = () =>
          void ctx.run(async () => {
            const { error } = await client!
              .from("notification_preferences")
              .upsert(
                {
                  user_id: ctx.user.id,
                  type: el.dataset.type,
                  enabled: el.checked,
                  updated_at: new Date().toISOString(),
                },
                { onConflict: "user_id,type" },
              );
            if (error) throw error;
            prefs.set(el.dataset.type!, el.checked);
            ctx.toast("偏好已儲存");
          });
      });
  }

  await load();
}

registerFeature({ key: "notifications", topbar, render });
