import {
  captureGuestLink,
  hasGuestTicket,
  mountGuestRegistration,
  guestAgentInstructions,
} from "./guest-registration";
import { registrationName } from "./event-registration-display";
import type { SupabaseClient } from "@supabase/supabase-js";
import "./public-events.css";
import { mountPhotoFrame } from "./event-photo-frame";
import {
  mountPhotoSubmissions,
  mountPublicPhotoGallery,
} from "./event-photo-submissions";
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
  agenda?: { time: string; title: string; speaker?: string }[];
  checkin_opens_at?: string | null;
  checkin_closes_at?: string | null;
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
  const agenda = (e.agenda ?? [])
    .map(
      (item) =>
        `${item.time} ${item.title}${item.speaker ? `（${item.speaker}）` : ""}`,
    )
    .join("\n");
  const details = e.description + (agenda ? `\n\n活動議程\n${agenda}` : "");
  const google = new URL("https://calendar.google.com/calendar/render");
  google.search = new URLSearchParams({
    action: "TEMPLATE",
    text: e.title,
    dates: `${iso(e.starts_at)}/${iso(e.ends_at)}`,
    details,
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
    body: details,
    location: e.location,
  }).toString();
  return { google: google.href, outlook: outlook.href };
}
export function isPublicRoute() {
  return (
    !sessionStorage.getItem("ntucc-member-invite") &&
    (!location.hash ||
      /^#(?:events|guest-ticket|event\/|event-admin|event-tokens|event-checkin|event-staff|event-photo|my-photos|access_token=)/.test(
        location.hash,
      ))
  );
}
export function mountPublicEvents(client: SupabaseClient | null) {
  const root = document.querySelector<HTMLElement>("#app")!;
  let generation = 0;
  let disposePhoto: (() => void) | null = null;
  const releasePhoto = () => {
    disposePhoto?.();
    disposePhoto = null;
  };
  window.addEventListener("pagehide", releasePhoto);
  let stopCamera: (() => void) | null = null;
  const releaseCamera = () => {
    stopCamera?.();
    stopCamera = null;
  };
  window.addEventListener("pagehide", releaseCamera);

  const request = async (
    expectedSubject: string | null,
    path = "",
    method = "GET",
    payload?: unknown,
  ) => {
    const session = client
      ? (await client.auth.getSession()).data.session
      : null;
    if ((session?.user.id ?? null) !== expectedSubject)
      throw Error("登入帳號已變更，請重新整理後確認帳號再操作。");
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
            STAFF_REQUIRED: "需要本活動授權工作人員或管理員權限。",
            CHECKIN_UNAVAILABLE: "此活動目前無法辦理報到。",
            CHECKIN_CLOSED: "目前不在本活動的報到時段內。",
            INVALID_TICKET: "票券無效、已取消，或不屬於本活動。",
            TICKET_UNAVAILABLE: "目前無法取得票券，請確認仍已報名且活動開放。",
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
    captureGuestLink();
    releaseCamera();
    releasePhoto();
    const current = ++generation;
    const active = () => current === generation && isPublicRoute();
    root.innerHTML =
      '<main class="public-home"><p role="status">正在載入公開活動…</p></main>';
    try {
      const session = client
        ? (await client.auth.getSession()).data.session
        : null;
      const api = (path = "", method = "GET", payload?: unknown) =>
        request(session?.user.id ?? null, path, method, payload);
      const restore = sessionStorage.getItem("ntucc-public-return");
      if (
        restore &&
        /^#(?:events|my-photos|event-photo\/[0-9a-f-]{36}|event\/[0-9a-f-]{36})$/i.test(
          restore,
        )
      ) {
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
      root.innerHTML = `<main class="public-home"><header class="public-header"><a href="#events" class="public-brand">NTUCC <span>MEETUP SPACES</span></a><nav aria-label="網站導覽"><a href="#events">公開活動</a><a href="#members">會員專區</a><a href="#event-tokens">Agent 報名</a>${session ? '<a href="#my-photos">我的照片</a><a href="#event-staff">工作人員報到</a>' : ""}${admin ? '<a href="#event-admin">公開內容管理</a>' : ""}</nav><button id="public-auth" class="secondary">${session ? "登出" : "會員／工作人員登入"}</button></header><p class="public-account">${session ? `目前帳號：${esc(session.user.email)}。活動報名不會開通院內會員權限。` : "瀏覽與活動報名均不需登入或註冊；會員專區與照片上傳另需登入。"}</p><p id="public-feedback" role="status" aria-live="polite"></p><div id="public-content"></div></main>`;
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
      const guestRoute = path.match(/^#guest-ticket\/([0-9a-f-]{36})$/i);
      if (guestRoute) {
        content.innerHTML =
          '<h1>訪客活動票券</h1><a href="#events">返回公開活動</a><section id="guest-private"></section>';
        await mountGuestRegistration(
          content.querySelector("#guest-private")!,
          guestRoute[1],
          true,
          active,
        );
        return;
      }
      const checkinRoute = path.match(/^#event-checkin\/([0-9a-f-]{36})$/i);
      if (path === "#event-staff" || checkinRoute) {
        if (!session) {
          content.innerHTML =
            "<h1>工作人員報到</h1><p>請先登入已授權的院內工作人員帳號。</p>";
          return;
        }
        const staffResult = await api("/staff");
        if (!active()) return;
        const events: Event[] = Array.isArray(staffResult)
          ? staffResult
          : staffResult.events;
        if (!checkinRoute) {
          content.innerHTML = `<h1>工作人員報到</h1><p>僅列出你獲授權的活動。掃描票券只用於現場報到，不會開啟票券中的網址。</p>${events.map((e) => `<article class="public-event-card"><h2>${esc(e.title)}</h2><p>${esc(date(e.starts_at))}</p><a href="#event-checkin/${esc(e.id)}">開啟報到工具</a></article>`).join("") || "<p>目前沒有獲授權的活動。</p>"}`;
          return;
        }
        const eventId = checkinRoute[1];
        const event = events.find((e) => e.id === eventId);
        if (!event) {
          content.innerHTML =
            '<h1>無法開啟報到工具</h1><p>未找到此活動或你未獲授權。</p><a href="#event-staff">返回工作人員活動</a>';
          return;
        }
        content.innerHTML = `<a href="#event-staff">← 返回工作人員活動</a><h1>${esc(event.title)} · 現場報到</h1><p>請確認出席者持有本活動票券。掃描後請再按「確認報到」，不會自動開啟任何網址。</p><button id="checkin-camera">啟用相機掃描 QR</button> <button id="checkin-stop" class="secondary">停止相機</button><video id="checkin-video" class="public-scanner" muted playsinline></video><label class="public-ticket-label">票券代碼（也可手動貼上）<input id="checkin-token" type="text" autocomplete="off" spellcheck="false" maxlength="77"></label><button id="checkin-submit">確認報到</button><p id="checkin-result" role="status" aria-live="polite"></p>`;
        const tokenInput =
          content.querySelector<HTMLInputElement>("#checkin-token")!;
        const video =
          content.querySelector<HTMLVideoElement>("#checkin-video")!;
        const message = content.querySelector<HTMLElement>("#checkin-result")!;
        const validTicket = (value: string) =>
          /^ntucc_ticket_[a-f0-9]{64}$/.test(value);
        let cameraAttempt = 0;
        const stop = () => {
          cameraAttempt++;
          releaseCamera();
        };
        action(
          content.querySelector<HTMLButtonElement>("#checkin-stop")!,
          async () => {
            stop();
            message.textContent = "相機已停止。";
          },
        );
        action(
          content.querySelector<HTMLButtonElement>("#checkin-camera")!,
          async () => {
            stop();
            const attempt = ++cameraAttempt;
            const { BrowserQRCodeReader } = await import("@zxing/browser");
            if (!active() || attempt !== cameraAttempt) return;
            const controls =
              await new BrowserQRCodeReader().decodeFromConstraints(
                {
                  audio: false,
                  video: { facingMode: { ideal: "environment" } },
                },
                video,
                (result, _error, controls) => {
                  if (!active() || attempt !== cameraAttempt) {
                    controls.stop();
                    return;
                  }
                  if (!result) return;
                  const value = result.getText().trim();
                  if (!validTicket(value)) {
                    message.textContent = "這不是本站票券，請掃描個人報名 QR。";
                    return;
                  }
                  tokenInput.value = value;
                  message.textContent =
                    "已讀取票券，請確認活動與出席者後按「確認報到」。";
                  controls.stop();
                },
              );
            if (!active() || attempt !== cameraAttempt) controls.stop();
            else stopCamera = () => controls.stop();
          },
        );
        action(
          content.querySelector<HTMLButtonElement>("#checkin-submit")!,
          async () => {
            const token = tokenInput.value.trim();
            if (!validTicket(token))
              throw Error(
                "請提供有效的本站票券代碼，不接受網址或其他 QR 內容。",
              );
            stop();
            const result = await api(`/${eventId}/check-in`, "POST", { token });
            if (!active()) return;
            message.textContent = `${result.already_checked_in ? "此票券已報到" : "報到成功"}：${result.display_name || result.registration_id}，${date(result.checked_in_at)}（台北）。`;
            tokenInput.value = "";
          },
        );
        return;
      }
      if (path === "#event-tokens") {
        if (!session) {
          content.innerHTML = guestAgentInstructions;
          return;
        }
        const { tokens } = await api("/tokens");
        if (!active()) return;
        content.innerHTML = `${guestAgentInstructions}<hr><h2>已登入帳號的舊版 Agent 授權</h2><p>Token 僅用於自己的公開活動報名與取消，不含會員內容或私訊權限。請只交給你信任且已授權的 Agent。</p><button id="event-token-create">產生報名 Token</button><div id="event-token-once"></div><ul>${tokens.map((t: any) => `<li><code>${esc(t.prefix)}…</code> 有效至 ${esc(date(t.expires_at))} <button data-token-revoke="${esc(t.id)}" class="secondary">撤銷</button></li>`).join("")}</ul><p>API：GET /api/v1/events；POST /api/v1/events/{活動 ID}/registration，取消使用 DELETE。報名時 JSON 必填 name、organization、contact_email。服務單位包含「台大」即通過輕量關鍵字判定，非身分證明；聯絡信箱可與登入信箱不同。操作自己的報名時加上 Authorization: Bearer TOKEN。請勿把 Token 放在網址或公開貼文。</p>`;
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
      const rosterRoute = path.match(
        /^#event-admin\/([0-9a-f-]{36})(?:\?page=([1-9][0-9]*))?$/i,
      );
      if (rosterRoute) {
        if (!admin) {
          content.innerHTML =
            '<h1>活動報名管理</h1><p>需要已驗證的管理員權限。</p><a href="#event-admin">返回管理</a>';
          return;
        }
        const eventId = rosterRoute[1];
        const requestedPage = Number(rosterRoute[2] ?? 1);
        if (!Number.isSafeInteger(requestedPage)) throw Error("無效的頁碼。");
        content.innerHTML =
          '<a href="#event-admin">← 返回管理</a><h1>活動報名管理</h1><p role="status">正在載入報名名單…</p>';
        try {
          const roster = await api(`/manage/${eventId}?page=${requestedPage}`);
          if (!active()) return;
          const pages = Math.max(1, Math.ceil(roster.total / roster.page_size));
          const pageLink = (page: number) =>
            `#event-admin/${eventId}?page=${page}`;
          content.innerHTML = `<a href="#event-admin">← 返回管理</a><h1>活動報名管理</h1><p>活動識別碼：<code class="public-roster-id">${esc(eventId)}</code></p><p>已報名 <strong>${esc(roster.registered)}</strong> 人 · 已取消 <strong>${esc(roster.cancelled)}</strong> 人 · 待補資料 ${esc(roster.pending ?? 0)} 人 · 未核可 ${esc(roster.rejected ?? 0)} 人 · 共 ${esc(roster.total)} 筆</p><p>僅供管理員辦理活動聯繫與報到使用，請勿公開或轉傳名單。姓名、服務單位及聯絡信箱由報名者自行填寫。單位包含「台大」即通過輕量關鍵字判定，並非身分證明，聯絡信箱不另行驗證。舊會員活動與餐盒資料不包含在內。</p>${roster.registrations.length ? `<div class="public-roster-scroll" role="region" aria-label="報名名單" tabindex="0"><table class="public-roster"><thead><tr><th scope="col">報名識別碼</th><th scope="col">報名者</th><th scope="col">資格判定</th><th scope="col">狀態</th><th scope="col">最後更新（台北）</th></tr></thead><tbody>${roster.registrations.map((r: { id: string; user_id: string; status: string; updated_at: string; display_name?: string | null; email?: string | null; applicant_name?: string | null; organization?: string; contact_email?: string; eligibility_status?: string; review_reason?: string }) => `<tr><td><code>${esc(r.id)}</code></td><td>${esc(registrationName(r))}<br>${esc(r.organization || "未填單位")}<br>${esc(r.contact_email || r.email || "未填信箱")}</td><td>${esc(({ approved: "符合關鍵字", rejected: "未符合關鍵字", pending: "待補資料" } as Record<string, string>)[r.eligibility_status || "pending"] || "未知")}</td><td>${esc(({ registered: "已報名", cancelled: "已取消", pending: "待補資料", rejected: "未核可" } as Record<string, string>)[r.status] || "未知狀態")}</td><td>${esc(date(r.updated_at))}</td></tr>`).join("")}</tbody></table></div>` : "<p>本頁沒有報名紀錄。</p>"}<nav class="public-roster-pages" aria-label="報名名單分頁">${roster.page > 1 ? `<a href="${esc(pageLink(roster.page - 1))}">上一頁</a>` : ""}<span>第 ${esc(roster.page)} 頁，共 ${esc(pages)} 頁（每頁 ${esc(roster.page_size)} 筆）</span>${roster.page < pages ? `<a href="${esc(pageLink(roster.page + 1))}">下一頁</a>` : ""}</nav>`;
        } catch (error) {
          if (!active()) return;
          content.innerHTML = `<a href="#event-admin">← 返回管理</a><h1>活動報名管理</h1><p role="alert">${esc(error instanceof Error ? error.message : "無法載入名單")}</p><button id="roster-retry">重試</button>`;
          action(
            content.querySelector<HTMLButtonElement>("#roster-retry")!,
            render,
          );
        }
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
          `<form class="public-editor" data-kind="event">${e ? `<input type="hidden" name="id" value="${esc(e.id)}">` : ""}<h2>${e ? "編輯活動" : "新增公開活動草稿"}</h2>${field("標題", "title", "text", e?.title)}<label>活動介紹<textarea name="description" required>${esc(e?.description)}</textarea></label><label>議程（每行：時間 | 主題 | 講者；講者可省略，最多 30 項）<textarea name="agenda" rows="5" placeholder="18:00 | 開場分享 | 講者姓名">${esc((e?.agenda ?? []).map((item) => [item.time, item.title, item.speaker ?? ""].join(" | ")).join("\n"))}</textarea></label>${field("地點（僅填可公開資訊）", "location", "text", e?.location)}${field("開始時間（台北）", "starts_at", "datetime-local", local(e?.starts_at ?? ""))}${field("結束時間（台北）", "ends_at", "datetime-local", local(e?.ends_at ?? ""))}${field("報名截止（台北）", "registration_closes_at", "datetime-local", local(e?.registration_closes_at ?? ""))}${field("報到開始（台北，可留空）", "checkin_opens_at", "datetime-local", local(e?.checkin_opens_at ?? "")).replace(" required", "")}${field("報到結束（台北，可留空）", "checkin_closes_at", "datetime-local", local(e?.checkin_closes_at ?? "")).replace(" required", "")}<p>報到時段請同時填入開始與結束；都留空時使用活動開始至結束時間。若 18:00 開始分享、17:30 先入場，請將報到開始另設為 17:30。</p>${field("人數上限", "capacity", "number", String(e?.capacity ?? 30))}<label>活動狀態<select name="status"><option value="scheduled" ${e?.status !== "cancelled" ? "selected" : ""}>正常舉辦</option><option value="cancelled" ${e?.status === "cancelled" ? "selected" : ""}>已取消</option></select></label><label class="check"><input name="is_published" type="checkbox" ${e?.is_published ? "checked" : ""}>我已確認內容可對外公開</label><button>儲存活動</button></form>`;
        const announcementForm = (a?: any) =>
          `<form class="public-editor" data-kind="announcement">${a ? `<input type="hidden" name="id" value="${esc(a.id)}">` : ""}<h2>${a ? "編輯公告" : "新增公開公告草稿"}</h2>${field("標題", "title", "text", a?.title)}<label>內容<textarea name="content" required>${esc(a?.content)}</textarea></label><label class="check"><input name="is_published" type="checkbox" ${a?.is_published ? "checked" : ""}>我已確認內容可對外公開</label><button>儲存公告</button></form>`;
        content.innerHTML = `<h1>公開內容管理</h1><p>這些內容與院內公布欄分開。既有院內活動、公告與報名不會自動搬到這裡。請勿放入個資、內部會議連結或未授權附件。活動變更後請另外通知已報名者，下載的行事曆不會自動同步。</p><details><summary>新增活動</summary>${eventForm()}</details><details><summary>新增公告</summary>${announcementForm()}</details>${data.events.map((e: Event) => `<details><summary>${esc(e.title)} · ${e.is_published ? "公開" : "草稿"}</summary>${eventForm(e)}<div class="public-staff-editor" data-event-id="${esc(e.id)}"><label>工作人員帳號 UUID（需已通過院內驗證）<input class="staff-user-id" type="text" autocomplete="off" placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"></label><button type="button" data-staff-method="POST">授權報到</button> <button type="button" data-staff-method="DELETE" class="secondary">撤銷報到權限</button></div><a href="#event-admin/${esc(e.id)}">查看報名名單與統計</a> · <a href="#event-checkin/${esc(e.id)}">現場報到</a>${e.is_published ? `<button type="button" data-unpublish="event" data-record-id="${esc(e.id)}" class="secondary">立即撤下公開活動</button>` : ""}</details>`).join("")}${data.announcements.map((a: any) => `<details><summary>${esc(a.title)} · ${a.is_published ? "公開" : "草稿"}</summary>${announcementForm(a)}${a.is_published ? `<button type="button" data-unpublish="announcement" data-record-id="${esc(a.id)}" class="secondary">立即撤下公開公告</button>` : ""}</details>`).join("")}`;
        content
          .querySelectorAll<HTMLButtonElement>("[data-unpublish]")
          .forEach((button) =>
            action(button, async () => {
              await api("/manage/unpublish", "POST", {
                kind: button.dataset.unpublish,
                id: button.dataset.recordId,
              });
              if (active()) await render();
            }),
          );
        content
          .querySelectorAll<HTMLButtonElement>("[data-staff-method]")
          .forEach((button) =>
            action(button, async () => {
              const editor = button.closest<HTMLElement>(
                ".public-staff-editor",
              )!;
              const userId = editor
                .querySelector<HTMLInputElement>(".staff-user-id")!
                .value.trim();
              if (
                !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
                  userId,
                )
              )
                throw Error("請輸入有效的工作人員帳號 UUID。");
              await api("/manage/staff", button.dataset.staffMethod!, {
                event_id: editor.dataset.eventId,
                user_id: userId,
              });
              feedback(
                button.dataset.staffMethod === "POST"
                  ? "已授權該帳號本活動的報到權限。"
                  : "已撤銷該帳號本活動的報到權限。管理員仍保有報到權限。",
              );
            }),
          );
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
                const lines = String(record.agenda ?? "")
                  .split(/\r?\n/)
                  .map((line) => line.trim())
                  .filter(Boolean);
                if (lines.length > 30) throw Error("議程最多 30 項。");
                record.agenda = lines.map((line) => {
                  const parts = line.split("|").map((part) => part.trim());
                  if (
                    parts.length < 2 ||
                    parts.length > 3 ||
                    !parts[0] ||
                    !parts[1] ||
                    parts[0].length > 30 ||
                    parts[1].length > 200 ||
                    (parts[2]?.length ?? 0) > 100
                  )
                    throw Error(
                      "議程格式請使用：時間 | 主題 | 講者（時間最多 30 字、主題 200 字、講者 100 字；內容請勿含 |）。",
                    );
                  return {
                    time: parts[0],
                    title: parts[1],
                    ...(parts[2] ? { speaker: parts[2] } : {}),
                  };
                });
                if (!!record.checkin_opens_at !== !!record.checkin_closes_at)
                  throw Error("請同時填入報到開始與結束時間，或同時留空。");
                for (const k of ["checkin_opens_at", "checkin_closes_at"])
                  record[k] = record[k]
                    ? new Date(record[k] + ":00+08:00").toISOString()
                    : null;
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
      const photoRoute = path.match(/^#event-photo\/([0-9a-f-]{36})$/i);
      if (photoRoute || path === "#my-photos") {
        let event: Event | null = null;
        if (photoRoute) {
          try {
            event = await api("/" + photoRoute[1]);
          } catch {
            /* Hidden events must not block owners from managing their own photos. */
          }
        }
        if (!active()) return;
        content.innerHTML = event
          ? `<a href="#event/${esc(event.id)}">← 返回活動</a><h1>${esc(event.title)} · 活動相框</h1><p>請使用你有權使用、且已取得入鏡者同意的照片。照片僅在本機瀏覽器處理，不會自動上傳或分享；下載後由你決定如何保存及使用。此相框不是報名或出席證明。</p><div id="event-photo-tool"></div><section id="event-photo-submissions"></section>`
          : '<a href="#events">← 返回公開活動</a><h1>照片管理</h1><section id="event-photo-submissions"></section>';
        const disposeFrame = event
          ? mountPhotoFrame(
              content.querySelector<HTMLElement>("#event-photo-tool")!,
              event,
            )
          : undefined;
        const submissions = content.querySelector<HTMLElement>(
          "#event-photo-submissions",
        )!;
        let disposeSubmissions: (() => void) | undefined;
        if (session && client) {
          const photoRequest = async (
            path: string,
            method = "GET",
            body?: unknown,
          ) => {
            if (!active()) throw Error("頁面已變更，請重新操作。");
            const currentSession = (await client.auth.getSession()).data
              .session;
            if (!active() || currentSession?.user.id !== session.user.id)
              throw Error("登入帳號已變更，請重新整理後操作。");
            const response = await fetch(`/api/v1/event-photos${path}`, {
              method,
              headers: {
                Authorization: `Bearer ${currentSession.access_token}`,
                ...(body !== undefined
                  ? { "Content-Type": "application/json" }
                  : {}),
              },
              ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
            });
            if (!active()) throw Error("頁面已變更，請重新操作。");
            if (!response.ok) {
              const error = await response.json().catch(() => ({}));
              throw Error(
                `照片操作未完成（${error.code ?? response.status}）。請確認已完成有效報名、檔案格式與大小。`,
              );
            }
            return response;
          };
          disposeSubmissions = mountPhotoSubmissions(
            submissions,
            photoRoute?.[1] ?? null,
            photoRequest,
            active,
            { manageOnly: !event, mineOnly: !event },
          );
        } else
          submissions.textContent = event
            ? "若要手動提交照片至私有待審或查看自己的照片，請先登入。上方本機相框不需登入，也不會上傳。"
            : "請先登入，即可管理自己的照片，不需活動保持公開。";
        disposePhoto = () => {
          disposeFrame?.();
          disposeSubmissions?.();
        };
        return;
      }
      const match = path.match(/^#event\/([0-9a-f-]{36})$/i);
      if (match) {
        const e: Event = await api("/" + match[1]);
        if (!active()) return;
        const closed =
          e.status === "cancelled" ||
          Date.now() >= Date.parse(e.registration_closes_at);
        content.innerHTML = `<a href="#events">← 返回活動</a><article class="public-event-detail"><h1>${esc(e.title)}</h1><p>${esc(date(e.starts_at))} 至 ${esc(date(e.ends_at))}（台北）</p><p>${esc(e.location)}</p><p class="public-prose">${esc(e.description)}</p>${e.agenda?.length ? `<section class="public-agenda"><h2>活動議程</h2><ol>${e.agenda.map((item) => `<li><strong>${esc(item.time)}</strong><span>${esc(item.title)}${item.speaker ? `<small>講者：${esc(item.speaker)}</small>` : ""}</span></li>`).join("")}</ol></section>` : ""}<p><a href="#event-photo/${esc(e.id)}">製作本機活動相框</a></p><p>名額 ${esc(e.capacity)} 人 · 報名截止 ${esc(date(e.registration_closes_at))}</p>${e.status === "cancelled" ? '<p class="error">活動已取消</p>' : ""}<section id="event-registration" aria-live="polite">正在讀取報名狀態…</section><section><h2>加入行事曆</h2><p>加入行事曆不代表報名完成，也不會自動同步改期或取消。請以本站活動狀態為準。</p><div class="actions"><a href="/api/v1/events/${esc(e.id)}/calendar">下載 .ics</a><a href="${esc(calendarLinks(e).google)}" target="_blank" rel="noopener noreferrer">Google 行事曆</a><a href="${esc(calendarLinks(e).outlook)}" target="_blank" rel="noopener noreferrer">Outlook</a></div></section><section id="event-public-gallery"></section></article>`;
        disposePhoto = mountPublicPhotoGallery(
          content.querySelector<HTMLElement>("#event-public-gallery")!,
          e.id,
          active,
        );
        if (!session || hasGuestTicket(e.id)) {
          await mountGuestRegistration(
            content.querySelector("#event-registration")!,
            e.id,
            closed,
            active,
          );
        } else {
          const registration = await api(`/${e.id}/registration`);
          if (!active()) return;
          const reserved = registration?.status === "registered";
          const needsDetails =
            reserved && registration?.eligibility_status === "pending";
          const registered =
            reserved && registration?.eligibility_status === "approved";
          const rejected = registration?.status === "rejected";
          const section = content.querySelector("#event-registration")!;
          section.innerHTML = registered
            ? '<p>你已報名成功。</p><button id="event-register" class="secondary">取消我的報名</button>'
            : `${rejected ? "<p>很抱歉，本活動目前開放服務單位名稱包含「台大」的參與者。你填寫的單位未符合本次規則，若填寫有誤，可更正後重新送出。</p>" : needsDetails ? "<p>原報名名額已保留。請補齊姓名、服務單位與聯絡信箱即可取得 QR，不需取消重報；即使報名已截止仍可補齊。若填寫單位不符合規則，報名將不受理並釋出名額。</p>" : registration?.status === "pending" ? "<p>請補齊姓名、服務單位與聯絡信箱後完成報名，補齊前不提供報到 QR。</p>" : ""}${closed && !(needsDetails && e.status !== "cancelled") ? "<p>目前不開放報名。</p>" : `<form id="event-application" class="public-editor"><h2>活動報名</h2><p>請填寫真實資料。服務單位包含「台大」即通過本次輕量關鍵字判定，這不等同身分或任職證明。姓名、單位與聯絡信箱僅提供主辦方活動聯繫使用，不公開。</p><label>姓名<input name="name" required maxlength="100" value="${esc(registration?.applicant_name ?? "")}"></label><label>服務單位<input name="organization" required maxlength="200" value="${esc(registration?.organization ?? "")}"></label><label>聯絡信箱<input name="contact_email" type="email" required maxlength="254" value="${esc(registration?.contact_email ?? session.user.email ?? "")}"></label><p>可填個人信箱，不需與登入信箱一致；請確認可收信，本版不另外驗證聯絡信箱。</p><button id="event-register" type="submit">確認報名</button></form>`}`;
          if (registered) {
            const ticketBox = document.createElement("div");
            ticketBox.className = "public-ticket";
            ticketBox.innerHTML = "<h2>我的報到票券</h2><p>正在載入…</p>";
            section.append(ticketBox);
            void (async () => {
              try {
                const ticket = await api(`/${e.id}/ticket`);
                const { BrowserQRCodeSvgWriter } =
                  await import("@zxing/browser");
                if (!active()) return;
                if (!/^ntucc_ticket_[a-f0-9]{64}$/.test(ticket.token))
                  throw Error("票券格式錯誤");
                ticketBox.innerHTML = `<h2>我的報到票券</h2><p>請在現場出示此 QR。票券等同報到憑證，請勿公開分享；取消報名後失效。</p><div class="public-ticket-qr"></div><details><summary>顯示票券代碼</summary><code class="event-secret">${esc(ticket.token)}</code></details><p>${ticket.checked_in_at ? `已於 ${esc(date(ticket.checked_in_at))} 報到` : "尚未報到"}</p>`;
                const svg = new BrowserQRCodeSvgWriter().write(
                  ticket.token,
                  280,
                  280,
                );
                svg.setAttribute("role", "img");
                svg.setAttribute("aria-label", "個人活動報到 QR 票券");
                ticketBox.querySelector(".public-ticket-qr")!.append(svg);
              } catch (error) {
                if (active())
                  ticketBox.textContent =
                    error instanceof Error
                      ? error.message
                      : "票券載入失敗，請重新整理。";
              }
            })();
          }
          const b = section.querySelector<HTMLButtonElement>("#event-register");
          const application =
            section.querySelector<HTMLFormElement>("#event-application");
          const submit = async () => {
            const payload = application
              ? Object.fromEntries(new FormData(application))
              : {};
            await api(
              `/${e.id}/registration`,
              registered ? "DELETE" : "POST",
              payload,
            );
            if (active()) await render();
          };
          if (b && application)
            application.onsubmit = async (event) => {
              event.preventDefault();
              if (b.disabled || !application.reportValidity()) return;
              b.disabled = true;
              try {
                await submit();
              } catch (error) {
                feedback(error instanceof Error ? error.message : "申請失敗");
              } finally {
                if (b.isConnected) b.disabled = false;
              }
            };
          else if (b) action(b, submit);
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
      releaseCamera();
      releasePhoto();
      location.reload();
    }
  });
  // Invalidate sensitive views synchronously on cross-tab account changes.
  // Defer getSession until outside Supabase's auth callback lock.
  client?.auth.onAuthStateChange((event) => {
    if (
      ["SIGNED_IN", "SIGNED_OUT", "USER_UPDATED"].includes(event) &&
      isPublicRoute()
    ) {
      generation++;
      releaseCamera();
      releasePhoto();
      root.textContent = "登入狀態已更新，正在重新載入…";
      setTimeout(() => {
        if (isPublicRoute()) void render();
      }, 0);
    }
  });
  void render();
}
