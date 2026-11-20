import { registerFeature, type FeatureCtx } from "../feature-registry";

const MODES: { mode: string; label: string; hint: string }[] = [
  { mode: "off", label: "關閉", hint: "不寄送任何 Email（預設）" },
  { mode: "instant", label: "即時", hint: "每則站內通知寄一封 Email" },
  {
    mode: "daily",
    label: "每日摘要",
    hint: "每天早上彙整過去 24 小時未讀通知",
  },
];
const ERRORS: Record<string, string> = {
  RATE_LIMITED: "測試信每小時最多 3 封，請稍後再試",
  ADMIN_REQUIRED: "僅管理員可使用",
  FEATURE_DISABLED: "Email 通知尚未啟用",
};

async function render(container: HTMLElement, ctx: FeatureCtx) {
  const client = ctx.client;
  if (!client || !ctx.profile?.passcode_verified) {
    container.innerHTML =
      '<section class="panel"><h2>Email 通知</h2><p class="muted">登入並通過驗證後才能設定 Email 通知。</p></section>';
    return;
  }
  const { data } = await client
    .from("email_preferences")
    .select("mode")
    .maybeSingle();
  const current = (data as { mode?: string } | null)?.mode ?? "off";
  container.innerHTML = `<section class="panel"><h2>Email 通知</h2>
    <p class="muted">信件只包含通知標題與站內連結，不含訊息內容。</p>
    <div class="email-modes">${MODES.map(
      (m) =>
        `<label><input type="radio" name="email-mode" value="${m.mode}" ${m.mode === current ? "checked" : ""}/> <strong>${m.label}</strong> <span class="muted">${m.hint}</span></label>`,
    ).join("<br/>")}</div></section>`;
  container
    .querySelectorAll<HTMLInputElement>('input[name="email-mode"]')
    .forEach((el) => {
      el.onchange = () =>
        void ctx.run(async () => {
          const { error } = await client.rpc("set_email_preference", {
            p_mode: el.value,
          });
          if (error) throw Error("儲存失敗");
          ctx.toast("Email 偏好已儲存");
        });
    });
}

async function renderAdmin(container: HTMLElement, ctx: FeatureCtx) {
  const client = ctx.client;
  if (!client) return;
  const { data, error } = await client.rpc("email_outbox_stats");
  if (error) {
    container.innerHTML = '<p class="muted">無法載入寄信統計</p>';
    return;
  }
  const counts = (data?.counts ?? {}) as Record<string, number>;
  const errors = (data?.errors ?? []) as {
    kind: string;
    status: string;
    attempts: number;
    error: string;
    at: string;
  }[];
  container.innerHTML = `<section class="panel"><h2>Email 寄送狀況</h2>
    <p>${["pending", "sending", "sent", "failed", "skipped"]
      .map((s) => `${s}: <strong>${Number(counts[s] ?? 0)}</strong>`)
      .join("　")}</p>
    <h3>最近錯誤</h3><ul>${
      errors
        .map(
          (e) =>
            `<li>${ctx.esc(e.kind)} / ${ctx.esc(e.status)} / 第 ${Number(e.attempts)} 次：${ctx.esc(e.error)}</li>`,
        )
        .join("") || '<li class="muted">無</li>'
    }</ul>
    <button id="email-test" class="secondary">寄測試信給自己</button></section>`;
  container.querySelector<HTMLButtonElement>("#email-test")!.onclick = () =>
    void ctx.run(async () => {
      const { data: s } = await client.auth.getSession();
      if (!s.session) throw Error("請重新登入");
      const res = await fetch("/api/email-test", {
        method: "POST",
        headers: { Authorization: `Bearer ${s.session.access_token}` },
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw Error(ERRORS[body.code] ?? "寄送失敗");
      ctx.toast(
        body.configured === false
          ? "已排入佇列（尚未設定寄信服務）"
          : "測試信已寄出",
      );
    });
}

registerFeature({
  key: "email_notifications",
  nav: {
    id: "email-notifications",
    label: "Email 通知",
    iconPath:
      '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
  },
  render,
  adminPanel: {
    id: "email-notifications",
    label: "Email 通知",
    render: renderAdmin,
  },
});
