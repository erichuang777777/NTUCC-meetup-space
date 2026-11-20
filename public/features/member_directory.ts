import { registerFeature, type FeatureCtx } from "../feature-registry";
import "./member_directory.css";
import { renderParticipationBadge } from "./participation_history";

type Member = {
  user_id: string;
  display_name: string;
  department: string;
  bio: string;
  expertise_tags: string[];
  open_to_questions: boolean;
  question_topics: string;
};
type Mine = {
  listed: boolean;
  bio: string;
  expertise_tags: string[];
  open_to_questions: boolean;
  question_topics: string;
};
const EMPTY: Mine = {
  listed: false,
  bio: "",
  expertise_tags: [],
  open_to_questions: false,
  question_topics: "",
};
const DEMO: Member[] = [
  {
    user_id: "demo-1",
    display_name: "示範同仁",
    department: "資訊室",
    bio: "喜歡用小工具把重複的流程自動化。",
    expertise_tags: ["Python", "自動化"],
    open_to_questions: true,
    question_topics: "報表自動化、資料清理",
  },
];

/** Split a free-text tags input on commas / Chinese commas / newlines. */
export function parseTags(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(/[,，、\n]/)) {
    const t = part.trim().replace(/\s+/g, " ");
    if (t && !seen.has(t.toLowerCase())) {
      seen.add(t.toLowerCase());
      out.push(t);
    }
  }
  return out;
}

const errors: Record<string, string> = {
  FEATURE_DISABLED: "此功能目前未開啟",
  MEMBER_REQUIRED: "僅限已驗證同仁使用",
  INVALID_BIO: "簡介最多 500 字",
  INVALID_TOPICS: "請教主題最多 200 字",
  INVALID_TAGS: "標籤最多 10 個，每個最多 20 字",
  PII_DETECTED: "偵測到疑似個資，請移除後再儲存",
};
function fail(error: { message?: string }): never {
  throw Error(errors[error.message ?? ""] ?? error.message ?? "操作失敗");
}

async function render(root: HTMLElement, ctx: FeatureCtx) {
  const { esc, client } = ctx;
  let query = "",
    department = "",
    tag = "",
    mine: Mine = { ...EMPTY };
  let members: Member[] = [],
    tags: { tag: string; member_count: number }[] = [],
    departments: string[] = [];
  let editing = false,
    version = 0;

  async function rpc<T>(fn: string, args?: Record<string, unknown>) {
    const { data, error } = await client!.rpc(fn, args);
    if (error) fail(error);
    return data as T;
  }

  async function loadAll() {
    if (ctx.demo || !client) {
      members = DEMO.filter(
        (m) =>
          (!department || m.department === department) &&
          (!tag || m.expertise_tags.includes(tag)) &&
          (!query || JSON.stringify(m).includes(query)),
      );
      tags = [
        { tag: "Python", member_count: 1 },
        { tag: "自動化", member_count: 1 },
      ];
      departments = ["資訊室"];
      return;
    }
    const [m, t, d, own] = await Promise.all([
      rpc<Member[]>("search_member_directory", {
        p_query: query || null,
        p_department: department || null,
        p_tag: tag || null,
        p_limit: 50,
        p_offset: 0,
      }),
      rpc<{ tag: string; member_count: number }[]>("member_directory_tags"),
      rpc<{ department: string }[]>("member_directory_departments"),
      client
        .from("member_directory_profiles")
        .select("listed,bio,expertise_tags,open_to_questions,question_topics")
        .eq("user_id", ctx.user.id)
        .maybeSingle(),
    ]);
    members = m ?? [];
    tags = t ?? [];
    departments = (d ?? []).map((x) => x.department);
    if (own.data) mine = own.data as Mine;
  }

  function card(m: Member) {
    return `<article class="panel md-card"><div class="row"><div><h3>${esc(m.display_name)}</h3><span class="muted">${esc(m.department)}</span></div>${m.open_to_questions ? '<span class="badge orange">歡迎請教</span>' : ""}</div>${m.bio ? `<p>${esc(m.bio)}</p>` : ""}${m.open_to_questions && m.question_topics ? `<p class="sub">可請教：${esc(m.question_topics)}</p>` : ""}<div class="md-tags">${m.expertise_tags.map((x) => `<button type="button" class="md-chip" data-tag="${esc(x)}">${esc(x)}</button>`).join("")}</div><div class="md-participation" data-participation="${esc(m.user_id)}"></div><div class="actions"><button type="button" class="secondary" data-message="${esc(m.user_id)}" aria-label="私訊 ${esc(m.display_name)}">私訊</button></div></article>`;
  }

  function editor() {
    return `<form id="md-form" class="panel md-editor"><h2>我的名錄資料</h2><label class="check"><input name="listed" type="checkbox" ${mine.listed ? "checked" : ""}>公開我在同仁名錄（預設不公開）</label><p class="sub">僅已驗證同仁可見；你可隨時取消公開。請勿填寫病患、身分證或病歷號等個資。</p><label>簡介（最多 500 字）<textarea name="bio" maxlength="500" rows="3">${esc(mine.bio)}</textarea></label><label>專長／興趣標籤（以逗號分隔，最多 10 個，每個 20 字內）<input name="tags" value="${esc(mine.expertise_tags.join("，"))}"></label><label class="check"><input name="open" type="checkbox" ${mine.open_to_questions ? "checked" : ""}>歡迎同仁請教我</label><label>可請教的主題（最多 200 字）<input name="topics" maxlength="200" value="${esc(mine.question_topics)}"></label><div class="actions"><button type="submit">儲存</button><button type="button" class="ghost" id="md-cancel">取消</button></div></form>`;
  }

  function draw() {
    root.innerHTML = `<div class="page-heading"><h1>同仁名錄</h1><div class="actions"><button type="button" id="md-edit" class="secondary">我的名錄資料</button></div></div>${ctx.demo ? '<p class="preview-note">名錄示例資料。</p>' : ""}${editing ? editor() : ""}<form id="md-search" class="md-search" role="search"><input type="search" name="q" value="${esc(query)}" placeholder="搜尋姓名、專長或簡介" aria-label="搜尋同仁"><select name="dept" aria-label="科別篩選"><option value="">全部科別</option>${departments.map((d) => `<option ${d === department ? "selected" : ""} value="${esc(d)}">${esc(d)}</option>`).join("")}</select><button type="submit">搜尋</button></form><div class="md-tags" aria-label="專長標籤">${tags.map((t) => `<button type="button" class="md-chip ${t.tag.toLowerCase() === tag.toLowerCase() ? "active" : ""}" data-tag="${esc(t.tag)}">${esc(t.tag)} <small>${t.member_count}</small></button>`).join("")}${tag ? '<button type="button" class="ghost" id="md-clear">清除標籤</button>' : ""}</div><div class="md-list">${members.map(card).join("") || '<div class="empty">目前沒有符合的同仁。名錄僅顯示自願公開的同仁。</div>'}</div>`;
    root.querySelector<HTMLElement>("#md-edit")!.onclick = () => {
      editing = !editing;
      draw();
    };
    root
      .querySelector<HTMLElement>("#md-cancel")
      ?.addEventListener("click", () => {
        editing = false;
        draw();
      });
    root.querySelector<HTMLFormElement>("#md-search")!.onsubmit = (ev) => {
      ev.preventDefault();
      const f = new FormData(ev.target as HTMLFormElement);
      query = String(f.get("q") ?? "").trim();
      department = String(f.get("dept") ?? "");
      void ctx.run(reload);
    };
    root.querySelectorAll<HTMLElement>("[data-tag]").forEach(
      (b) =>
        (b.onclick = () => {
          tag =
            tag.toLowerCase() === b.dataset.tag!.toLowerCase()
              ? ""
              : b.dataset.tag!;
          void ctx.run(reload);
        }),
    );
    const clear = root.querySelector<HTMLElement>("#md-clear");
    if (clear)
      clear.onclick = () => {
        tag = "";
        void ctx.run(reload);
      };
    // Opt-in aggregate counts (F14); renders nothing unless both flags are on and the member opted in.
    root
      .querySelectorAll<HTMLElement>("[data-participation]")
      .forEach(
        (el) =>
          void renderParticipationBadge(el, el.dataset.participation!, ctx),
      );
    root
      .querySelectorAll<HTMLElement>("[data-message]")
      .forEach((b) => (b.onclick = () => ctx.openMessage(b.dataset.message!)));
    const form = root.querySelector<HTMLFormElement>("#md-form");
    if (form)
      form.onsubmit = (ev) => {
        ev.preventDefault();
        void ctx.run(async () => {
          const f = new FormData(form);
          const draft = {
            bio: String(f.get("bio") ?? "").trim(),
            expertise_tags: parseTags(String(f.get("tags") ?? "")),
            question_topics: String(f.get("topics") ?? "").trim(),
          };
          if (draft.expertise_tags.length > 10)
            throw Error(errors.INVALID_TAGS);
          if (draft.expertise_tags.some((t) => t.length > 20))
            throw Error(errors.INVALID_TAGS);
          const checked = await ctx.review(draft);
          if (!checked) return;
          const p = checked.payload as typeof draft;
          const next: Mine = {
            listed: f.get("listed") === "on",
            bio: p.bio,
            expertise_tags: p.expertise_tags,
            open_to_questions: f.get("open") === "on",
            question_topics: p.question_topics,
          };
          if (ctx.demo || !client) {
            mine = next;
            ctx.toast("預覽模式不會儲存");
          } else {
            await rpc("upsert_my_directory_profile", {
              p_listed: next.listed,
              p_bio: next.bio,
              p_tags: next.expertise_tags,
              p_open: next.open_to_questions,
              p_topics: next.question_topics,
            });
            mine = next;
            ctx.toast("已儲存名錄資料");
          }
          editing = false;
          await reload();
        });
      };
  }

  async function reload() {
    const ticket = ++version;
    await loadAll();
    if (ticket === version && root.isConnected) draw();
  }

  root.innerHTML = '<p class="sub">載入同仁名錄…</p>';
  await reload();
}

registerFeature({
  key: "member_directory",
  nav: {
    id: "member_directory",
    label: "同仁名錄",
    iconPath:
      '<circle cx="9" cy="8" r="3"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/><path d="M16 5.5a3 3 0 0 1 0 5.5M18 14.3c1.8.8 3 2.6 3 5.7"/>',
  },
  render,
});
