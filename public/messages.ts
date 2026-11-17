const esc = (v: unknown) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
interface Options {
  actorId: string;
  demo: boolean;
  recipientId?: string;
  projectId?: string;
  request: (method: string, path: string, payload?: any) => Promise<any>;
  review: (payload: any) => Promise<any>;
  toast: (message: string) => void;
  openProject: (id: string) => void;
}
let generation = 0;
const demoState = {
  settings: { accepts_messages: true, blocked_user_ids: [] as string[] },
  conversations: [
    {
      id: "preview-conversation",
      last_message_at: new Date().toISOString(),
      other: {
        id: "preview-colleague",
        display_name: "交流同仁",
        department: "資訊室",
      },
    },
  ],
  messages: [
    {
      id: "preview-message",
      conversation_id: "preview-conversation",
      sender_id: "preview-colleague",
      body: "你好！看完你的分享後，很想交流一下流程設計的經驗。方便在這裡聊聊嗎？",
      created_at: new Date().toISOString(),
      project_id: null as string | null,
    },
  ],
};
export async function mountMessages(root: HTMLElement, o: Options) {
  const own = ++generation;
  let selected: string | undefined,
    recipient: any = null,
    project = o.projectId,
    inboxPage = 0,
    messagePage = 0,
    requestVersion = 0;
  let draftFingerprint = "",
    draftRequestId = "";
  const run = async (fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (err) {
      o.toast(err instanceof Error ? err.message : "訊息暫時無法載入");
    }
  };
  async function api(method: string, path: string, payload?: any) {
    if (!o.demo) return o.request(method, path, payload);
    if (method === "GET") {
      if (path.startsWith("members/"))
        return {
          id: path.split("/")[1],
          display_name: "專案分享者",
          department: "跨職類",
          accepts_messages: true,
        };
      if (path === "contact-settings") return demoState.settings;
      if (path.startsWith("inbox/")) {
        const id = path.split("/")[1].split("?")[0];
        return {
          conversation: demoState.conversations.find((c) => c.id === id),
          messages: demoState.messages
            .filter((m) => m.conversation_id === id)
            .slice()
            .reverse(),
          total: demoState.messages.filter((m) => m.conversation_id === id)
            .length,
        };
      }
      return {
        conversations: demoState.conversations,
        total: demoState.conversations.length,
      };
    }
    if (path === "messages") {
      const checked = await o.review(payload);
      if (!checked) throw Error("已返回修改");
      payload = checked.payload;
      if (!demoState.settings.accepts_messages) throw Error("請先開啟接收私訊");
      if (demoState.settings.blocked_user_ids.includes(payload.recipient_id))
        throw Error("此聯絡目前無法使用");
      let c = demoState.conversations.find(
        (c) => c.other.id === payload.recipient_id,
      );
      if (!c) {
        c = {
          id: crypto.randomUUID(),
          last_message_at: new Date().toISOString(),
          other: recipient,
        };
        demoState.conversations.unshift(c);
      }
      demoState.messages.push({
        id: crypto.randomUUID(),
        conversation_id: c.id,
        sender_id: o.actorId,
        body: payload.body,
        created_at: new Date().toISOString(),
        project_id: payload.project_id ?? null,
      });
      return { conversation_id: c.id };
    }
    if (path === "contact-settings") {
      demoState.settings.accepts_messages = payload.accepts_messages;
      return demoState.settings;
    }
    if (path === "contact-blocks") {
      demoState.settings.blocked_user_ids =
        demoState.settings.blocked_user_ids.filter(
          (id) => id !== payload.user_id,
        );
      if (payload.blocked)
        demoState.settings.blocked_user_ids.push(payload.user_id);
      return { ok: true };
    }
    throw Error("預覽不提供此操作");
  }
  function alive(ticket: number) {
    return own === generation && ticket === requestVersion && root.isConnected;
  }
  async function view() {
    const ticket = ++requestVersion;
    const [data, settings] = await Promise.all([
      api("GET", `inbox?offset=${inboxPage * 20}&limit=20`),
      api("GET", "contact-settings"),
    ]);
    let conversation: any = null,
      messages: any[] = [],
      total = 0;
    if (selected) {
      const r = await api(
        "GET",
        `inbox/${selected}?offset=${messagePage * 50}&limit=50`,
      );
      conversation = r.conversation;
      recipient = conversation.other;
      messages = r.messages.slice().reverse();
      total = r.total;
    }
    if (!alive(ticket)) return;
    const blocked =
      recipient && settings.blocked_user_ids.includes(recipient.id);
    const unavailable = blocked || recipient?.accepts_messages === false;
    const blockedName = (id: string) =>
      settings.blocked_members?.find((m: any) => m.user_id === id)
        ?.display_name ??
      data.conversations.find((c: any) => c.other.id === id)?.other
        .display_name ??
      "已封鎖同仁";
    root.innerHTML = `<div class="page-heading message-page-heading"><h1>訊息</h1><div class="actions"><details class="action-menu contact-settings"><summary aria-label="聯絡設定">設定</summary><div class="menu-items"><label class="check"><input id="accept-messages" type="checkbox" ${settings.accepts_messages ? "checked" : ""}>接受站內私訊</label><p class="sub">關閉後停止接收新訊息。</p>${settings.blocked_user_ids.map((id: string) => `<div class="row list-item"><span>${esc(blockedName(id))}</span><button class="ghost" data-unblock="${esc(id)}">解除封鎖</button></div>`).join("") || '<p class="muted">沒有封鎖名單</p>'}</div></details><button id="refresh-inbox" class="icon-button" aria-label="更新訊息">↻</button></div></div>${o.demo ? '<p class="preview-note">私訊示例，不會傳送。</p>' : ""}<div class="inbox-layout"><aside class="inbox-list"><h2 class="sr-only">我的對話</h2>${data.conversations.map((c: any) => `<button class="inbox-person ${c.id === selected ? "active" : ""}" data-conversation="${esc(c.id)}"><span class="topic-avatar">${esc(c.other.display_name.slice(0, 1))}</span><span><strong>${esc(c.other.display_name)}</strong><small>${esc(c.other.department)}</small></span><span class="muted">${new Date(c.last_message_at).toLocaleDateString("zh-TW", { month: "numeric", day: "numeric" })}</span></button>`).join("") || '<p class="sub">還沒有對話</p>'}${data.total > 20 ? `<div class="actions"><button id="inbox-prev" class="ghost" ${inboxPage === 0 ? "disabled" : ""}>上一頁</button><button id="inbox-next" class="ghost" ${(inboxPage + 1) * 20 >= data.total ? "disabled" : ""}>下一頁</button></div>` : ""}</aside><section class="message-panel">${recipient ? `<header class="row"><div><h2>${esc(recipient.display_name)}</h2><p class="sub">${esc(recipient.department)} · 站內私訊</p></div><details class="action-menu"><summary aria-label="對話選項">⋯</summary><div class="menu-items"><button id="block-contact" class="ghost">${blocked ? "解除封鎖" : "封鎖對方"}</button></div></details></header>${project ? '<p class="muted">附上專案連結</p>' : ""}<div class="message-history">${messages.map((m) => `<article class="message-bubble ${m.sender_id === o.actorId ? "outgoing" : ""}"><p>${esc(m.body)}</p>${m.project_id ? `<button class="ghost" data-message-project="${esc(m.project_id)}">查看相關專案 ↗</button>` : ""}<small>${new Date(m.created_at).toLocaleString("zh-TW")}</small></article>`).join("") || '<p class="sub"></p>'}</div>${selected && total > 50 ? `<div class="actions"><button id="older-messages" class="ghost" ${(messagePage + 1) * 50 >= total ? "disabled" : ""}>較早訊息</button><button id="newer-messages" class="ghost" ${messagePage === 0 ? "disabled" : ""}>較新訊息</button></div>` : ""}${recipient.accepts_messages === false ? '<p class="sub">對方暫停接收私訊</p>' : ""}<form id="send-message"><label><span class="sr-only">訊息</span><textarea name="body" maxlength="6000" required placeholder="輸入訊息…" ${unavailable ? "disabled" : ""}></textarea></label><button type="submit" aria-label="傳送站內私訊" ${unavailable ? "disabled" : ""}>傳送</button></form>` : '<div class="empty">選擇對話</div>'}</section></div>`;
    root.querySelector<HTMLElement>("#refresh-inbox")!.onclick = () =>
      void run(view);
    root.querySelectorAll<HTMLElement>("[data-conversation]").forEach(
      (b) =>
        (b.onclick = () => {
          selected = b.dataset.conversation;
          recipient = null;
          project = undefined;
          messagePage = 0;
          void run(view);
        }),
    );
    root.querySelector<HTMLInputElement>("#accept-messages")!.onchange = (ev) =>
      void run(async () => {
        await api("POST", "contact-settings", {
          accepts_messages: (ev.target as HTMLInputElement).checked,
        });
        await view();
      });
    root.querySelectorAll<HTMLElement>("[data-unblock]").forEach(
      (b) =>
        (b.onclick = () =>
          void run(async () => {
            await api("POST", "contact-blocks", {
              user_id: b.dataset.unblock,
              blocked: false,
            });
            await view();
          })),
    );
    if (root.querySelector("#block-contact"))
      root.querySelector<HTMLElement>("#block-contact")!.onclick = () =>
        void run(async () => {
          await api("POST", "contact-blocks", {
            user_id: recipient.id,
            blocked: !blocked,
          });
          await view();
        });
    root
      .querySelectorAll<HTMLElement>("[data-message-project]")
      .forEach(
        (b) => (b.onclick = () => o.openProject(b.dataset.messageProject!)),
      );
    const form = root.querySelector<HTMLFormElement>("#send-message");
    if (form)
      form.onsubmit = (ev) => {
        ev.preventDefault();
        const button = form.querySelector<HTMLButtonElement>(
          "button[type=submit]",
        )!;
        if (button.disabled) return;
        button.disabled = true;
        void run(async () => {
          try {
            const draft = JSON.stringify({
              recipient: recipient.id,
              body: new FormData(form).get("body"),
              project,
            });
            if (draftFingerprint !== draft) {
              draftFingerprint = draft;
              draftRequestId = crypto.randomUUID();
            }
            const result = await api("POST", "messages", {
              recipient_id: recipient.id,
              body: new FormData(form).get("body"),
              ...(project ? { project_id: project } : {}),
              client_request_id: draftRequestId,
            });
            draftFingerprint = "";
            draftRequestId = "";
            selected = result.conversation_id;
            messagePage = 0;
            project = undefined;
            await view();
          } finally {
            if (button.isConnected) button.disabled = false;
          }
        });
      };
    const inboxPrev = root.querySelector<HTMLElement>("#inbox-prev"),
      inboxNext = root.querySelector<HTMLElement>("#inbox-next");
    if (inboxPrev)
      inboxPrev.onclick = () => {
        inboxPage--;
        void run(view);
      };
    if (inboxNext)
      inboxNext.onclick = () => {
        inboxPage++;
        void run(view);
      };
    const older = root.querySelector<HTMLElement>("#older-messages"),
      newer = root.querySelector<HTMLElement>("#newer-messages");
    if (older)
      older.onclick = () => {
        messagePage++;
        void run(view);
      };
    if (newer)
      newer.onclick = () => {
        messagePage--;
        void run(view);
      };
  }
  if (o.recipientId) {
    recipient = await api("GET", "members/" + o.recipientId);
    if (recipient.id === o.actorId) {
      o.toast("這是您自己的專案，可以從工作空間管理。");
      recipient = null;
    }
  }
  await run(view);
  if (root.isConnected && !root.querySelector(".inbox-layout"))
    root.innerHTML =
      '<div class="empty">訊息暫時無法載入，請稍後重新整理再試。</div>';
}
