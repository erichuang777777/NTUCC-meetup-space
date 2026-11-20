import { mealField, editRegistrationFields } from "./registration-fields";
// Guest credentials stay in memory unless the attendee explicitly saves their private link.
const revisions = new WeakMap<Element, number>();
const credentials = new Map<string, string>();
const pending = new Map<string, { key: string; payload: string }>();
const esc = (s: unknown) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
export function captureGuestLink() {
  const m = location.hash.match(
    /^#guest-ticket\/([0-9a-f-]{36})\/(ntucc_guest_[a-f0-9]{64})$/i,
  );
  if (m) {
    credentials.set(m[1], m[2]);
    history.replaceState(null, "", `#guest-ticket/${m[1]}`);
  }
}
export function hasGuestTicket(id: string) {
  return credentials.has(id);
}
export const guestAgentInstructions = `<h1>Agent 免登入報名</h1><p>不需要網站帳號、Google 登入或預先取得 API Token。請先取得使用者授權，僅提交其姓名、單位和聯絡信箱。</p><p>GET /api/v1/events 取得公開活動；POST /api/v1/events/{活動 ID}/guest-registration，JSON 必填 name、organization、contact_email。建議帶入隨機 64 位十六進位 Idempotency-Key，網路重試時沿用同一把，避免重複報名。</p><p>成功回應包含 management_token、報到票券及 calendar_url。請將 QR 圖片與 .ics 行事曆交給使用者，並私下交付管理憑證。修改時 PATCH 同一路徑並提供 name、organization、contact_email、meal_preference（葷食／素食／不需餐盒）；取消時 DELETE。建立時也可帶 meal_preference，預設不需餐盒。管理或取消時使用 Authorization: Bearer management_token；不要把憑證放在查詢參數、日誌或公開內容。</p><p>聯絡信箱不驗證、不自動寄信；報名不建立論壇會員，也不開通內部權限。</p>`;
async function guestApi(
  id: string,
  method = "GET",
  payload?: unknown,
  key?: string,
  ticket = false,
) {
  const response = await fetch(
    `/api/v1/events/${id}/${ticket ? "guest-ticket" : "guest-registration"}`,
    {
      method,
      credentials: "omit",
      cache: "no-store",
      headers: {
        ...(credentials.has(id) && method !== "POST"
          ? { Authorization: `Bearer ${credentials.get(id)}` }
          : {}),
        ...(payload ? { "Content-Type": "application/json" } : {}),
        ...(key ? { "Idempotency-Key": key } : {}),
      },
      ...(payload ? { body: JSON.stringify(payload) } : {}),
    },
  );
  const data = await response.json();
  if (!response.ok)
    throw Error(
      (
        {
          EVENT_FULL: "本活動已額滿。",
          REGISTRATION_CONFLICT:
            "無法新增此報名，請使用原私人管理連結或聯絡主辦人確認，勿重複報名。",
          REGISTRATION_NOT_ACTIVE: "這筆報名已失效，無法修改。",
          REGISTRATION_ALREADY_CHECKED_IN: "已報到的資料請聯絡主辦人修改。",
          INVALID_REGISTRATION_IDENTITY: "管理憑證無效，請使用原私人管理連結。",
          REGISTRATION_CLOSED: "報名已截止。",
          EVENT_CANCELLED: "活動已取消。",
          RATE_LIMITED: "操作太頻繁，請稍候重試。",
          INVALID_GUEST_TOKEN: "管理憑證無效，請使用先前保存的私人連結。",
          GUEST_TOKEN_REQUIRED: "請使用先前保存的私人管理連結。",
          GUEST_ACCESS_EXPIRED: "私人管理連結已到期，請聯絡活動主辦人。",
          ORGANIZATION_NOT_ELIGIBLE:
            "很抱歉，本活動限定臺大醫療體系同仁參加，單位需包含台大或臺大。",
          EVENT_NOT_FOUND: "活動目前未開放報名。",
          TICKET_UNAVAILABLE: "票券目前無法使用。",
          IDEMPOTENCY_CONFLICT: "重試資料與原報名不同，請重新開啟活動頁。",
        } as Record<string, string>
      )[data.code] ?? `無法完成操作（${data.code ?? response.status}）。`,
    );
  return data;
}
function download(name: string, contents: string, type: string) {
  const url = URL.createObjectURL(new Blob([contents], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export async function mountGuestRegistration(
  root: Element,
  id: string,
  closed: boolean,
  renderActive: () => boolean,
) {
  const revision = (revisions.get(root) ?? 0) + 1;
  revisions.set(root, revision);
  const active = () => renderActive() && revisions.get(root) === revision;
  const feedback = (s: string) => {
    if (active()) root.querySelector('[role="status"]')!.textContent = s;
  };
  if (credentials.has(id)) {
    root.innerHTML = '<p role="status">正在載入訪客報名…</p>';
    try {
      const registration = await guestApi(id);
      if (!active()) return;
      const link = `${location.origin}/#guest-ticket/${id}/${credentials.get(id)}`;
      root.innerHTML = `<h2>我的訪客報名</h2><p>${registration.status === "registered" ? "報名成功" : registration.status === "cancelled" ? "報名已取消，原票券已失效。" : "本次報名未通過單位關鍵字規則。"}</p><p>不會自動寄信。請保存私人管理連結，遺失後不能只憑信箱取回。任何持有此連結的人都能查看或取消這筆報名，請勿轉傳。</p><button id="guest-save">下載私人管理連結</button> <a href="/api/v1/events/${id}/calendar">下載活動行事曆 .ics</a>${registration.status === "registered" && (registration.can_edit ?? !closed) && !registration.checked_in_at ? `<details><summary>修改報名資料</summary><form id="guest-edit" class="public-editor">${editRegistrationFields(registration)}<button>儲存修改</button></form></details>` : ""}<div id="guest-qr"></div>${registration.status === "registered" ? '<button id="guest-cancel" class="secondary">取消我的報名</button>' : ""}<p role="status"></p>`;
      root.querySelector<HTMLButtonElement>("#guest-save")!.onclick = () =>
        download("meetup-private-ticket.txt", link, "text/plain;charset=utf-8");
      const edit = root.querySelector<HTMLFormElement>("#guest-edit");
      if (edit)
        edit.onsubmit = async (event) => {
          event.preventDefault();
          const button = edit.querySelector("button")!;
          if (button.disabled || !edit.reportValidity()) return;
          button.disabled = true;
          try {
            await guestApi(id, "PATCH", Object.fromEntries(new FormData(edit)));
            if (active()) {
              await mountGuestRegistration(root, id, closed, renderActive);
              if (renderActive() && revisions.get(root) === revision + 1)
                root.querySelector('[role="status"]')!.textContent =
                  "報名資料已更新。";
            }
          } catch (e) {
            feedback(e instanceof Error ? e.message : "修改失敗");
          } finally {
            if (button.isConnected) button.disabled = false;
          }
        };
      const cancel = root.querySelector<HTMLButtonElement>("#guest-cancel");
      if (cancel)
        cancel.onclick = async () => {
          if (
            cancel.disabled ||
            !confirm("確定取消這筆活動報名？原報到 QR 將失效。")
          )
            return;
          cancel.disabled = true;
          try {
            await guestApi(id, "DELETE");
            if (active())
              await mountGuestRegistration(root, id, closed, renderActive);
          } catch (e) {
            feedback(e instanceof Error ? e.message : "取消失敗");
          } finally {
            if (cancel.isConnected) cancel.disabled = false;
          }
        };
      if (registration.status === "registered") {
        const ticket = await guestApi(id, "GET", undefined, undefined, true);
        const { BrowserQRCodeSvgWriter } = await import("@zxing/browser");
        if (!active()) return;
        if (!/^ntucc_ticket_[a-f0-9]{64}$/.test(ticket.token))
          throw Error("票券格式錯誤");
        const svg = new BrowserQRCodeSvgWriter().write(ticket.token, 280, 280);
        svg.setAttribute("role", "img");
        svg.setAttribute("aria-label", "個人活動報到 QR 票券");
        const box = root.querySelector("#guest-qr")!;
        box.innerHTML =
          "<p>現場出示此 QR 供工作人員報到；QR 不含姓名或信箱，請勿公開。</p>";
        box.append(svg);
        const button = document.createElement("button");
        button.textContent = "下載 QR Code";
        button.onclick = () =>
          download(
            "meetup-ticket.svg",
            new XMLSerializer().serializeToString(svg),
            "image/svg+xml",
          );
        box.append(button);
      }
    } catch (e) {
      if (active()) feedback(e instanceof Error ? e.message : "票券載入失敗");
    }
    return;
  }
  root.innerHTML = closed
    ? "<p>目前不開放報名。</p>"
    : `<form class="public-editor" id="guest-application"><h2>免登入報名活動</h2><p>不需註冊網站會員。請填寫真實資料；單位含「台大／臺大」即可通過輕量關鍵字判定，並非任職身分驗證。資料僅供主辦方活動聯繫，不公開。</p><label>姓名<input name="name" required maxlength="100" autocomplete="name"></label><label>服務單位<input name="organization" required maxlength="200" autocomplete="organization"></label><label>聯絡信箱<input name="contact_email" type="email" required maxlength="254" autocomplete="email"></label><p>可填個人信箱，不需院內信箱。不驗證信箱，也不自動寄信；完成後請下載 QR、私人管理連結及行事曆。</p>${mealField()}<button type="submit">確認報名</button></form><p role="status"></p>`;
  const form = root.querySelector<HTMLFormElement>("#guest-application");
  if (form)
    form.onsubmit = async (event) => {
      event.preventDefault();
      const button = form.querySelector("button")!;
      if (button.disabled || !form.reportValidity()) return;
      const payload = Object.fromEntries(new FormData(form)),
        serialized = JSON.stringify(payload);
      if (pending.get(id)?.payload !== serialized)
        pending.set(id, {
          payload: serialized,
          key: Array.from(crypto.getRandomValues(new Uint8Array(32)), (n) =>
            n.toString(16).padStart(2, "0"),
          ).join(""),
        });
      button.disabled = true;
      try {
        const data = await guestApi(id, "POST", payload, pending.get(id)!.key);
        if (data.status !== "registered") {
          feedback(
            "很抱歉，本活動限服務單位包含「台大／臺大」的同仁報名。請確認單位填寫是否正確。",
          );
          return;
        }
        if (!/^ntucc_guest_[a-f0-9]{64}$/.test(data.management_token))
          throw Error("管理憑證格式錯誤");
        credentials.set(id, data.management_token);
        pending.delete(id);
        if (active())
          await mountGuestRegistration(root, id, closed, renderActive);
      } catch (e) {
        feedback(e instanceof Error ? e.message : "報名失敗，請重試");
      } finally {
        if (button.isConnected) button.disabled = false;
      }
    };
}
