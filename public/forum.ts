import workflowCover from "./images/covers/workflow.svg?url";
import notesCover from "./images/covers/notes.svg?url";
import boardCover from "./images/covers/board.svg?url";
import { reportAttrs } from "./features/content_reports";
import {
  fpLoadThreads,
  fpLoadDetail,
  fpListBadges,
  fpThreadBadges,
  fpThreadBar,
  fpReplyBar,
  fpBind,
  fpAttachMention,
  type FpDetail,
} from "./features/forum_plus";
// Project discussions: paginated per-project topics, signed-in replies and moderation.
const e = (v: unknown) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
const kinds: Record<string, string> = {
  question: "提問",
  experience: "實作心得",
  resource: "資源分享",
};
export function coverFor(space: any, index = 0) {
  return (
    space.cover_image ?? [workflowCover, notesCover, boardCover][index % 3]
  );
}
export interface ForumOptions {
  client: any;
  demo: boolean;
  space: any;
  actorId?: string;
  admin: boolean;
  threadId?: string;
  send: (action: string, payload: any) => Promise<any>;
  review: (payload: any) => Promise<any>;
  navigate: (thread?: string) => void;
  toast: (message: string) => void;
}
let active = 0;
const memory = new Map<string, { threads: any[]; replies: any[] }>();
function sample(space: any) {
  let data = memory.get(space.id);
  if (data) return data;
  const now = new Date().toISOString();
  data = {
    threads: [
      {
        id: "topic-1",
        space_id: space.id,
        title: `想試做「${space.highlights?.[0] ?? "這個專案"}」，建議從哪裡開始？`,
        body: `看完「${space.title}」後想在自己的工作流程試試看。想請教分享者：建議先用哪一段合成資料做小規模驗證？`,
        kind: "question",
        author_id: "demo-colleague",
        author_name: "護理部同仁",
        is_pinned: true,
        is_resolved: false,
        reply_count: 2,
        created_at: now,
        last_activity_at: now,
      },
      {
        id: "topic-2",
        space_id: space.id,
        title: "我的實作筆記：先列出人工檢查清單",
        body: "我們試做後發現，先把需要人工查核的項目列出來，比一直調整 Prompt 更有幫助。這裡分享一個小心得，歡迎大家一起補充。",
        kind: "experience",
        author_id: "demo-colleague-2",
        author_name: "行政同仁",
        is_pinned: false,
        is_resolved: false,
        reply_count: 0,
        created_at: now,
        last_activity_at: now,
      },
    ],
    replies: [
      {
        id: "reply-1",
        thread_id: "topic-1",
        body: "我會先選一段重複性高、也容易人工核對的流程，資料一律使用合成範例。",
        author_id: space.owner_id,
        author_name: "專案分享者",
        created_at: now,
      },
      {
        id: "reply-2",
        thread_id: "topic-1",
        body: "謝謝！我也想從這個方式開始，先記錄原本的耗時再比較。",
        author_id: "demo-colleague",
        author_name: "護理部同仁",
        created_at: now,
      },
    ],
  };
  memory.set(space.id, data);
  return data;
}
function date(value: string) {
  return new Date(value).toLocaleDateString("zh-TW", {
    month: "short",
    day: "numeric",
  });
}
export async function mountForum(root: HTMLElement, o: ForumOptions) {
  const version = ++active;
  let kind = "",
    order = "active",
    query = "",
    page = 0,
    replyPage = 0,
    currentThread = o.threadId;
  let request = 0;
  const mod = o.admin || o.actorId === o.space.owner_id;
  const run = async (fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (err) {
      o.toast(err instanceof Error ? err.message : "討論載入失敗");
    }
  };
  const fetchRows = async (q: any) => {
    const r = await q;
    if (r.error)
      throw Error("討論暫時無法載入，請確認已執行專案討論區的資料庫更新。");
    return r;
  };
  async function action(name: string, payload: any) {
    if (!o.demo) return o.send(name, payload);
    const reviewed = await o.review(payload);
    if (!reviewed) throw Error("已返回修改");
    payload = reviewed.payload;
    const data = sample(o.space),
      id = crypto.randomUUID();
    if (name === "thread_create") {
      data.threads.unshift({
        ...payload,
        id,
        author_id: "demo-me",
        author_name: "預覽同仁",
        created_at: new Date().toISOString(),
        last_activity_at: new Date().toISOString(),
        reply_count: 0,
      });
      return { id };
    }
    if (name === "thread_reply") {
      data.replies.push({
        ...payload,
        id,
        author_id: "demo-me",
        author_name: "預覽同仁",
        created_at: new Date().toISOString(),
      });
      const t = data.threads.find((t) => t.id === payload.thread_id);
      if (t) {
        t.reply_count++;
        t.last_activity_at = new Date().toISOString();
      }
      return { id };
    }
    throw Error("管理操作僅供專案擁有者或管理員使用");
  }
  function bindForm(
    form: HTMLFormElement,
    submit: (f: FormData) => Promise<void>,
  ) {
    form.onsubmit = (ev) => {
      ev.preventDefault();
      const button = form.querySelector<HTMLButtonElement>(
        "button[type=submit]",
      )!;
      if (button.disabled) return;
      button.disabled = true;
      void run(async () => {
        try {
          await submit(new FormData(form));
        } finally {
          if (button.isConnected) button.disabled = false;
        }
      });
    };
  }
  function buttons() {
    root
      .querySelectorAll<HTMLElement>("[data-topic]")
      .forEach((b) => (b.onclick = () => o.navigate(b.dataset.topic)));
  }
  async function list() {
    const ticket = ++request;
    let rows: any[],
      total = 0;
    if (o.demo) {
      rows = sample(o.space).threads.filter(
        (t) => (!kind || t.kind === kind) && t.title.includes(query),
      );
      rows.sort(
        (a, b) =>
          Number(!!b.is_pinned) - Number(!!a.is_pinned) ||
          (order === "active"
            ? b.last_activity_at.localeCompare(a.last_activity_at)
            : b.created_at.localeCompare(a.created_at)),
      );
      total = rows.length;
      rows = rows.slice(page * 20, page * 20 + 20);
    } else {
      let q = o.client
        .from("discussion_threads_read")
        .select(
          "id,title,kind,author_id,author_name,is_pinned,is_resolved,reply_count,created_at,last_activity_at",
          { count: "exact" },
        )
        .eq("space_id", o.space.id);
      if (kind) q = q.eq("kind", kind);
      if (query) q = q.ilike("title", "%" + query.replace(/[%_]/g, "") + "%");
      const r = await fetchRows(
        q
          .order("is_pinned", { ascending: false })
          .order(order === "active" ? "last_activity_at" : "created_at", {
            ascending: false,
          })
          .order("id")
          .range(page * 20, page * 20 + 19),
      );
      rows = r.data;
      total = r.count ?? rows.length;
    }
    const fp = await fpLoadThreads(
      o.demo ? null : o.client,
      rows.map((t) => t.id),
    );
    if (version !== active || ticket !== request || !root.isConnected) return;
    root.innerHTML = `<h2 class="sr-only">專案討論</h2><div class="forum-toolbar"><form id="topic-search"><input type="search" aria-label="搜尋這個專案的討論" name="query" placeholder="搜尋討論" value="${e(query)}"></form><details class="action-menu filter-menu"><summary aria-label="討論篩選">篩選</summary><div class="menu-items"><label>類型<select id="topic-kind">${[["", "全部"], ...Object.entries(kinds)].map(([id, label]) => `<option value="${id}" ${id === kind ? "selected" : ""}>${label}</option>`).join("")}</select></label><label>排序<select id="topic-order"><option value="active" ${order === "active" ? "selected" : ""}>最近活躍</option><option value="new" ${order === "new" ? "selected" : ""}>最新發表</option></select></label><button id="refresh-topics">更新討論</button></div></details><button id="new-topic">新增討論</button></div><div class="topic-list">${rows.map((t) => `<button class="topic-row" data-topic="${e(t.id)}"><span class="topic-avatar">${e(t.author_name.slice(0, 1))}</span><span class="topic-main"><strong>${e(t.title)}</strong><span class="muted">${e(t.author_name)} · ${date(t.last_activity_at)}${t.is_pinned ? " · 置頂" : ""}${t.is_resolved ? " · 已解決" : ""}${fpListBadges(fp.get(t.id))}</span></span><span class="topic-count">${t.reply_count}<small>回覆</small></span></button>`).join("") || '<p class="empty">還沒有符合的討論</p>'}</div>${total > 20 ? `<div class="row forum-pagination"><span class="muted">${page + 1} / ${Math.ceil(total / 20)}</span><div class="actions"><button id="topics-prev" class="ghost" ${page === 0 ? "disabled" : ""}>上一頁</button><button id="topics-next" class="ghost" ${(page + 1) * 20 >= total ? "disabled" : ""}>下一頁</button></div></div>` : ""}`;
    buttons();
    root.querySelector<HTMLElement>("#refresh-topics")!.onclick = () =>
      void run(list);
    root.querySelector<HTMLElement>("#new-topic")!.onclick = () => compose();
    root.querySelector<HTMLSelectElement>("#topic-kind")!.onchange = (ev) => {
      kind = (ev.target as HTMLSelectElement).value;
      page = 0;
      void run(list);
    };
    root.querySelector<HTMLSelectElement>("#topic-order")!.onchange = (ev) => {
      order = (ev.target as HTMLSelectElement).value;
      page = 0;
      void run(list);
    };
    root.querySelector<HTMLFormElement>("#topic-search")!.onsubmit = (ev) => {
      ev.preventDefault();
      query = String(
        new FormData(ev.target as HTMLFormElement).get("query"),
      ).slice(0, 100);
      page = 0;
      void run(list);
    };
    const prev = root.querySelector<HTMLElement>("#topics-prev"),
      next = root.querySelector<HTMLElement>("#topics-next");
    if (prev)
      prev.onclick = () => {
        page--;
        void run(list);
      };
    if (next)
      next.onclick = () => {
        page++;
        void run(list);
      };
  }
  function compose() {
    request++;
    root.innerHTML = `<button id="cancel-topic" class="ghost">← 返回專案討論</button><div class="compose-topic"><h2>新增討論</h2><form id="compose-topic"><label>討論類型<select name="kind">${Object.entries(
      kinds,
    )
      .map(([id, label]) => `<option value="${id}">${label}</option>`)
      .join(
        "",
      )}</select></label><label>討論標題<input name="title" maxlength="160" required placeholder="讓大家一眼了解你想討論的事"></label><label>內容<textarea name="body" required maxlength="6000" placeholder="分享你的問題或實作心得，請勿包含病患個資。"></textarea></label><button type="submit">發布討論</button></form></div>`;
    fpAttachMention(
      root.querySelector<HTMLTextAreaElement>("#compose-topic textarea"),
      o.demo ? null : o.client,
    );
    root.querySelector<HTMLElement>("#cancel-topic")!.onclick = () =>
      void run(list);
    bindForm(root.querySelector("#compose-topic")!, async (f) => {
      const result = await action("thread_create", {
        space_id: o.space.id,
        ...Object.fromEntries(f),
      });
      o.navigate(result.id);
    });
  }
  async function detail() {
    const ticket = ++request;
    let t: any,
      replies: any[],
      total = 0;
    if (o.demo) {
      const data = sample(o.space);
      t = data.threads.find((t) => t.id === currentThread);
      const all = data.replies.filter((r) => r.thread_id === currentThread);
      total = all.length;
      replies = all.slice(replyPage * 50, replyPage * 50 + 50);
    } else {
      t = (
        await fetchRows(
          o.client
            .from("discussion_threads_read")
            .select(
              "id,space_id,title,body,kind,author_id,author_name,is_pinned,is_resolved,reply_count,created_at",
            )
            .eq("id", currentThread)
            .eq("space_id", o.space.id)
            .maybeSingle(),
        )
      ).data;
      const r = await fetchRows(
        o.client
          .from("discussion_replies_read")
          .select("id,body,author_id,author_name,created_at", {
            count: "exact",
          })
          .eq("thread_id", currentThread)
          .order("created_at")
          .order("id")
          .range(replyPage * 50, replyPage * 50 + 49),
      );
      replies = r.data;
      total = r.count ?? 0;
    }
    const fp = t
      ? await fpLoadDetail(
          o.demo ? null : o.client,
          t.id,
          replies.map((r) => r.id),
        )
      : ({ replies: new Map() } as FpDetail);
    if (version !== active || ticket !== request || !root.isConnected) return;
    if (!t) {
      root.innerHTML =
        '<div class="empty">此討論不存在或已由管理員隱藏。</div><button id="back-topics">返回專案討論</button>';
      root.querySelector<HTMLElement>("#back-topics")!.onclick = () =>
        o.navigate();
      return;
    }
    root.innerHTML = `<button id="back-topics" class="ghost">← 返回這個專案的討論</button><article class="thread-opening"${reportAttrs("thread", t.id, t.author_id)}><span class="badge">${e(kinds[t.kind])}</span> ${t.is_pinned ? '<span class="badge">📌 置頂</span>' : ""}${t.is_resolved ? '<span class="badge">✅ 已解決</span>' : ""}${fpThreadBadges(fp.thread)}<h2>${e(t.title)}</h2><p class="muted">${e(t.author_name)}${t.author_id === o.space.owner_id ? " · 專案分享者" : ""} · ${date(t.created_at)}</p><p class="thread-body">${e(t.body)}</p>${fpThreadBar(fp.thread, o.admin)}${mod ? `<details class="action-menu thread-menu"><summary>管理</summary><div class="menu-items"><button class="ghost" data-mod="pin" data-value="${!t.is_pinned}">${t.is_pinned ? "取消置頂" : "置頂主題"}</button><button class="ghost" data-mod="resolve" data-value="${!t.is_resolved}">${t.is_resolved ? "重新開啟" : "標記已解決"}</button><button class="danger" data-mod="hide_thread" data-value="true">隱藏此主題</button></div></details>` : ""}</article><div class="row"><h3>${total} 則回覆</h3><button id="refresh-replies" class="icon-button" aria-label="更新回覆">↻</button></div><div class="replies">${replies.map((r) => `<article class="reply"${reportAttrs("reply", r.id, r.author_id)}><div class="topic-avatar">${e(r.author_name.slice(0, 1))}</div><div><div class="row"><span class="muted">${e(r.author_name)}${r.author_id === o.space.owner_id ? " · 專案分享者" : ""} · ${date(r.created_at)}</span>${mod ? `<button class="ghost" data-hide-reply="${e(r.id)}">隱藏</button>` : ""}</div><p class="thread-body">${e(r.body)}</p>${fpReplyBar(t.id, r.id, fp.thread, fp.replies.get(r.id), o.admin || o.actorId === t.author_id)}</div></article>`).join("") || ""}</div>${total > 50 ? `<div class="actions"><button id="reply-prev" class="ghost" ${replyPage === 0 ? "disabled" : ""}>較早回覆</button><button id="reply-next" class="ghost" ${(replyPage + 1) * 50 >= total ? "disabled" : ""}>更多回覆</button></div>` : ""}<form id="reply-form" class="reply-composer"><label>回覆這個討論<textarea name="body" required maxlength="6000" placeholder="回覆…"></textarea></label><button type="submit">送出回覆</button></form>`;
    root.querySelector<HTMLElement>("#back-topics")!.onclick = () =>
      o.navigate();
    root.querySelector<HTMLElement>("#refresh-replies")!.onclick = () =>
      void run(detail);
    fpBind(root, o.demo ? null : o.client, o.toast, detail);
    fpAttachMention(
      root.querySelector<HTMLTextAreaElement>("#reply-form textarea"),
      o.demo ? null : o.client,
    );
    bindForm(root.querySelector("#reply-form")!, async (f) => {
      await action("thread_reply", { thread_id: t.id, body: f.get("body") });
      replyPage = Math.floor(total / 50);
      await detail();
    });
    root.querySelectorAll<HTMLElement>("[data-mod]").forEach(
      (b) =>
        (b.onclick = () =>
          void run(async () => {
            await action("thread_moderate", {
              thread_id: t.id,
              operation: b.dataset.mod,
              value: b.dataset.value === "true",
            });
            if (b.dataset.mod === "hide_thread") o.navigate();
            else await detail();
          })),
    );
    root.querySelectorAll<HTMLElement>("[data-hide-reply]").forEach(
      (b) =>
        (b.onclick = () =>
          void run(async () => {
            await action("thread_moderate", {
              thread_id: t.id,
              operation: "hide_reply",
              reply_id: b.dataset.hideReply,
              value: true,
            });
            await detail();
          })),
    );
    const prev = root.querySelector<HTMLElement>("#reply-prev"),
      next = root.querySelector<HTMLElement>("#reply-next");
    if (prev)
      prev.onclick = () => {
        replyPage--;
        void run(detail);
      };
    if (next)
      next.onclick = () => {
        replyPage++;
        void run(detail);
      };
  }
  await run(() => (currentThread ? detail() : list()));
  if (!root.innerHTML)
    root.innerHTML = '<div class="empty">討論暫時無法載入，請稍後重試。</div>';
}
