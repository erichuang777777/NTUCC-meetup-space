import { registerFeature } from "../feature-registry";
import { isEnabled } from "../features";
import "./forum_plus.css";

// 論壇強化 (flag: forum_plus). Rendering helpers called from public/forum.ts through small hooks.
// Every helper returns an empty result when the flag is off, so the forum renders exactly as before.
export type ThreadInfo = {
  id: string;
  is_pinned: boolean;
  is_featured: boolean;
  accepted_reply_id: string | null;
  helpful_count: number;
  helpful_mine: boolean;
  following: boolean;
};
export type ReplyInfo = {
  id: string;
  helpful_count: number;
  helpful_mine: boolean;
};
export type FpDetail = { thread?: ThreadInfo; replies: Map<string, ReplyInfo> };

const ERRORS: Record<string, string> = {
  FEATURE_DISABLED: "論壇強化功能目前未開啟",
  MEMBER_REQUIRED: "請先完成登入與通關",
  ADMIN_REQUIRED: "僅管理員可執行",
  FORBIDDEN: "只有主題作者或管理員可以標記最佳解答",
  INVALID_REPLY: "此回覆不屬於這個討論",
  NOT_FOUND: "找不到此內容",
};
const esc = (v: unknown) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
const active = (client: any) => !!client && isEnabled("forum_plus");

export async function fpLoadThreads(
  client: any,
  ids: string[],
): Promise<Map<string, ThreadInfo>> {
  const out = new Map<string, ThreadInfo>();
  if (!active(client) || !ids.length) return out;
  const { data, error } = await client.rpc("forum_plus_threads", {
    p_ids: ids,
  });
  if (!error) for (const r of data ?? []) out.set(r.id, r);
  return out;
}
export async function fpLoadDetail(
  client: any,
  threadId: string,
  replyIds: string[],
): Promise<FpDetail> {
  const out: FpDetail = { replies: new Map() };
  if (!active(client)) return out;
  out.thread = (await fpLoadThreads(client, [threadId])).get(threadId);
  if (replyIds.length) {
    const { data, error } = await client.rpc("forum_plus_replies", {
      p_ids: replyIds,
    });
    if (!error) for (const r of data ?? []) out.replies.set(r.id, r);
  }
  return out;
}

export function fpListBadges(i?: ThreadInfo) {
  if (!i) return "";
  return `${i.is_featured ? " · ⭐ 精華" : ""}${i.accepted_reply_id ? " · ✅ 最佳解答" : ""}${i.helpful_count ? ` · 👍 ${i.helpful_count}` : ""}`;
}
export function fpThreadBadges(i?: ThreadInfo) {
  if (!i) return "";
  return `${i.is_featured ? '<span class="badge">⭐ 精華</span> ' : ""}`;
}
export function fpThreadBar(i: ThreadInfo | undefined, admin: boolean) {
  if (!i) return "";
  return `<div class="fp-bar"><button type="button" class="ghost fp-btn ${i.helpful_mine ? "on" : ""}" data-fp="helpful" data-type="thread" data-id="${esc(i.id)}" aria-pressed="${i.helpful_mine}">👍 有幫助 ${i.helpful_count}</button><button type="button" class="ghost fp-btn ${i.following ? "on" : ""}" data-fp="follow" data-id="${esc(i.id)}" aria-pressed="${i.following}">${i.following ? "已追蹤" : "追蹤"}</button>${admin ? `<button type="button" class="ghost fp-btn" data-fp="flags" data-id="${esc(i.id)}" data-pinned="${!i.is_pinned}" data-featured="${i.is_featured}">${i.is_pinned ? "📌 取消置頂" : "📌 置頂"}</button><button type="button" class="ghost fp-btn" data-fp="flags" data-id="${esc(i.id)}" data-pinned="${i.is_pinned}" data-featured="${!i.is_featured}">${i.is_featured ? "⭐ 取消精華" : "⭐ 設為精華"}</button>` : ""}</div>`;
}
export function fpReplyBar(
  threadId: string,
  replyId: string,
  t: ThreadInfo | undefined,
  i: ReplyInfo | undefined,
  canAccept: boolean,
) {
  if (!t || !i) return "";
  const accepted = t.accepted_reply_id === replyId;
  return `<div class="fp-bar">${accepted ? '<span class="badge fp-accepted">✅ 最佳解答</span>' : ""}<button type="button" class="ghost fp-btn ${i.helpful_mine ? "on" : ""}" data-fp="helpful" data-type="reply" data-id="${esc(replyId)}" aria-pressed="${i.helpful_mine}">👍 有幫助 ${i.helpful_count}</button>${canAccept ? `<button type="button" class="ghost fp-btn" data-fp="accept" data-thread="${esc(threadId)}" data-id="${accepted ? "" : esc(replyId)}">${accepted ? "取消最佳解答" : "✅ 標為最佳解答"}</button>` : ""}</div>`;
}

/** Wires the buttons rendered above; `refresh` re-renders the thread detail. */
export function fpBind(
  root: HTMLElement,
  client: any,
  toast: (m: string) => void,
  refresh: () => Promise<void>,
) {
  if (!active(client)) return;
  const call = async (fn: string, args: Record<string, unknown>) => {
    const { error } = await client.rpc(fn, args);
    if (error) throw Error(ERRORS[error.message] ?? error.message);
  };
  root.querySelectorAll<HTMLElement>("[data-fp]").forEach((b) => {
    b.onclick = async () => {
      try {
        const d = b.dataset;
        if (d.fp === "helpful")
          await call("toggle_helpful", { p_type: d.type, p_id: d.id });
        else if (d.fp === "follow")
          await call("toggle_follow_thread", { p_thread: d.id });
        else if (d.fp === "accept")
          await call("set_accepted_reply", {
            p_thread: d.thread,
            p_reply: d.id || null,
          });
        else if (d.fp === "flags")
          await call("set_thread_flags", {
            p_thread: d.id,
            p_pinned: d.pinned === "true",
            p_featured: d.featured === "true",
          });
        await refresh();
      } catch (err) {
        toast(err instanceof Error ? err.message : "操作失敗");
      }
    };
  });
}

/** Simple @mention autocomplete dropdown for a composer textarea. */
export function fpAttachMention(
  textarea: HTMLTextAreaElement | null,
  client: any,
) {
  if (!textarea || !active(client)) return;
  const host = textarea.parentElement!;
  host.classList.add("fp-mention-host");
  const list = document.createElement("ul");
  list.className = "fp-mention-list";
  list.hidden = true;
  list.setAttribute("role", "listbox");
  host.appendChild(list);
  let timer: ReturnType<typeof setTimeout> | undefined,
    seq = 0;
  const hide = () => {
    list.hidden = true;
    list.innerHTML = "";
  };
  const token = () => {
    const upto = textarea.value.slice(0, textarea.selectionStart ?? 0);
    const m = upto.match(/(?:^|\s)@([^\s@]{1,20})$/);
    return m ? { prefix: m[1], start: upto.length - m[1].length - 1 } : null;
  };
  textarea.addEventListener("input", () => {
    clearTimeout(timer);
    const tk = token();
    if (!tk) return hide();
    timer = setTimeout(async () => {
      const mine = ++seq;
      const { data, error } = await client.rpc("mention_suggestions", {
        p_prefix: tk.prefix,
      });
      if (mine !== seq || error || !data?.length) return hide();
      list.innerHTML = data
        .map(
          (r: any) =>
            `<li role="option" tabindex="-1" data-name="${esc(r.display_name)}">${esc(r.display_name)}${r.department ? ` <small>${esc(r.department)}</small>` : ""}</li>`,
        )
        .join("");
      list.hidden = false;
      list.querySelectorAll<HTMLElement>("li").forEach((li) => {
        li.onmousedown = (ev) => {
          ev.preventDefault();
          const cur = token() ?? tk;
          const end = textarea.selectionStart ?? textarea.value.length;
          const ins = "@" + li.dataset.name + " ";
          textarea.value =
            textarea.value.slice(0, cur.start) +
            ins +
            textarea.value.slice(end);
          textarea.setSelectionRange(
            cur.start + ins.length,
            cur.start + ins.length,
          );
          textarea.focus();
          hide();
        };
      });
    }, 200);
  });
  textarea.addEventListener("blur", () => setTimeout(hide, 150));
  textarea.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") hide();
  });
}

registerFeature({ key: "forum_plus" });
