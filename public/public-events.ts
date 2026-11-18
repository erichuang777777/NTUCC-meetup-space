import type { SupabaseClient } from "@supabase/supabase-js";
import "./public-events.css";
type Event = {
  id: string;
  title: string;
  description: string;
  location: string;
  starts_at: string;
  ends_at: string;
  registration_closes_at: string;
  capacity: number;
  status: string;
  is_published?: boolean;
};
const esc = (v: unknown) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
const date = (v: string) =>
  new Intl.DateTimeFormat("zh-TW", {
    timeZone: "Asia/Taipei",
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(v));
const iso = (v: string) =>
  new Date(v)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
export function calendarLinks(e: Event) {
  const google = new URL("https://calendar.google.com/calendar/render");
  google.search = new URLSearchParams({
    action: "TEMPLATE",
    text: e.title,
    dates: `${iso(e.starts_at)}/${iso(e.ends_at)}`,
    details: e.description,
    location: e.location,
  }).toString();
  const outlook = new URL(
    "https://outlook.live.com/calendar/0/deeplink/compose",
  );
  outlook.search = new URLSearchParams({
    path: "/calendar/action/compose",
    rru: "addevent",
    subject: e.title,
    startdt: new Date(e.starts_at).toISOString(),
    enddt: new Date(e.ends_at).toISOString(),
    body: e.description,
    location: e.location,
  }).toString();
  return { google: google.href, outlook: outlook.href };
}
export function isPublicRoute() {
  return (
    !sessionStorage.getItem("ntucc-member-invite") &&
    (!location.hash ||
      /^#(?:events|event\/|event-admin|event-tokens|access_token=)/.test(
        location.hash,
      ))
  );
}
export function mountPublicEvents(client: SupabaseClient | null) {
  const root = document.querySelector<HTMLElement>("#app")!;
  let generation = 0;
  const api = async (path = "", method = "GET", payload?: unknown) => {
    const session = client
      ? (await client.auth.getSession()).data.session
      : null;
    const response = await fetch(`/api/v1/events${path}`, {
      method,
      headers: {
        ...(session ? { Authorization: `Bearer ${session.access_token}` } : {}),
        ...(payload !== undefined
          ? { "Content-Type": "application/json" }
          : {}),
      },
      ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok)
      throw Error(
        (
          {
            AUTH_REQUIRED: "請先登入後再操作。",
            EMAIL_NOT_VERIFIED: "請先驗證電子郵件。",
            EVENT_FULL: "本活動已額滿。",
            REGISTRATION_CLOSED: "本活動報名已截止。",
            EVENT_CANCELLED: "本活動已取消。",
            NOT_FOUND: "此活動不存在或尚未公開。",
            RATE_LIMITED: "操作太頻繁，請稍候再試。",
          } as Record<string, string>
        )[data.code] ?? `暫時無法完成操作（${data.code ?? response.status}）。`,
      );
    return data;
  };
  async function render() {
    const current = ++generation;
    const active = () => current === generation && isPublicRoute();
    root.innerHTML =
      '<main class="public-home"><p role="status">正在載入公開活動…</p></main>';
    try {
      const session = client
        ? (await client.auth.getSession()).data.session
        : null;
      const restore = sessionStorage.getItem("ntucc-public-return");
      if (restore && /^#(?:events|event\/[0-9a-f-]{36})$/i.test(restore)) {
        sessionStorage.removeItem("ntucc-public-return");
        history.replaceState(null, "", restore);
      }
      if (!active()) return;
      let admin = false;
      if (session && client) {
        const { data } = await client
          .from("profiles")
          .select("role,passcode_verified")
          .eq("id", session.user.id)
          .maybeSingle();
        admin = data?.role === "admin" && data?.passcode_verified === true;
      }
      if (!active()) return;
      root.innerHTML = `<main class="public-home"><header class="public-header"><a href="#events" class="public-brand">NTUCC <span>MEETUP SPACES</span></a><nav aria-label="網站導覽"><a href="#events">公開活動</a><a href="#members">會員專區</a>${session ? '<a href="#event-tokens">Agent 報名</a>' : ""}${admin ? '<a href="#event-admin">公開內容管理</a>' : ""}</nav><button id="public-auth" class="secondary">${session ? "登出" : "Google 登入報名"}</button></header><p class="public-account">${session ? `目前帳號：${esc(session.user.email)}。活動報名不會開通院內會員權限。` : "不需註冊即可瀏覽公開資訊；報名時使用 Google 帳號驗證身分。"}</p><p id="public-feedback" role="status" aria-live="polite"></p><div id="public-content"></div></main>`;
      const content = root.querySelector<HTMLElement>("#public-content")!;
      const feedback = (s: string) => {
        if (active()) root.querySelector("#public-feedback")!.textContent = s;
      };
      const action = (button: HTMLButtonElement, fn: () => Promise<void>) => {
        button.onclick = async () => {
          if (button.disabled) return;
          button.disabled = true;
          feedback("");
          try {
            await fn();
          } catch (e) {
            feedback(e instanceof Error ? e.message : "操作失敗，請重試。");
          } finally {
            if (button.isConnected) button.disabled = false;
          }
        };
      };
      action(
        root.querySelector<HTMLButtonElement>("#public-auth")!,
        async () => {
          if (!client) throw Error("登入服務尚未設定，請稍後再試。");
          if (session) {
            await client.auth.signOut();
            await render();
          } else {
            sessionStorage.setItem(
              "ntucc-public-return",
              location.hash || "#events",
            );
            const { error } = await client.auth.signInWithOAuth({
              provider: "google",
              options: { redirectTo: location.origin + "/#events" },
            });
            if (error) throw error;
          }
        },
      );
      const path = location.hash;
      if (path === "#event-tokens") {
        if (!session) {
          content.innerHTML =
            "<h1>Agent 報名</h1><p>請先登入，取得只限自己活動報名的 Token。</p>";
          return;
        }
        const { tokens } = await api("/tokens");
        if (!active()) return;
        content.innerHTML = `<h1>授權 Agent 代我報名</h1><p>Token 僅用於自己的公開活動報名與取消，不含會員內容或私訊權限。請只交給你信任且已授權的 Agent。</p><button id="event-token-create">產生報名 Token</button><div id="event-token-once"></div><ul>${tokens.map((t: any) => `<li><code>${esc(t.prefix)}…</code> 有效至 ${esc(date(t.expires_at))} <button data-token-revoke="${esc(t.id)}" class="secondary">撤銷</button></li>`).join("")}</ul><p>API：GET /api/v1/events；POST /api/v1/events/{活動 ID}/registration，取消使用 DELETE。操作自己的報名時加上 Authorization: Bearer TOKEN。請勿把 Token 放在網址或公開貼文。</p>`;
        action(
          content.querySelector<HTMLButtonElement>("#event-token-create")!,
          async () => {
            const result = await api("/tokens", "POST", {});
            if (!active()) return;
            content.querySelector("#event-token-once")!.innerHTML =
              `<p>只顯示一次，離開前請妥善保存。有效至 ${esc(date(result.expires_at))}</p><code class="event-secret">${esc(result.token)}</code><p>重新整理後可在清單撤銷。</p>`;
          },
        );
        content
          .querySelectorAll<HTMLButtonElement>("[data-token-revoke]")
          .forEach((b) =>
            action(b, async () => {
              await api("/tokens", "DELETE", { id: b.dataset.tokenRevoke });
              await render();
            }),
          );
        return;
      }
      if (path === "#event-admin") {
        if (!admin) {
          content.innerHTML =
            "<h1>公開內容管理</h1><p>需要已驗證的管理員權限。</p>";
          return;
        }
        const data = await api("/manage");
        if (!active()) return;
        const field = (
          label: string,
          name: string,
          type = "text",
          value = "",
        ) =>
          `<label>${label}<input name="${name}" type="${type}" value="${esc(value)}" required></label>`;
        const local = (v: string) =>
          v
            ? new Date(new Date(v).getTime() + 8 * 3600000)
                .toISOString()
                .slice(0, 16)
            : "";
        const eventForm = (e?: Event) =>
          `<form class="public-editor" data-kind="event">${e ? `<input type="hidden" name="id" value="${esc(e.id)}">` : ""}<h2>${e ? "編輯活動" : "新增公開活動草稿"}</h2>${field("標題", "title", "text", e?.title)}<label>活動介紹<textarea name="description" required>${esc(e?.description)}</textarea></label>${field("地點（僅填可公開資訊）", "location", "text", e?.location)}${field("開始時間（台北）", "starts_at", "datetime-local", local(e?.starts_at ?? ""))}${field("結束時間（台北）", "ends_at", "datetime-local", local(e?.ends_at ?? ""))}${field("報名截止（台北）", "registration_closes_at", "datetime-local", local(e?.registration_closes_at ?? ""))}${field("人數上限", "capacity", "number", String(e?.capacity ?? 30))}<label>活動狀態<select name="status"><option value="scheduled" ${e?.status !== "cancelled" ? "selected" : ""}>正常舉辦</option><option value="cancelled" ${e?.status === "cancelled" ? "selected" : ""}>已取消</option></select></label><label class="check"><input name="is_published" type="checkbox" ${e?.is_published ? "checked" : ""}>我已確認內容可對外公開</label><button>儲存活動</button></form>`;
        const announcementForm = (a?: any) =>
          `<form class="public-editor" data-kind="announcement">${a ? `<input type="hidden" name="id" value="${esc(a.id)}">` : ""}<h2>${a ? "編輯公告" : "新增公開公告草稿"}</h2>${field("標題", "title", "text", a?.title)}<label>內容<textarea name="content" required>${esc(a?.content)}</textarea></label><label class="check"><input name="is_published" type="checkbox" ${a?.is_published ? "checked" : ""}>我已確認內容可對外公開</label><button>儲存公告</button></form>`;
        content.innerHTML = `<h1>公開內容管理</h1><p>這些內容與院內公布欄分開。既有院內活動、公告與報名不會自動搬到這裡。請勿放入個資、內部會議連結或未授權附件。活動變更後請另外通知已報名者，下載的行事曆不會自動同步。</p><details><summary>新增活動</summary>${eventForm()}</details><details><summary>新增公告</summary>${announcementForm()}</details>${data.events.map((e: Event) => `<details><summary>${esc(e.title)} · ${e.is_published ? "公開" : "草稿"}</summary>${eventForm(e)}</details>`).join("")}${data.announcements.map((a: any) => `<details><summary>${esc(a.title)} · ${a.is_published ? "公開" : "草稿"}</summary>${announcementForm(a)}</details>`).join("")}`;
        content.querySelectorAll<HTMLFormElement>("form").forEach((form) => {
          form.onsubmit = async (ev) => {
            ev.preventDefault();
            const b = form.querySelector<HTMLButtonElement>("button")!;
            if (b.disabled) return;
            b.disabled = true;
            try {
              const record: any = Object.fromEntries(new FormData(form));
              record.is_published = record.is_published === "on";
              if (form.dataset.kind === "event") {
                record.capacity = Number(record.capacity);
                for (const k of [
                  "starts_at",
                  "ends_at",
                  "registration_closes_at",
                ])
                  record[k] = new Date(record[k] + ":00+08:00").toISOString();
              }
              await api("/manage", "POST", { kind: form.dataset.kind, record });
              if (active()) {
                await render();
              }
            } catch (e) {
              feedback(e instanceof Error ? e.message : "儲存失敗");
            } finally {
              if (b.isConnected) b.disabled = false;
            }
          };
        });
        return;
      }
      const match = path.match(/^#event\/([0-9a-f-]{36})$/i);
      if (match) {
        const e: Event = await api("/" + match[1]);
        if (!active()) return;
        const closed =
          e.status === "cancelled" ||
          Date.now() >= Date.parse(e.registration_closes_at);
        content.innerHTML = `<a href="#events">← 返回活動</a><article class="public-event-detail"><h1>${esc(e.title)}</h1><p>${esc(date(e.starts_at))} 至 ${esc(date(e.ends_at))}（台北）</p><p>${esc(e.location)}</p><p class="public-prose">${esc(e.description)}</p><p>名額 ${esc(e.capacity)} 人 · 報名截止 ${esc(date(e.registration_closes_at))}</p>${e.status === "cancelled" ? '<p class="error">活動已取消</p>' : ""}<section id="event-registration" aria-live="polite">${session ? "正在讀取報名狀態…" : "請使用上方 Google 登入報名。"}</section><section><h2>加入行事曆</h2><p>加入行事曆不代表報名完成，也不會自動同步改期或取消。請以本站活動狀態為準。</p><div class="actions"><a href="/api/v1/events/${esc(e.id)}/calendar">下載 .ics</a><a href="${esc(calendarLinks(e).google)}" target="_blank" rel="noopener noreferrer">Google 行事曆</a><a href="${esc(calendarLinks(e).outlook)}" target="_blank" rel="noopener noreferrer">Outlook</a></div></section></article>`;
        if (session) {
          const registration = await api(`/${e.id}/registration`);
          if (!active()) return;
          const registered = registration?.status === "registered";
          const section = content.querySelector("#event-registration")!;
          section.innerHTML = registered
            ? '<p>你已報名成功。</p><button id="event-register" class="secondary">取消我的報名</button>'
            : closed
              ? "<p>目前不開放報名。</p>"
              : '<p>報名會將你的帳號身分提供給主辦方作為出席管理使用，不會公開名單。</p><button id="event-register">確認報名</button>';
          const b = section.querySelector<HTMLButtonElement>("button");
          if (b)
            action(b, async () => {
              await api(
                `/${e.id}/registration`,
                registered ? "DELETE" : "POST",
                {},
              );
              await render();
            });
        }
        return;
      }
      const data = await api();
      if (!active()) return;
      const card = (e: Event) =>
        `<article class="public-event-card"><p class="public-eyebrow">${e.status === "cancelled" ? "已取消" : Date.parse(e.ends_at) < Date.now() ? "過去活動" : "即將舉辦"}</p><h3><a href="#event/${esc(e.id)}">${esc(e.title)}</a></h3><p>${esc(date(e.starts_at))}（台北）</p><p>${esc(e.location)}</p><a href="#event/${esc(e.id)}">查看活動與報名 →</a></article>`;
      const upcoming = data.events
        .filter((e: Event) => Date.parse(e.ends_at) >= Date.now())
        .sort(
          (a: Event, b: Event) =>
            Date.parse(a.starts_at) - Date.parse(b.starts_at),
        );
      const past = data.events
        .filter((e: Event) => Date.parse(e.ends_at) < Date.now())
        .sort(
          (a: Event, b: Event) =>
            Date.parse(b.starts_at) - Date.parse(a.starts_at),
        );
      content.innerHTML = `<section class="public-hero"><p class="public-eyebrow">臺大癌醫 · 交流與分享</p><h1>每一次小聚，<br>讓想法走得更遠。</h1><p>在這裡查看活動、報名參與，以及回顧我們一起走過的交流時刻。</p></section><section><h2>即將舉辦</h2><div class="public-event-grid">${upcoming.map(card).join("") || "<p>目前沒有已公開的活動，歡迎稍後再來看看。</p>"}</div></section><section><h2>公告</h2>${data.announcements.map((a: any) => `<article class="public-announcement"><h3>${esc(a.title)}</h3><p class="public-prose">${esc(a.content)}</p><small>${esc(date(a.created_at))}</small></article>`).join("") || "<p>目前沒有公開公告。</p>"}</section><section><h2>過去活動</h2><div class="public-event-grid">${past.map(card).join("") || "<p>公開活動紀錄將保留在這裡。</p>"}</div></section>`;
    } catch (e) {
      if (active())
        root.innerHTML = `<main class="public-home"><h1>NTUCC Meetup Spaces</h1><p role="alert">${esc(e instanceof Error ? e.message : "無法載入活動")}</p><button id="public-retry">重試</button> <a href="#members">會員專區</a></main>`;
      root
        .querySelector<HTMLButtonElement>("#public-retry")
        ?.addEventListener("click", () => void render());
    }
  }
  window.addEventListener("hashchange", () => {
    if (isPublicRoute()) void render();
    else {
      generation++;
      location.reload();
    }
  });
  void render();
}
