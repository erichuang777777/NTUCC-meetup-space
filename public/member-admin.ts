const e = (v: unknown) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
interface Options {
  ownId: string;
  request: (method: string, payload?: any, query?: string) => Promise<any>;
  toast: (message: string) => void;
  back: () => void;
}
export async function mountMemberAdmin(root: HTMLElement, o: Options) {
  let query = "",
    offset = 0;
  const run = async (fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (err) {
      o.toast(err instanceof Error ? err.message : "操作失敗");
    }
  };
  async function list() {
    const data = await o.request(
      "GET",
      undefined,
      `?offset=${offset}&query=${encodeURIComponent(query)}`,
    );
    if (!root.isConnected) return;
    root.innerHTML = `<button id="members-back" class="text-button">← 管理</button><div class="page-heading"><h1>成員</h1><button id="invite-person">邀請同仁</button></div><form id="member-search"><input name="query" type="search" placeholder="搜尋信箱" aria-label="搜尋成員信箱" value="${e(query)}"></form><div class="member-list">${data.members.map((m: any) => `<div class="member-row"><div><strong>${e(m.display_name)}</strong><span class="muted">${e(m.email)}</span><small>${m.passcode_verified ? e(m.department) : "待驗證"}</small></div><select aria-label="${e(m.display_name)}的權限" data-member-role="${m.id}" ${m.id === o.ownId ? "disabled" : ""}><option value="member" ${m.role === "member" ? "selected" : ""}>一般成員</option><option value="admin" ${m.role === "admin" ? "selected" : ""}>管理員</option></select></div>`).join("") || '<p class="empty">沒有符合的成員</p>'}</div>${data.total > 20 ? `<div class="actions"><button id="members-prev" class="ghost" ${offset === 0 ? "disabled" : ""}>上一頁</button><button id="members-next" class="ghost" ${offset + 20 >= data.total ? "disabled" : ""}>下一頁</button></div>` : ""}<details class="workspace-section"><summary>待接受的邀請${data.invitations.length ? " · " + data.invitations.length : ""}</summary>${data.invitations.map((v: any) => `<div class="row list-item"><div><span>${e(v.email)}</span><small class="muted">${v.role === "admin" ? "管理員" : "一般成員"} · ${new Date(v.expires_at).toLocaleDateString("zh-TW")} 到期</small></div><button class="ghost" data-revoke-invitation="${v.id}">撤銷</button></div>`).join("") || '<p class="sub">沒有待接受的邀請</p>'}</details><details class="workspace-section"><summary>權限說明</summary><p class="sub">一般成員：閱讀院內內容、管理自己的專案、討論與聯絡同仁。<br>管理員：另可發布活動及公告、安排議程、管理成員與公開討論。<br>私人草稿及私訊不因管理員身分而開放。</p><p class="muted">不能在此更改自己的管理員權限。Google OAuth 若仍在測試模式，測試名單仍需在 Google Cloud 管理。</p></details>`;
    root.querySelector<HTMLElement>("#members-back")!.onclick = o.back;
    root.querySelector<HTMLElement>("#invite-person")!.onclick = invite;
    root.querySelector<HTMLFormElement>("#member-search")!.onsubmit = (ev) => {
      ev.preventDefault();
      query = String(
        new FormData(ev.target as HTMLFormElement).get("query"),
      ).slice(0, 100);
      offset = 0;
      void run(list);
    };
    root.querySelectorAll<HTMLSelectElement>("[data-member-role]").forEach(
      (select) =>
        (select.onchange = () =>
          void run(async () => {
            select.disabled = true;
            try {
              await o.request("POST", {
                action: "role",
                user_id: select.dataset.memberRole,
                role: select.value,
              });
              o.toast("權限已更新");
            } finally {
              await list();
            }
          })),
    );
    root.querySelectorAll<HTMLElement>("[data-revoke-invitation]").forEach(
      (b) =>
        (b.onclick = () =>
          void run(async () => {
            await o.request("POST", {
              action: "revoke",
              id: b.dataset.revokeInvitation,
            });
            await list();
            o.toast("邀請已撤銷");
          })),
    );
    const prev = root.querySelector<HTMLElement>("#members-prev"),
      next = root.querySelector<HTMLElement>("#members-next");
    if (prev)
      prev.onclick = () => {
        offset -= 20;
        void run(list);
      };
    if (next)
      next.onclick = () => {
        offset += 20;
        void run(list);
      };
  }
  function invite() {
    root.innerHTML = `<button id="invite-back" class="text-button">← 成員</button><div class="page-heading"><h1>邀請同仁</h1></div><form id="invite-form" class="member-invite-form"><label>Google 帳號信箱<input name="email" type="email" required maxlength="254" autocomplete="off" placeholder="name@gmail.com"></label><label>加入後的權限<select name="role"><option value="member">一般成員</option><option value="admin">管理員</option></select></label><p class="sub">產生連結後自行分享給同仁，7 天內使用指定 Google 帳號登入即可加入。這不會建立新的 Google 帳號或寄送 Email。</p><button type="submit">產生邀請連結</button></form>`;
    root.querySelector<HTMLElement>("#invite-back")!.onclick = () =>
      void run(list);
    root.querySelector<HTMLFormElement>("#invite-form")!.onsubmit = (ev) => {
      ev.preventDefault();
      const form = ev.target as HTMLFormElement,
        button = form.querySelector<HTMLButtonElement>("button[type=submit]")!;
      if (button.disabled) return;
      button.disabled = true;
      void run(async () => {
        try {
          const data = await o.request("POST", {
              action: "invite",
              ...Object.fromEntries(new FormData(form)),
            }),
            url = data.url ?? location.origin + "/#invite=" + data.token;
          root.innerHTML = `<div class="page-heading"><h1>邀請已建立</h1></div><p>${e(data.email)}</p><p class="sub">請現在複製連結，7 天內有效。重新邀請相同信箱會使舊連結失效。</p><label>邀請連結<input id="invitation-link" type="text" readonly value="${e(url)}"></label><div class="actions"><button id="copy-invitation">複製連結</button><button id="invite-done" class="ghost">完成</button></div>`;
          root.querySelector<HTMLElement>("#copy-invitation")!.onclick = () =>
            void run(async () => {
              try {
                await navigator.clipboard.writeText(url);
                o.toast("連結已複製");
              } catch {
                const input =
                  root.querySelector<HTMLInputElement>("#invitation-link")!;
                input.select();
                o.toast("請複製已選取的連結");
              }
            });
          root.querySelector<HTMLElement>("#invite-done")!.onclick = () =>
            void run(list);
        } finally {
          if (button.isConnected) button.disabled = false;
        }
      });
    };
  }
  await run(list);
}
