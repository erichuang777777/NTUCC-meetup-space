/// <reference types="vite/client" />
import { mountPublicEvents, isPublicRoute } from "./public-events";
import { mountMemberAdmin } from "./member-admin";
import { mountMessages } from "./messages";
import { mountForum, coverFor } from "./forum";
import { createClient } from "@supabase/supabase-js";
import { scanValue, maskValue } from "./pii";
import { sandboxDocument } from "./player";
import { loadFeatureFlags, allFlags, isDemoFlags, isEnabled } from "./features";
import {
  featureForPage,
  featureNavs,
  featureAdminPanels,
  featureTopbars,
  type FeatureCtx,
} from "./feature-registry";
import "./features/index";
import { reportAttrs } from "./features/content_reports";
const inviteFragment = location.hash.match(
  /^#invite=(ntucc_inv_[a-f0-9]{64})$/,
);
if (inviteFragment) {
  sessionStorage.setItem("ntucc-member-invite", inviteFragment[1]);
  history.replaceState(null, "", location.pathname + location.search);
}
const url = import.meta.env.VITE_SUPABASE_URL,
  key = import.meta.env.VITE_SUPABASE_ANON_KEY;
const client = url && key ? createClient(url, key) : null;
const $ = <T extends HTMLElement = HTMLElement>(s: string) =>
  document.querySelector<T>(s)!;
const esc = (s: unknown) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
const read = async (q: any) => {
  const { data, error } = await q;
  if (error) throw Error(error.message);
  return data ?? [];
};
let user: any = null,
  profile: any = null,
  page = "announcements",
  filter = "全部",
  search = "",
  activeSession: any = null,
  spaces: any[] = [],
  announcements: any[] = [],
  pains: any[] = [],
  tokens: any[] = [],
  mySpaces: any[] = [],
  currentSpace: any = null;
let demo = !client;
const allowDemo = demo && import.meta.env.DEV;
let demoEntered = false;
const navs = [
  ["announcements", "公布欄"],
  ["stage", "專案探索"],
  ["registration", "活動報名"],
  ["pain", "痛點許願池"],
  ["workspace", "我的工作空間"],
  ["messages", "同仁訊息"],
];
const iconPaths: Record<string, string> = {
  messages: '<path d="M4 4h16v12H9l-5 4V4Z"/><path d="M8 8h8M8 12h5"/>',
  announcements:
    '<path d="M4 10v4h4l9 4V6l-9 4H4Z"/><path d="m8 14 1 6h3l-2-5M20 9v6"/>',
  stage:
    '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="m10 8 5 3-5 3V8ZM8 21l4-4 4 4"/>',
  registration:
    '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 3v4M17 3v4M3 10h18m-13 5 3 3 5-5"/>',
  pain: '<path d="M9 18h6m-6 3h6M8 14a6 6 0 1 1 8 0c-1 1-1 2-1 2H9s0-1-1-2Z"/>',
  workspace:
    '<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 5v2"/>',
  admin:
    '<path d="M12 3 4 7v6c0 4 8 8 8 8s8-4 8-8V7l-8-4Z"/><path d="m8 12 3 3 5-5"/>',
};
function icon(id: string) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${iconPaths[id] ?? iconPaths.announcements}</svg>`;
}
async function signIn() {
  if (!client) throw Error("尚未連接登入服務，可先使用下方的介面預覽。");
  const { error } = await client.auth.signInWithOAuth({
    provider: "google",
    options: {
      redirectTo: location.origin + "/#members",
      ...(sessionStorage.getItem("ntucc-member-invite")
        ? { queryParams: { prompt: "select_account" } }
        : {}),
    },
  });
  if (error) throw error;
}
function loginView() {
  $("#app").innerHTML =
    `<main class="login-page"><div class="login-art" role="img" aria-label="臺大癌醫同仁共同交流 AI 與工作經驗的插畫"></div><section class="login-card"><a class="login-brand" href="/">${icon("stage")} NTUCC <span>MEETUP SPACES</span></a><h1>登入</h1><p class="login-description">臺大癌醫交流空間</p><button id="login-google" class="login-google"><svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M21 12.2c0-.7-.1-1.4-.2-2.2H12v4h5a4.5 4.5 0 0 1-5 3.8 5.8 5.8 0 1 1 0-11.6c1.5 0 2.7.5 3.7 1.4l2.9-2.8A10 10 0 1 0 12 22c5.8 0 9-4 9-9.8Z"/></svg>使用 Google 帳號登入<span>↗</span></button><p class="login-note">${sessionStorage.getItem("ntucc-member-invite") ? "請使用受邀的 Google 帳號登入。" : "首次登入需驗證院內通關密語。"}</p>${allowDemo ? '<button id="demo-enter" class="login-demo">預覽介面（示例資料） →</button>' : ""}</section></main>`;
  $("#login-google").onclick = () => void run(signIn);
  if (allowDemo)
    $("#demo-enter").onclick = () =>
      void run(async () => {
        demoEntered = true;
        page = "announcements";
        history.replaceState(
          null,
          "",
          location.pathname + location.search + "#announcements",
        );
        await load();
        render();
      });
}
const LIST =
  "id,owner_id,title,category_tag,summary,highlights,slide_count,reference_links,has_cover,votes,vibe_counts,slot_order,session_id,visibility,created_at";
const demoSpaces = [
  {
    id: "demo1",
    title: "把繁瑣的會議紀錄，變成一份清楚的待辦",
    summary: "從逐字稿到行動清單，分享行政工作裡真正省下時間的 AI 小流程。",
    category_tag: "實戰展示",
    highlights: ["流程拆解", "Prompt 設計"],
    slide_count: 12,
    votes: 24,
    vibe_counts: { mindblown: 12 },
    reference_links: [],
    owner_id: "demo",
    visibility: "public",
  },
  {
    id: "demo2",
    title: "我的 AI 助手很會說，但不一定說得對",
    summary:
      "一次文件摘要實驗的踩坑筆記：那些看起來合理、卻需要重新查證的答案。",
    category_tag: "踩坑避雷",
    highlights: ["文件摘要", "人工查核"],
    slide_count: 10,
    votes: 18,
    vibe_counts: { need_this: 8 },
    reference_links: [],
    owner_id: "demo",
    visibility: "public",
  },
  {
    id: "demo3",
    title: "交班資訊不漏接：試做一個小小的整理工具",
    summary: "以合成資料示範資訊整理，從第一版原型談起，也聊聊尚未解決的限制。",
    category_tag: "實戰展示",
    highlights: ["合成資料", "早期原型"],
    slide_count: 11,
    votes: 16,
    vibe_counts: { pii_safe: 7 },
    reference_links: [],
    owner_id: "demo",
    visibility: "public",
  },
];
function toast(msg: string) {
  $("#toast").textContent = msg;
  $("#toast").style.display = "block";
  setTimeout(() => ($("#toast").style.display = "none"), 4500);
}
function requireMember() {
  if (!profile?.passcode_verified) {
    toast("請先使用 Google 登入並完成院內通關驗證");
    return false;
  }
  return true;
}
async function review(
  payload: any,
): Promise<{ payload: any; force_override: boolean } | null> {
  const found = scanValue(payload);
  if (!found.length) return { payload, force_override: false };
  const dialog = $<HTMLDialogElement>("#pii");
  $("#pii-items").innerHTML = found
    .map(
      (x) =>
        `<p><span class="badge orange">${esc(x.type)}</span> <mark>${esc(x.text)}</mark></p>`,
    )
    .join("");
  const check = $<HTMLInputElement>("#responsibility");
  check.checked = false;
  const override = $<HTMLButtonElement>("#pii-override");
  override.disabled = true;
  check.onchange = () => (override.disabled = !check.checked);
  dialog.showModal();
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: any) => {
      if (done) return;
      done = true;
      dialog.close();
      resolve(v);
    };
    $("#pii-mask").onclick = () =>
      finish({ payload: maskValue(payload), force_override: false });
    override.onclick = () => {
      if (check.checked) finish({ payload, force_override: true });
    };
    $("#pii-cancel").onclick = () => finish(null);
    dialog.oncancel = (e) => {
      e.preventDefault();
      finish(null);
    };
  });
}
async function send(action: string, payload: any = {}, reviewContent = true) {
  if (!requireMember()) throw Error("請先完成登入與通關");
  const reviewed = reviewContent
    ? await review(payload)
    : { payload, force_override: false };
  if (!reviewed) throw Error("已返回修改，尚未送出");
  const session = (await client!.auth.getSession()).data.session;
  const r = await fetch("/api/v1/spaces", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${session?.access_token}`,
    },
    body: JSON.stringify({ action, ...reviewed }),
  });
  const data = await r.json();
  if (!r.ok) {
    if (data.code === "PII_DETECTED") toast("後端偵測到個資，請重新檢視內容");
    throw Error(data.code ?? "請求失敗");
  }
  return data;
}
function featureCtx(): FeatureCtx {
  return {
    client,
    user,
    profile,
    demo,
    isAdmin: profile?.role === "admin",
    esc,
    toast,
    run,
    review,
    navigate: (p) => {
      page = p;
      filter = "全部";
      search = "";
      location.hash = p;
      render();
    },
    isEnabled,
    openMessage: (userId) => {
      contactTarget = userId;
      contactProject = undefined;
      page = "messages";
      history.pushState(null, "", "#messages");
      render();
    },
  };
}
async function load() {
  if (!demo && !profile?.passcode_verified) return;
  await loadFeatureFlags(client);
  if (demo) {
    spaces = demoSpaces;
    announcements = [
      {
        id: "demo",
        title: "每個小實驗，都值得被分享",
        category: "活動公告",
        content:
          "這裡是介面示範。連接 Supabase 後，將顯示真實場次與院內同仁的展示。",
        is_pinned: true,
      },
    ];
    pains = [];
    return;
  }
  const results = await Promise.all([
    read(
      client!
        .from("spaces")
        .select(LIST)
        .eq("visibility", "public")
        .order("votes", { ascending: false }),
    ),
    read(
      client!
        .from("announcements")
        .select("id,title,category,content,is_pinned,created_at")
        .order("is_pinned", { ascending: false })
        .order("created_at", { ascending: false }),
    ),
    read(
      client!
        .from("pain_points")
        .select("id,title,scenario,department,time_cost,ideal_outcome,upvotes")
        .order("upvotes", { ascending: false }),
    ),
    read(
      client!
        .from("meetup_sessions")
        .select("id,title,session_date,start_time,location")
        .eq("is_active", true),
    ),
  ]);
  [spaces, announcements, pains] = results;
  activeSession = results[3][0] ?? null;
}
let galleryMode = "swipe";
let coverObserver: IntersectionObserver | null = null;
let selectedThread: string | undefined;
let contactTarget: string | undefined;
let contactProject: string | undefined;
function render() {
  coverObserver?.disconnect();
  if (qaPoll) clearInterval(qaPoll);
  qaPoll = null;
  if (!user && !demoEntered) {
    loginView();
    return;
  }
  const invite = sessionStorage.getItem("ntucc-member-invite");
  if (user && invite) {
    $("#app").innerHTML =
      `<main class="access-gate"><a class="login-brand" href="/">NTUCC Meetup Spaces</a><h1>加入交流空間</h1><p class="sub">目前帳號：${esc(user.email)}</p><p class="sub">接受後將依邀請設定開通網站權限。</p><div class="actions"><button id="accept-invitation">接受邀請</button><button id="invitation-switch" class="ghost">切換帳號</button><button id="invitation-skip" class="ghost">略過</button></div></main>`;
    $("#accept-invitation").onclick = () =>
      void run(async () => {
        const button = $<HTMLButtonElement>("#accept-invitation");
        button.disabled = true;
        try {
          await membersRequest("POST", { action: "accept", token: invite });
          sessionStorage.removeItem("ntucc-member-invite");
          await refreshProfile();
          await load();
          page = "announcements";
          render();
        } finally {
          if (button.isConnected) button.disabled = false;
        }
      });
    $("#invitation-switch").onclick = () =>
      void run(async () => {
        const { error } = await client!.auth.signOut();
        if (error) throw error;
        user = null;
        profile = null;
        render();
      });
    $("#invitation-skip").onclick = () => {
      sessionStorage.removeItem("ntucc-member-invite");
      render();
    };
    return;
  }
  if (user && !profile?.passcode_verified) {
    $("#app").innerHTML =
      `<main class="access-gate"><a class="login-brand" href="/">NTUCC Meetup Spaces</a>${gate()}<button id="gate-signout" class="ghost">登出</button></main>`;
    $("#gate-signout").onclick = () =>
      void run(async () => {
        const { error } = await client!.auth.signOut();
        if (error) throw error;
        user = null;
        profile = null;
        render();
      });
    $("#passcode-form").onsubmit = (e) => {
      e.preventDefault();
      void run(async () => {
        const input = $<HTMLInputElement>("#passcode");
        const { data, error } = await client!.rpc("verify_ntucc_passcode", {
          input_code: input.value,
        });
        input.value = "";
        if (error || !data) throw Error("密語不正確或嘗試過多，請稍後再試");
        await refreshProfile();
        await load();
        const pending = sessionStorage.getItem("ntucc-project-link");
        sessionStorage.removeItem("ntucc-project-link");
        const target = pending?.match(
          /^#project\/([0-9a-f-]{36})(?:\/thread\/([0-9a-f-]{36}))?$/i,
        );
        if (target) await openSpace(target[1], target[2]);
        else {
          page = "announcements";
          render();
        }
      });
    };
    return;
  }
  $("#app").innerHTML =
    `<div class="shell"><main class="main"><header class="topbar"><a class="app-brand" href="#announcements">${icon("stage")}<span>NTUCC <small>Meetup Spaces</small></span></a><div class="top-actions"><span id="top-features" class="top-features"></span><span class="muted">${profile ? esc(profile.display_name) : "示例預覽"}</span><button id="auth" class="secondary">${user ? "登出" : "回登入頁"}</button></div></header><div class="content">${demo ? '<div class="notice">預覽 · 示例資料</div>' : ""}${user && !profile?.passcode_verified ? gate() : ""}<div id="view"></div></div></main><nav class="bottom-nav" aria-label="主要功能">${navHtml()}</nav>${moreMenuHtml()}</div>`;
  const topFeatures = $("#top-features");
  for (const topbar of featureTopbars()) {
    try {
      const el = topbar(featureCtx());
      if (el) topFeatures.append(el);
    } catch (e) {
      console.error(e);
    }
  }
  const moreButton = document.querySelector<HTMLElement>("#nav-more");
  if (moreButton)
    moreButton.onclick = () => {
      const menu = $("#nav-more-menu");
      menu.hidden = !menu.hidden;
      moreButton.setAttribute("aria-expanded", String(!menu.hidden));
    };
  document.querySelectorAll<HTMLElement>("[data-nav]").forEach(
    (b) =>
      (b.onclick = () => {
        page = b.dataset.nav!;
        filter = "全部";
        search = "";
        location.hash = page;
        render();
      }),
  );
  $(".app-brand").onclick = (e) => {
    e.preventDefault();
    page = "announcements";
    location.hash = page;
    render();
  };
  $("#auth").onclick = () =>
    void run(async () => {
      if (user) {
        const { error } = await client!.auth.signOut();
        if (error) throw error;
      }
      user = null;
      profile = null;
      demoEntered = false;
      page = "announcements";
      history.replaceState(
        null,
        "",
        location.pathname + location.search + "#members",
      );
      render();
    });
  const feature = featureForPage(page);
  if (feature?.render) {
    const render = feature.render;
    void run(async () => render($("#view"), featureCtx()));
    return;
  }
  switch (page) {
    case "members":
      if (profile?.role !== "admin") {
        page = "announcements";
        render();
        break;
      }
      $("#view").innerHTML = '<p class="sub">載入成員…</p>';
      void run(() =>
        mountMemberAdmin($("#view"), {
          ownId: user.id,
          request: membersRequest,
          toast,
          back: () => {
            page = "admin";
            location.hash = "admin";
            render();
          },
        }),
      );
      break;
    case "messages":
      $("#view").innerHTML = '<p class="sub">正在載入同仁訊息…</p>';
      void run(() =>
        mountMessages($("#view"), {
          actorId: user?.id ?? "demo-me",
          demo,
          recipientId: contactTarget,
          projectId: contactProject,
          request: agentRequest,
          review,
          toast,
          openProject: (id) => void run(() => openSpace(id)),
        }),
      );
      contactTarget = undefined;
      contactProject = undefined;
      break;
    case "project":
      $("#view").innerHTML = '<p class="sub">正在開啟專案…</p>';
      void run(renderProject);
      break;
    case "stage":
      stage();
      break;
    case "announcements":
      announcementView();
      break;
    case "registration":
      void run(registration);
      break;
    case "pain":
      painView();
      break;
    case "workspace":
      void run(workspace);
      break;
    case "admin":
      void run(adminView);
      break;
    default:
      stage();
  }
}
// Base items stay on the bar; feature nav items are grouped under "更多".
function navHtml() {
  const isActive = (id: string) =>
    page === id ||
    (page === "project" && id === "stage") ||
    (page === "members" && id === "admin");
  const item = ([id, label]: string[]) =>
    `<button data-nav="${id}" aria-label="${label}" ${isActive(id) ? 'aria-current="page"' : ""} class="${isActive(id) ? "active" : ""}">${icon(id)}<span>${label}</span></button>`;
  const base = [
    ...navs,
    ...(profile?.role === "admin" ? [["admin", "管理後台"]] : []),
  ];
  const extra = featureNavs();
  for (const n of extra) iconPaths[n.id] = n.iconPath;
  if (!extra.length) return base.map(item).join("");
  const moreActive = extra.some((n) => n.id === page);
  return (
    base.map(item).join("") +
    `<button id="nav-more" aria-label="更多" aria-haspopup="true" aria-expanded="false" class="${extra.some((n) => n.id === page) ? "active" : ""}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><circle cx="5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="19" cy="12" r="1.2"/></svg><span>更多</span></button>`
  );
}
// Rendered outside <nav>: the nav's backdrop-filter would otherwise trap position:fixed.
function moreMenuHtml() {
  const extra = featureNavs();
  if (!extra.length) return "";
  return `<div id="nav-more-menu" class="nav-more-menu bottom-nav-menu" hidden>${extra
    .map(
      (n) =>
        `<button data-nav="${n.id}" aria-label="${n.label}" ${page === n.id ? 'aria-current="page"' : ""} class="${page === n.id ? "active" : ""}">${icon(n.id)}<span>${n.label}</span></button>`,
    )
    .join("")}</div>`;
}
function gate() {
  return `<div class="panel"><h2>歡迎加入院內交流</h2><p class="sub">請先輸入院內通關密語，完成驗證後即可查看公布欄與同仁分享。</p><form id="passcode-form"><label>院內通關密語<input id="passcode" type="password" required autocomplete="off" maxlength="100"></label><button>驗證並加入</button></form></div>`;
}
async function run(fn: () => Promise<any>) {
  try {
    await fn();
  } catch (e) {
    toast(e instanceof Error ? e.message : "操作失敗");
  }
}
function heading(kicker: string, title: string, _desc: string) {
  const names: Record<string, string> = {
    "COMMUNITY NOTICEBOARD": "公布欄",
    "DISCOVER · DISCUSS · BUILD": "專案探索",
    "COME MEET YOUR COLLEAGUES": "活動",
    "SMALL PAINS, BIG POSSIBILITIES": "痛點許願池",
    "YOUR PRIVATE WORKSPACE": "我的空間",
    "YOUR AGENT CONNECTION": "我的空間",
    "COMMUNITY OPERATIONS": "管理",
  };
  return `<div class="page-heading"><h1>${names[kicker] ?? esc(title)}</h1></div>`;
}
function stage() {
  coverObserver?.disconnect();
  const list = spaces.filter(
    (s) =>
      (filter === "全部" || s.category_tag === filter) &&
      (s.title + s.summary).toLowerCase().includes(search.toLowerCase()),
  );
  $("#view").innerHTML =
    heading(
      "DISCOVER · DISCUSS · BUILD",
      "滑一滑，找到想一起聊的專案。",
      "先從圖片認識同仁的小實驗。點進專案，問題、心得與資源都在同一個討論區。",
    ) +
    `<div class="explore-toolbar"><input id="space-search" type="search" class="search" placeholder="搜尋專案" aria-label="搜尋展示" value="${esc(search)}"><select id="space-filter" aria-label="專案類型">${["全部", "實戰展示", "踩坑避雷"].map((t) => `<option value="${t}" ${filter === t ? "selected" : ""}>${t === "全部" ? "全部類型" : t}</option>`).join("")}</select><button id="gallery-toggle" class="icon-button" aria-label="${galleryMode === "swipe" ? "切換為圖片總覽" : "切換為滑動瀏覽"}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">${galleryMode === "swipe" ? '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>' : '<rect x="4" y="4" width="12" height="16" rx="2"/><path d="M20 5v14"/>'}</svg></button><button id="create-space">＋ 分享</button></div><div class="project-gallery ${galleryMode === "grid" ? "gallery-grid" : ""}" aria-label="專案圖片探索" tabindex="0">${list.map(card).join("")}</div>${!list.length ? '<div class="empty">沒有符合的專案</div>' : ""}`;
  $("#gallery-toggle").onclick = () => {
    galleryMode = galleryMode === "swipe" ? "grid" : "swipe";
    stage();
  };
  $<HTMLSelectElement>("#space-filter").onchange = (ev) => {
    filter = (ev.target as HTMLSelectElement).value;
    stage();
  };
  const gallery = $(".project-gallery");
  gallery.onkeydown = (ev) => {
    if (ev.key === "ArrowRight" || ev.key === "ArrowLeft") {
      ev.preventDefault();
      gallery.scrollBy({
        left:
          (gallery.querySelector<HTMLElement>(".card")?.offsetWidth ?? 300) *
          (ev.key === "ArrowRight" ? 1 : -1),
        behavior: "smooth",
      });
    }
  };
  $("#create-space").onclick = () => {
    if (requireMember()) editSpace();
  };
  $<HTMLInputElement>("#space-search").oninput = (e) => {
    const pos = (e.target as HTMLInputElement).selectionStart;
    search = (e.target as HTMLInputElement).value;
    stage();
    const input = $<HTMLInputElement>("#space-search");
    input.focus();
    input.setSelectionRange(pos, pos);
  };
  coverObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const img = entry.target as HTMLImageElement;
        coverObserver?.unobserve(img);
        const space = list.find((s) => s.id === img.dataset.spaceCover);
        if (space)
          void loadSpaceCover(space).then((url) => {
            if (url && img.isConnected) img.src = url;
          });
      }
    },
    { rootMargin: "150px" },
  );
  document
    .querySelectorAll<HTMLImageElement>(".project-cover img[data-space-cover]")
    .forEach((img) => coverObserver!.observe(img));
  document
    .querySelectorAll<HTMLElement>("[data-open]")
    .forEach((b) => (b.onclick = () => run(() => openSpace(b.dataset.open!))));
}
function slotLabel(s: any) {
  if (
    !activeSession ||
    s.session_id !== activeSession.id ||
    s.slot_order == null
  )
    return "10 MIN";
  const [h, m] = activeSession.start_time.split(":").map(Number);
  const start = h * 60 + m + s.slot_order * 10;
  const fmt = (n: number) =>
    `${String(Math.floor(n / 60) % 24).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`;
  return `${fmt(start)}–${fmt(start + 10)}`;
}
function card(s: any, i: number) {
  return `<article class="card"${reportAttrs("space", s.id, s.owner_id)}><button class="project-cover project-open" data-open="${esc(s.id)}" aria-label="查看專案：${esc(s.title)}"><div class="cover-image"><img ${s.has_cover ? `data-space-cover="${esc(s.id)}"` : ""} src="${esc(coverFor(s, i))}" alt="${esc(s.title)}的專案封面" loading="lazy" width="800" height="520">${s.has_cover || s.cover_image ? "" : '<span class="cover-caption">示意圖</span>'}</div><div class="card-body"><h3>${esc(s.title)}</h3><div class="project-meta"><span>${s.category_tag === "踩坑避雷" ? "踩坑避雷" : "實戰展示"}</span><span>♡ ${s.votes}</span></div></div></button></article>`;
}
async function openSpace(id: string, threadId?: string, push = true) {
  currentSpace =
    spaces.find((s) => s.id === id) ?? mySpaces.find((s) => s.id === id);
  if (!currentSpace && !demo) {
    const result = await client!
      .from("spaces")
      .select(LIST)
      .eq("id", id)
      .maybeSingle();
    if (result.error) throw result.error;
    currentSpace = result.data;
  }
  if (!currentSpace) throw Error("此專案不存在或沒有瀏覽權限");
  selectedThread = threadId;
  page = "project";
  if (push)
    history.pushState(
      null,
      "",
      `#project/${encodeURIComponent(id)}${threadId ? "/thread/" + encodeURIComponent(threadId) : ""}`,
    );
  render();
  window.scrollTo({ top: 0, behavior: "instant" });
}
async function loadSpaceCover(space: any): Promise<string | undefined> {
  if (space.cover_image) return space.cover_image;
  if (!space.has_cover || !client) return;
  const { data, error } = await client
    .from("spaces")
    .select("cover_image")
    .eq("id", space.id)
    .maybeSingle();
  if (!error && data?.cover_image) {
    space.cover_image = data.cover_image;
    return data.cover_image;
  }
}
async function renderProject() {
  const s = currentSpace;
  if (!s) return;
  $("#view").innerHTML =
    `<button id="back-discover" class="text-button">← 返回專案探索</button><header class="project-heading"><img src="${esc(coverFor(s))}" alt="${esc(s.title)}的封面" width="800" height="520"><h1>${esc(s.title)}</h1><details class="action-menu"><summary aria-label="專案選項">⋯</summary><div class="menu-items"><button id="project">▶ 全螢幕投影</button>${user?.id !== s.owner_id ? '<button id="contact-owner">聯絡分享者</button>' : ""}<button id="space-vote">♡ 我想聽 · ${s.votes}</button>${user?.id === s.owner_id ? '<button id="edit-current">編輯專案</button>' : ""}</div></details></header><div class="project-folds"><details id="project-info"><summary>專案資訊</summary>${s.slot_order != null && s.session_id === activeSession?.id ? `<p class="muted">${slotLabel(s)}</p>` : ""}<p class="thread-body">${esc(s.summary)}</p>${(s.reference_links ?? []).map(safeLink).join("")}<details class="vibe-options"><summary>共鳴</summary><div class="actions">${vibeButtons()}</div></details></details>${s.visibility === "public" ? `<details id="project-qa"><summary>講者 Q&A</summary><div id="questions"></div><form id="question-form"><label><span class="sr-only">提問</span><textarea name="question_text" required maxlength="2000" placeholder="想請教講者什麼？"></textarea></label><div class="row"><label class="check"><input name="is_anonymous" type="checkbox">匿名</label><button>送出提問</button></div></form></details>` : ""}</div><section id="project-content" aria-label="專案討論"></section>`;
  if (s.has_cover && !s.cover_image)
    void loadSpaceCover(s).then((url) => {
      const img = $<HTMLImageElement>(".project-heading>img");
      if (url && img && currentSpace?.id === s.id) img.src = url;
    });
  $("#back-discover").onclick = () => {
    page = "stage";
    location.hash = "stage";
    render();
  };
  $("#project").onclick = () => void run(() => project(s));
  $("#space-vote").onclick = () =>
    void run(async () => {
      await send("vote", { target_type: "space", target_id: s.id });
      toast("已記錄");
    });
  if ($("#contact-owner"))
    $("#contact-owner").onclick = () => {
      contactTarget = s.owner_id;
      contactProject = s.id;
      page = "messages";
      history.pushState(null, "", "#messages");
      render();
    };
  if ($("#edit-current")) $("#edit-current").onclick = () => editSpace(s);
  document
    .querySelectorAll<HTMLElement>("#project-info [data-vibe]")
    .forEach(
      (b) => (b.onclick = () => void run(() => vibe(s.id, b.dataset.vibe!))),
    );
  if ($("#project-qa")) {
    $<HTMLDetailsElement>("#project-qa").ontoggle = () => {
      if (qaPoll) clearInterval(qaPoll);
      qaPoll = null;
      if ($<HTMLDetailsElement>("#project-qa").open) {
        void run(() => loadQuestions(s));
        qaPoll = setInterval(() => {
          if ($("#questions") && $<HTMLDetailsElement>("#project-qa")?.open)
            void run(() => loadQuestions(s));
        }, 10000);
      }
    };
  }
  if ($("#question-form"))
    $("#question-form").onsubmit = (ev) => {
      ev.preventDefault();
      void run(async () => {
        const form = ev.target as HTMLFormElement,
          f = new FormData(form);
        await send("question", {
          space_id: s.id,
          question_text: f.get("question_text"),
          is_anonymous: f.get("is_anonymous") === "on",
        });
        form.reset();
        await loadQuestions(s);
      });
    };
  const root = $("#project-content");
  if (s.visibility === "private") {
    root.innerHTML = '<p class="sub">私人草稿，發布後開放討論。</p>';
    return;
  }
  await mountForum(root, {
    client,
    demo,
    space: s,
    actorId: user?.id,
    admin: profile?.role === "admin",
    threadId: selectedThread,
    send,
    review,
    toast,
    navigate: (thread) => void run(() => openSpace(s.id, thread)),
  });
}
async function membersRequest(method: string, payload?: any, query = "") {
  const session = (await client!.auth.getSession()).data.session;
  if (!session) throw Error("請先登入");
  const response = await fetch("/api/members" + query, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + session.access_token,
    },
    ...(method === "POST" ? { body: JSON.stringify(payload) } : {}),
  });
  const data = await response.json();
  if (!response.ok) {
    const messages: Record<string, string> = {
      ADMIN_REQUIRED: "只有管理員能操作。",
      INTERACTIVE_LOGIN_REQUIRED: "請從網站登入後操作。",
      INVITATION_INVALID: "邀請已失效、過期或遭撤銷，請向管理員索取新連結。",
      INVITE_ACCOUNT_MISMATCH: "請切換為受邀的 Google 帳號。",
      GOOGLE_LOGIN_REQUIRED: "請使用 Google 帳號登入。",
      SELF_ROLE_CHANGE_FORBIDDEN: "不能更改自己的管理員權限。",
      LAST_ADMIN: "必須保留至少一位管理員。",
      MEMBER_NOT_VERIFIED: "該成員尚未完成驗證。",
      INVITATION_NOT_PENDING: "此邀請已接受或撤銷。",
      RATE_LIMITED: "操作次數已達上限，請稍後再試。",
    };
    throw Error(messages[data.code] ?? "操作失敗，請稍後再試。");
  }
  return data;
}
async function agentRequest(method: string, path: string, payload?: any) {
  if (!requireMember()) throw Error("請先登入並通關");
  let input = payload;
  if (payload?.body) {
    const checked = await review(payload);
    if (!checked) throw Error("已返回修改");
    input = { ...checked.payload, force_override: checked.force_override };
  }
  const session = (await client!.auth.getSession()).data.session;
  const response = await fetch("/api/v1/agent/" + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + session?.access_token,
    },
    ...(method === "POST" ? { body: JSON.stringify(input) } : {}),
  });
  const result = await response.json();
  if (!response.ok) {
    const messages: Record<string, string> = {
      CONTACT_UNAVAILABLE: "對方目前不接受聯絡，或此聯絡已停用。",
      TOKEN_SCOPE_REQUIRED: "這組 Token 尚未開啟私訊權限。",
      RATE_LIMITED: "本小時的傳送次數已達上限，請稍後再試。",
      CONVERSATION_NOT_FOUND: "找不到這個對話，或您沒有讀取權限。",
    };
    throw Error(messages[result.code] ?? result.code ?? "請求失敗");
  }
  return result;
}
function safeLink(l: any) {
  try {
    if (new URL(l.url).protocol !== "https:") return "";
    return `<p><span class="badge">${esc(l.label)}</span> <a href="${esc(l.url)}" target="_blank" rel="noopener noreferrer">${esc(l.title)} ↗</a></p>`;
  } catch {
    return "";
  }
}
async function loadQuestions(s: any) {
  if (demo) {
    $("#questions").innerHTML = '<p class="sub">示範展示，尚無真實提問。</p>';
    return;
  }
  const qs = await read(
    client!
      .from("qa_public")
      .select(
        "id,question_text,author_name,is_resolved,speaker_reply,upvotes,created_at",
      )
      .eq("space_id", s.id)
      .order("upvotes", { ascending: false }),
  );
  $("#questions").innerHTML =
    qs
      .map(
        (q: any) =>
          `<div class="list-item"${reportAttrs("qa", q.id)}><div class="row"><span class="muted">${esc(q.author_name)} ${q.is_resolved ? "· ✅ 已回答" : ""}</span><button class="secondary" data-qa-vote="${q.id}">↑ ${q.upvotes}</button></div><p>${esc(q.question_text)}</p>${q.speaker_reply ? `<p class="sub">講者：${esc(q.speaker_reply)}</p>` : ""}${s.owner_id === user?.id && !q.is_resolved ? `<button data-resolve="${q.id}" class="ghost">標記已回答</button>` : ""}</div>`,
      )
      .join("") || '<p class="sub">第一個好問題，從你開始。</p>';
  document.querySelectorAll<HTMLElement>("[data-qa-vote]").forEach(
    (b) =>
      (b.onclick = () =>
        run(async () => {
          await send("vote", {
            target_type: "qa",
            target_id: b.dataset.qaVote,
          });
          await loadQuestions(s);
        })),
  );
  document.querySelectorAll<HTMLElement>("[data-resolve]").forEach(
    (b) =>
      (b.onclick = () =>
        run(async () => {
          await send("resolve", { id: b.dataset.resolve, speaker_reply: "" });
          await loadQuestions(s);
        })),
  );
}
const vibes = [
  ["mindblown", "🤯", "神級效率"],
  ["need_this", "🏥", "我們科也需要"],
  ["pii_safe", "🔒", "資安給過"],
  ["want_link", "👏", "跪求連結"],
];
function vibeButtons() {
  return vibes
    .map(
      ([id, emoji, title]) =>
        `<button class="secondary" data-vibe="${id}">${emoji} ${title}</button>`,
    )
    .join("");
}
async function vibe(id: string, kind: string) {
  await send("vibe", { space_id: id, kind });
  bubble(kind);
}
function bubble(kind: string) {
  const item = vibes.find((v) => v[0] === kind);
  if (!item) return;
  const b = document.createElement("div");
  b.className = "bubble";
  b.textContent = item[1] + " " + item[2];
  $("#bubbles").append(b);
  setTimeout(() => b.remove(), 3000);
}
async function showStageQuestion(id: string) {
  const q = await read(
    client!
      .from("qa_public")
      .select("question_text,upvotes")
      .eq("space_id", id)
      .eq("is_resolved", false)
      .order("upvotes", { ascending: false })
      .limit(1),
  );
  if (q[0]) {
    $("#stage-question").textContent =
      `高票 Q&A · ${q[0].upvotes} 票：${q[0].question_text}`;
    $("#stage-question").hidden = false;
  }
}
let qaShown = false;
let timer: ReturnType<typeof setInterval> | null = null,
  started = 0,
  nonce = "",
  vibeChannel: any = null,
  qaPoll: ReturnType<typeof setInterval> | null = null;
async function project(s: any) {
  if (!requireMember()) return;
  const session = (await client!.auth.getSession()).data.session;
  const r = await fetch("/api/v1/spaces/" + s.id + "/slides", {
    headers: { Authorization: "Bearer " + session?.access_token },
  });
  const data = await r.json();
  if (!r.ok) throw Error(data.code);
  if (!data?.html_slides) throw Error("講者尚未上傳投影片");
  qaShown = false;
  nonce = crypto.randomUUID();
  const frame = $<HTMLIFrameElement>("#slide-frame");
  frame.srcdoc = sandboxDocument(data.html_slides, nonce);
  const player = $<HTMLDialogElement>("#player");
  player.showModal();
  $("#player-vibes").innerHTML = vibeButtons();
  document
    .querySelectorAll<HTMLElement>("#player [data-vibe]")
    .forEach((b) => (b.onclick = () => run(() => vibe(s.id, b.dataset.vibe!))));
  $("#stage-question").hidden = true;
  $("#countdown").textContent = "10:00";
  $("#phase").textContent = "演示期";
  $("#countdown").className = "";
  $<HTMLButtonElement>("#timer-start").disabled = false;
  $("#prev-slide").onclick = () => navigate(-1);
  $("#next-slide").onclick = () => navigate(1);
  $("#fullscreen").onclick = () =>
    run(async () => {
      if (!document.fullscreenElement) await player.requestFullscreen();
      else await document.exitFullscreen();
    });
  $("#timer-start").onclick = () => {
    started = Date.now();
    $<HTMLButtonElement>("#timer-start").disabled = true;
    timer = setInterval(() => {
      const elapsed = (Date.now() - started) / 1000,
        remaining = Math.max(0, 600 - Math.floor(elapsed));
      $("#countdown").textContent =
        `${String(Math.floor(remaining / 60)).padStart(2, "0")}:${String(remaining % 60).padStart(2, "0")}`;
      $("#phase").textContent =
        elapsed < 420 ? "演示期" : elapsed < 540 ? "高票 Q&A" : "收尾期";
      $("#countdown").className =
        elapsed >= 540 ? "red" : elapsed >= 420 ? "amber" : "";
      if (elapsed >= 420 && !qaShown) {
        qaShown = true;
        void run(() => showStageQuestion(s.id));
      }
      if (elapsed >= 600 && timer) {
        clearInterval(timer);
        timer = null;
      }
    }, 1000);
  };
  const close = () => {
    if (timer) clearInterval(timer);
    if (qaPoll) clearInterval(qaPoll);
    timer = qaPoll = null;
    if (vibeChannel) void client!.removeChannel(vibeChannel);
    frame.srcdoc = "";
    if (document.fullscreenElement) void document.exitFullscreen();
    player.close();
  };
  $("#close-player").onclick = close;
  player.oncancel = (e) => {
    e.preventDefault();
    close();
  };
  vibeChannel = client!
    .channel("stage-" + s.id)
    .on(
      "postgres_changes",
      {
        event: "INSERT",
        schema: "public",
        table: "vibe_events",
        filter: "space_id=eq." + s.id,
      },
      (p) => bubble(p.new.kind),
    )
    .subscribe();
  qaPoll = setInterval(() => {
    if (currentSpace && $("#questions")) void loadQuestions(currentSpace);
  }, 10000);
}
function navigate(delta: number) {
  $<HTMLIFrameElement>("#slide-frame").contentWindow?.postMessage(
    { type: "navigate", delta, key: nonce },
    "*",
  );
}
window.addEventListener("message", (e) => {
  if (
    e.source !== $<HTMLIFrameElement>("#slide-frame").contentWindow ||
    e.data?.key !== nonce ||
    e.data.type !== "slide"
  )
    return;
  const { index, total } = e.data;
  if (
    !Number.isInteger(index) ||
    !Number.isInteger(total) ||
    total < 10 ||
    total > 15
  )
    return;
  $("#page-count").textContent = `${index + 1} / ${total}`;
  const p = $<HTMLProgressElement>("#slide-progress");
  p.max = total;
  p.value = index + 1;
});
window.addEventListener("keydown", (e) => {
  if (!$<HTMLDialogElement>("#player").open) return;
  if (e.key === "ArrowRight") navigate(1);
  if (e.key === "ArrowLeft") navigate(-1);
});
function announcementView() {
  $("#view").innerHTML =
    heading(
      "COMMUNITY NOTICEBOARD",
      "重要的事，在這裡知道。",
      "最新活動、分享消息與交流安排，都在這裡。",
    ) +
    `<div class="announcement-list">${announcements.map((a, i) => `<article class="list-item"><details ${a.is_pinned && i === 0 ? "open" : ""}><summary><span>${esc(a.title)}</span>${a.is_pinned ? "<small>置頂</small>" : ""}</summary><p class="detail-summary">${esc(a.content)}</p>${profile?.role === "admin" ? `<button class="text-button" data-pin="${a.id}" data-value="${!a.is_pinned}">${a.is_pinned ? "取消置頂" : "置頂"}</button>` : ""}</details></article>`).join("") || '<p class="empty">目前沒有公告</p>'}</div>`;
  document.querySelectorAll<HTMLElement>("[data-pin]").forEach(
    (b) =>
      (b.onclick = () =>
        run(async () => {
          await send("pin", {
            id: b.dataset.pin,
            is_pinned: b.dataset.value === "true",
          });
          await load();
          announcementView();
        })),
  );
}
async function registration() {
  const s = activeSession;
  $("#view").innerHTML =
    heading(
      "COME MEET YOUR COLLEAGUES",
      "留一段時間，給新的可能。",
      "一起交流、聊聊實驗，也把彼此的經驗帶回工作現場。",
    ) +
    (!s
      ? '<div class="empty">新的 Meetup 正在準備中，請留意公布欄。</div>'
      : `<div class="two"><section class="panel"><span class="badge">本期 Meetup</span><h2>${esc(s.title)}</h2><p>▦ ${esc(s.session_date)}　${esc(s.start_time.slice(0, 5))}<br>⌖ ${esc(s.location)}</p><p class="sub">是否供餐與領取方式，請以各場活動公告為準。</p></section><section class="panel"><h2>報名與報到</h2><div id="registration-state"></div></section></div><div id="speaker-checkin"></div>`);
  if (!s) return;
  if (!profile?.passcode_verified) {
    $("#registration-state").innerHTML =
      '<p class="sub">登入並通過院內通關驗證後即可報名。</p>';
    return;
  }
  void run(() => speakerCheckin(s));
  const rows = await read(
    client!
      .from("registrations")
      .select("id,meal_preference,checked_in")
      .eq("user_id", user.id)
      .eq("session_id", s.id),
  );
  const reg = rows[0];
  $("#registration-state").innerHTML = reg
    ? `<p>✅ 已報名 · ${esc(reg.meal_preference)}</p><p>${reg.checked_in ? "✅ 已完成現場報到" : "尚未報到。請現場掃描工作人員提供的報到連結。"}</p><label>現場 QR Code 連結<input id="checkin-url" type="url" placeholder="掃描後貼入本院活動報到連結"></label><button id="scan-self" class="secondary">開啟相機掃描</button> <button id="self-checkin" ${reg.checked_in ? "disabled" : ""}>確認報到</button>`
    : `<form id="register-form"><label>餐盒需求<select name="meal_preference"><option>葷食</option><option>素食</option><option>不需餐盒</option></select></label><button>一鍵報名</button></form>`;
  if (reg) {
    $<HTMLInputElement>("#checkin-url").value = new URLSearchParams(
      location.search,
    ).has("checkin")
      ? location.href
      : "";
    $("#scan-self").onclick = () =>
      run(() =>
        scanQR((value) => {
          $<HTMLInputElement>("#checkin-url").value = value;
        }),
      );
  }
  if (!reg)
    $("#register-form").onsubmit = (e) => {
      e.preventDefault();
      run(async () => {
        const f = new FormData(e.target as HTMLFormElement);
        await send("register", {
          session_id: s.id,
          meal_preference: f.get("meal_preference"),
        });
        toast("報名成功，現場見！");
        await registration();
      });
    };
  else
    $("#self-checkin").onclick = () =>
      run(async () => {
        const raw = $<HTMLInputElement>("#checkin-url").value;
        const link = new URL(raw);
        if (
          link.origin !== location.origin ||
          link.searchParams.get("checkin") !== s.id
        )
          throw Error("請使用目前活動的現場報到連結");
        await send("checkin", { session_id: s.id });
        toast("報到完成");
        await registration();
      });
}
function painView() {
  const list = pains.filter((p) =>
    (p.title + p.scenario + p.department).includes(search),
  );
  $("#view").innerHTML =
    heading(
      "SMALL PAINS, BIG POSSIBILITIES",
      "這個困擾，你也有嗎？",
      "記錄那些重複、耗時的小事。你的日常痛點，也許就是下一個改善的起點。",
    ) +
    `<div class="row"><input id="pain-search" class="search" placeholder="搜尋痛點或科別…" value="${esc(search)}"><button id="add-pain">＋ 痛點</button></div>${list.map((p) => `<article class="pain-item"${reportAttrs("pain_point", p.id, p.proposer_id)}><div class="row"><div><h3>${esc(p.title)}</h3><span class="muted">${esc(p.department || "跨職類")}</span></div><button data-pain-vote="${p.id}" class="text-button" aria-label="我也有這個困擾">＋ ${p.upvotes}</button></div><details><summary>內容</summary><p class="detail-summary">${esc(p.scenario)}</p><p class="sub">${esc(p.time_cost || "")}<br>${esc(p.ideal_outcome || "")}</p></details></article>`).join("") || '<div class="empty">目前沒有痛點</div>'}`;
  $("#add-pain").onclick = () => {
    if (requireMember()) painForm();
  };
  $<HTMLInputElement>("#pain-search").oninput = (e) => {
    search = (e.target as HTMLInputElement).value;
    painView();
    const input = $<HTMLInputElement>("#pain-search");
    input.focus();
    input.setSelectionRange(search.length, search.length);
  };
  document.querySelectorAll<HTMLElement>("[data-pain-vote]").forEach(
    (b) =>
      (b.onclick = () =>
        run(async () => {
          await send("vote", {
            target_type: "pain_point",
            target_id: b.dataset.painVote,
          });
          await load();
          painView();
        })),
  );
}
function formDialog(
  title: string,
  html: string,
  onSubmit: (f: FormData) => Promise<void>,
) {
  const d = $<HTMLDialogElement>("#detail");
  d.innerHTML = `<div class="row"><h2>${title}</h2><button id="dismiss" class="ghost" type="button">關閉 ×</button></div><form id="modal-form">${html}<div class="actions"><button type="submit" id="modal-submit">儲存</button></div></form>`;
  d.showModal();
  $("#dismiss").onclick = () => d.close();
  $("#modal-form").onsubmit = (e) => {
    e.preventDefault();
    const form = e.target as HTMLFormElement;
    run(async () => {
      const button = $<HTMLButtonElement>("#modal-submit");
      button.disabled = true;
      try {
        await onSubmit(new FormData(form));
        d.close();
      } finally {
        button.disabled = false;
      }
    });
  };
}
function field(
  label: string,
  name: string,
  value = "",
  type = "text",
  required = true,
) {
  return `<label>${label}<input name="${name}" type="${type}" value="${esc(value)}" ${required ? "required" : ""} maxlength="300"></label>`;
}
function area(label: string, name: string, value = "", required = true) {
  return `<label>${label}<textarea name="${name}" ${required ? "required" : ""} maxlength="12000">${esc(value)}</textarea></label>`;
}
function painForm() {
  formDialog(
    "留下一個日常痛點",
    field("一句話描述痛點", "title") +
      field("科別／部門", "department", profile.department) +
      area("發生場景（請勿填寫病患資訊）", "scenario") +
      field("目前每次耗時", "time_cost", "", "text", false) +
      area("期待的改善方向", "ideal_outcome", "", false),
    async (f) => {
      await send("pain", Object.fromEntries(f));
      await load();
      painView();
      toast("已留下您的痛點");
    },
  );
}
async function workspace() {
  if (demo) {
    $("#view").innerHTML =
      heading(
        "YOUR AGENT CONNECTION",
        "讓你的 Agent，也能加入交流。",
        "從自己的工具發布專案、閱讀討論，並以本人的身分回覆與聯絡。",
      ) +
      `<details class="workspace-section"><summary>Agent API</summary><p class="sub">支援發布專案、閱讀討論與站內聯絡。正式網站登入後可產生個人 Token；私訊權限需另外開放。</p><p class="muted">預覽不產生正式 Token。</p></details>`;
    return;
  }
  if (!profile?.passcode_verified) {
    $("#view").innerHTML = heading(
      "YOUR PRIVATE WORKSPACE",
      "讓靈感，慢慢長成一場分享。",
      "登入並完成通關驗證，即可擁有自己的私人草稿與個人 Agent Token。",
    );
    return;
  }
  [mySpaces, tokens] = await Promise.all([
    read(
      client!
        .from("spaces")
        .select(LIST)
        .eq("owner_id", user.id)
        .order("created_at", { ascending: false }),
    ),
    read(
      client!
        .from("user_api_tokens")
        .select("id,token_prefix,created_at,last_used_at,scopes")
        .eq("user_id", user.id),
    ),
  ]);
  $("#view").innerHTML =
    heading(
      "YOUR PRIVATE WORKSPACE",
      "自己的小實驗，自己掌舵。",
      "私人草稿只有你能讀取。準備好了，再分享給全院同仁。",
    ) +
    `<div class="row"><h2 class="sr-only">我的展示</h2><button id="new-draft">＋ 新增專案</button></div>${mySpaces.map((s) => `<div class="panel row"><div><span class="badge">${s.visibility === "private" ? "🔒 私人草稿" : "🌐 全院公開"}</span><h3>${esc(s.title)}</h3><span class="muted">${s.slide_count} 張投影片</span></div><div class="actions"><button class="ghost" data-preview="${s.id}">預覽</button><button class="secondary" data-edit="${s.id}">編輯</button></div></div>`).join("") || '<div class="empty">還沒有草稿。從一個大綱開始吧。</div>'}<details class="workspace-section"><summary>個人資料</summary><form id="profile-form">${field("顯示名稱", "display_name", profile.display_name)}${field("科別／部門", "department", profile.department)}<button>更新資料</button></form></details><details class="workspace-section"><summary>Agent API</summary><div class="row"><h2 class="sr-only">個人 Agent API Token</h2><button id="new-token" class="secondary">產生 Token</button></div><p class="sub">Token 僅顯示一次，請妥善保存。</p><label class="check"><input id="token-messages" type="checkbox">允許此 Token 讀取及傳送我的站內私訊（選用）</label><p class="sub">私訊權限需另行開放。</p><div id="token-once"></div>${tokens.map((t) => `<div class="list-item row"><code>${esc(t.token_prefix)}…</code><span class="badge">${t.scopes?.includes("messages:read") ? "含站內私訊" : "專案與討論"}</span><span class="muted">${esc(t.last_used_at?.slice(0, 10) ?? "尚未使用")}</span><button class="danger" data-revoke="${t.id}">撤銷</button></div>`).join("")}<details><summary>Agent 連線設定</summary><pre>${esc(JSON.stringify({ mcpServers: { "ntucc-meetup-spaces": { url: location.origin + "/api/mcp", transport: "streamable-http", headers: { Authorization: "Bearer ${NTUCC_PERSONAL_TOKEN}" } } } }, null, 2))}</pre></details><details><summary>REST API 與 Agent 能做什麼？</summary><p class="sub">GET /api/v1/agent/projects：瀏覽專案<br>GET /api/v1/agent/projects/{id}/discussions：查看討論<br>POST /api/v1/agent/discussions/{id}/replies：回覆討論<br>GET /api/v1/agent/inbox：讀取自己的私訊<br>POST /api/v1/agent/messages：站內聯絡同仁（需私訊權限）</p><p class="sub">每個請求皆使用 Authorization: Bearer 您的個人Token。MCP 同步提供 list_projects、read_discussion、reply_to_discussion、send_private_message 等工具。</p></details></details>`;
  $("#new-draft").onclick = () => editSpace();
  document
    .querySelectorAll<HTMLElement>("[data-preview]")
    .forEach(
      (b) => (b.onclick = () => run(() => openSpace(b.dataset.preview!))),
    );
  document
    .querySelectorAll<HTMLElement>("[data-edit]")
    .forEach(
      (b) =>
        (b.onclick = () =>
          editSpace(mySpaces.find((s) => s.id === b.dataset.edit))),
    );
  $("#profile-form").onsubmit = (e) => {
    e.preventDefault();
    run(async () => {
      await send(
        "profile",
        Object.fromEntries(new FormData(e.target as HTMLFormElement)),
      );
      await refreshProfile();
      toast("資料已更新");
    });
  };
  $("#new-token").onclick = () =>
    run(async () => {
      const { token } = await send("token_create", {
        include_messages: $<HTMLInputElement>("#token-messages").checked,
      });
      $("#token-once").innerHTML =
        `<p class="sub">請現在複製，離開後將無法再次查看。</p><div class="token-once">${esc(token)}</div><button id="hide-token" class="ghost">已保存，隱藏 Token</button>`;
      $("#hide-token").onclick = () => void run(workspace);
    });
  document.querySelectorAll<HTMLElement>("[data-revoke]").forEach(
    (b) =>
      (b.onclick = () =>
        run(async () => {
          await send("token_revoke", { id: b.dataset.revoke });
          await workspace();
          toast("Token 已撤銷");
        })),
  );
}
function editSpace(s: any = {}) {
  formDialog(
    s.id ? "編輯我的展示" : "從一個小實驗開始",
    field("展示標題", "title", s.title) +
      `<label>分享類型<select name="category_tag"><option ${s.category_tag === "實戰展示" ? "selected" : ""}>實戰展示</option><option ${s.category_tag === "踩坑避雷" ? "selected" : ""}>踩坑避雷</option></select></label>` +
      area("摘要", "summary", s.summary) +
      field(
        "重點標籤（以逗號分隔）",
        "highlights",
        (s.highlights ?? []).join(","),
        "text",
        false,
      ) +
      `<label>發布狀態<select name="visibility"><option value="private" ${s.visibility !== "public" ? "selected" : ""}>🔒 私人草稿</option><option value="public" ${s.visibility === "public" ? "selected" : ""}>🌐 全院公開</option></select></label><label>專案封面（JPG／PNG／WebP，請勿包含病患資料）<input id="cover-upload" type="file" accept="image/jpeg,image/png,image/webp"></label><p id="cover-state" class="sub">${s.has_cover || s.cover_image ? "已設定專案封面；未選新圖會保留。" : "未上傳時使用示意封面。"}</p><button id="clear-cover" type="button" class="ghost">移除自訂封面</button><label>上傳自包含 HTML（10–15 張）<input id="html-upload" type="file" accept=".html,text/html"></label><p id="upload-state" class="sub">${s.slide_count ? `已儲存 ${s.slide_count} 張；未上傳新檔會保留原檔。` : "尚未上傳投影片。"}</p><details><summary>用 AI 從大綱生成投影片</summary>${area("7 分鐘分享大綱", "outline", "", false)}<button id="generate" type="button" class="secondary">✳ 生成 10–15 張 HTML 投影片</button></details><label>參考連結（每行：分類 | 標題 | https://網址）<textarea name="links" placeholder="開源專案 | 專案名稱 | https://github.com/...">${esc((s.reference_links ?? []).map((l: any) => `${l.label} | ${l.title} | ${l.url}`).join("\n"))}</textarea></label><p class="sub">允許分類：工具官網、Prompt 範本、開源專案、臨床指引。儲存前會執行個資檢查。</p>`,
    async (f) => {
      const links = String(f.get("links"))
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => {
          const [label, title, url] = l.split("|").map((v) => v.trim());
          if (!label || !title || !url || new URL(url).protocol !== "https:")
            throw Error("請確認參考連結格式，僅接受 HTTPS");
          return { label, title, url };
        });
      const payload: any = {
        title: f.get("title"),
        summary: f.get("summary"),
        category_tag: f.get("category_tag"),
        visibility: f.get("visibility"),
        highlights: String(f.get("highlights"))
          .split(/[,，]/)
          .map((v) => v.trim())
          .filter(Boolean),
        reference_links: links,
      };
      if (coverImage !== undefined) payload.cover_image = coverImage;
      if (s.id) payload.id = s.id;
      if (uploadedHTML !== undefined) payload.html_slides = uploadedHTML;
      await send("upsert", payload);
      await load();
      page = "workspace";
      render();
      toast("展示已儲存");
    },
  );
  let uploadedHTML: string | undefined;
  let coverImage: string | null | undefined;
  $("#clear-cover").onclick = () => {
    coverImage = null;
    $("#cover-state").textContent = "儲存後將恢復示意封面。";
  };
  $<HTMLInputElement>("#cover-upload").onchange = (ev) =>
    void run(async () => {
      const file = (ev.target as HTMLInputElement).files?.[0];
      if (!file) return;
      if (
        !["image/jpeg", "image/png", "image/webp"].includes(file.type) ||
        file.size > 10000000
      )
        throw Error("請選擇 10 MB 以內的 JPG、PNG 或 WebP");
      const bitmap = await createImageBitmap(file);
      try {
        const canvas = document.createElement("canvas");
        const scale = Math.min(1, 960 / bitmap.width, 640 / bitmap.height);
        canvas.width = Math.round(bitmap.width * scale);
        canvas.height = Math.round(bitmap.height * scale);
        const ctx = canvas.getContext("2d")!;
        ctx.fillStyle = "#f5f6f2";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        let result = "";
        for (const quality of [0.8, 0.6, 0.4]) {
          result = canvas.toDataURL("image/jpeg", quality);
          if (result.length <= 220000) break;
        }
        if (result.length > 220000)
          throw Error("圖片仍太大，請改用較簡單的畫面截圖");
        coverImage = result;
        $("#cover-state").textContent =
          "封面已在本機載入，儲存後更新。圖片內容需由您確認不含個資。";
      } finally {
        bitmap.close();
      }
    });

  $<HTMLInputElement>("#html-upload").onchange = (e) =>
    run(async () => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      if (file.size > 1_500_000) throw Error("檔案請小於 1.5 MB");
      const html = await file.text();
      const count = new DOMParser()
        .parseFromString(html, "text/html")
        .querySelectorAll("section.slide,[data-slide]").length;
      if (count < 10 || count > 15) {
        (e.target as HTMLInputElement).value = "";
        throw Error(`目前 ${count} 張，請調整為 10–15 張`);
      }
      uploadedHTML = html;
      $("#upload-state").textContent =
        `已在本機載入 ${count} 張，儲存前會執行 PII 檢查。`;
    });
  $("#generate").onclick = () =>
    run(async () => {
      const button = $<HTMLButtonElement>("#generate");
      const outline = ($("[name=outline]") as HTMLTextAreaElement).value;
      const reviewed = await review({ outline });
      if (!reviewed) return;
      button.disabled = true;
      try {
        const session = (await client!.auth.getSession()).data.session;
        const r = await fetch("/api/chat", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer " + session?.access_token,
          },
          body: JSON.stringify({
            ...reviewed.payload,
            force_override: reviewed.force_override,
          }),
        });
        const data = await r.json();
        if (!r.ok) throw Error(data.code);
        uploadedHTML = data.html_slides;
        $("#upload-state").textContent =
          `AI 已生成 ${data.slide_count} 張。請儲存為草稿並檢視內容後，再設為公開。`;
      } finally {
        button.disabled = false;
      }
    });
}
function mountAdminExtras() {
  const view = $("#view");
  const flagsPanel = document.createElement("div");
  flagsPanel.className = "panel";
  flagsPanel.id = "feature-flags-panel";
  const flags = allFlags();
  const fmt = (t: string | null) =>
    t ? new Date(t).toLocaleString("zh-TW", { hour12: false }) : "—";
  flagsPanel.innerHTML = `<h2>功能開關</h2><p class="sub">新功能預設關閉；關閉不會刪除資料，重新開啟後即恢復。</p>${
    isDemoFlags()
      ? '<p class="sub">預覽模式：所有功能皆視為開啟（僅供示範）。</p>'
      : flags.length
        ? flags
            .map(
              (f) =>
                `<div class="list-item row"><span><b>${esc(f.label)}</b> <small class="muted">${esc(f.key)}</small><br><span class="sub">${esc(f.description)} · 更新於 ${esc(fmt(f.updated_at))}</span></span><label class="check"><input type="checkbox" data-flag="${esc(f.key)}" ${f.enabled ? "checked" : ""} aria-label="${esc(f.label)}">${f.enabled ? "已開啟" : "已關閉"}</label></div>`,
            )
            .join("")
        : '<p class="empty">尚無功能開關資料（請確認已執行 migration 013）</p>'
  }`;
  view.append(flagsPanel);
  flagsPanel.querySelectorAll<HTMLInputElement>("[data-flag]").forEach(
    (box) =>
      (box.onchange = () => {
        box.disabled = true;
        void run(async () => {
          try {
            const { error } = await client!.rpc("set_feature_flag", {
              p_key: box.dataset.flag,
              p_enabled: box.checked,
            });
            if (error) throw Error(error.message);
            await loadFeatureFlags(client);
            toast("功能開關已更新");
            render();
          } catch (e) {
            box.checked = !box.checked;
            box.disabled = false;
            throw e;
          }
        });
      }),
  );
  for (const panel of featureAdminPanels()) {
    const holder = document.createElement("div");
    holder.className = "panel";
    holder.id = `admin-panel-${panel.id}`;
    holder.innerHTML = `<h2>${esc(panel.label)}</h2><div class="admin-panel-body"></div>`;
    view.append(holder);
    void run(() =>
      Promise.resolve(
        panel.render(
          holder.querySelector<HTMLElement>(".admin-panel-body")!,
          featureCtx(),
        ),
      ),
    );
  }
}
async function adminView() {
  if (profile?.role !== "admin") {
    page = "stage";
    render();
    return;
  }
  $("#view").innerHTML =
    heading(
      "COMMUNITY OPERATIONS",
      "把相聚的細節，準備好。",
      "管理活動、公告、展示順序與現場報到。管理員無法讀取同仁的私人草稿。",
    ) +
    `<div class="actions"><button id="new-session">建立活動場次</button><button id="new-announcement" class="secondary">發布公告</button><button id="manage-members" class="ghost">成員</button></div><div class="panel"><h2>本期報名與餐盒統計</h2><div id="registration-report">${activeSession ? "讀取中…" : "請先建立活動場次。"}</div></div><div class="panel"><h2>10 分鐘議程順序</h2><p class="sub">每個時段含 7 分鐘演示與 3 分鐘 Q&A。順序從 0 起算。</p>${spaces.map((s) => `<div class="list-item row"><span>${esc(s.title)}</span><form data-schedule="${s.id}" class="row"><input name="slot_order" type="number" min="0" max="100" value="${s.slot_order ?? 0}" aria-label="議程順序" style="width:75px"><button class="secondary">排入本期</button></form></div>`).join("")}</div>`;
  mountAdminExtras();
  $("#manage-members").onclick = () => {
    page = "members";
    history.pushState(null, "", "#members");
    render();
  };
  $("#new-session").onclick = () =>
    formDialog(
      "建立新場次",
      field("活動名稱", "title") +
        field("日期", "session_date", "", "date") +
        field("開始時間", "start_time", "", "time") +
        field("地點", "location"),

      async (f) => {
        await send("session", Object.fromEntries(f));
        await load();
        await adminView();
      },
    );
  $("#new-announcement").onclick = () =>
    formDialog(
      "發布公告",
      field("標題", "title") +
        area("公告內容", "content") +
        '<label class="check"><input name="is_pinned" type="checkbox">置頂</label>',
      async (f) => {
        await send("announcement", {
          title: f.get("title"),
          category: "活動公告",
          content: f.get("content"),
          is_pinned: f.get("is_pinned") === "on",
        });
        await load();
        toast("公告已發布");
      },
    );
  document.querySelectorAll<HTMLFormElement>("[data-schedule]").forEach(
    (form) =>
      (form.onsubmit = (e) => {
        e.preventDefault();
        run(async () => {
          if (!activeSession) throw Error("請先建立場次");
          await send("schedule", {
            id: form.dataset.schedule,
            session_id: activeSession.id,
            slot_order: Number(new FormData(form).get("slot_order")),
          });
          await load();
          toast("議程已更新");
        });
      }),
  );
  if (!activeSession) return;
  const rows = await send("registrations", { session_id: activeSession.id });
  const meals = ["葷食", "素食", "不需餐盒"]
    .map(
      (m) => `${m} ${rows.filter((r: any) => r.meal_preference === m).length}`,
    )
    .join(" · ");
  $("#registration-report").innerHTML =
    `<p>應到 <b>${rows.length}</b> 位 · 實到 <b>${rows.filter((r: any) => r.checked_in).length}</b> 位</p><p class="sub">${meals}</p><div class="actions"><button id="export" class="secondary">匯出 CSV</button><button id="refresh-report" class="ghost">更新統計</button></div><p class="sub">現場報到 QR Code 可編碼此連結（僅供活動現場使用）：</p><pre>${esc(location.origin + "/?checkin=" + activeSession.id + "#registration")}</pre><label>員工識別證 QR Code 內容（使用者 UUID）<input id="badge-uuid" placeholder="掃描後貼入員工對應 UUID"></label><div class="actions"><button id="scan-badge" class="secondary">相機掃描識別證</button><button id="badge-checkin" class="secondary">識別證報到</button></div><table><thead><tr><th>同仁</th><th>科別</th><th>餐盒</th><th>報到</th></tr></thead><tbody>${rows.map((r: any) => `<tr><td>${esc(r.profiles?.display_name)}</td><td>${esc(r.profiles?.department)}</td><td>${esc(r.meal_preference)}</td><td>${r.checked_in ? "✅ 已報到" : `<button class="secondary" data-checkin="${r.user_id}">報到</button>`}</td></tr>`).join("")}</tbody></table>`;
  $("#refresh-report").onclick = () => run(adminView);
  $("#scan-badge").onclick = () =>
    run(() =>
      scanQR((value) => {
        $<HTMLInputElement>("#badge-uuid").value = value;
      }),
    );
  $("#badge-checkin").onclick = () =>
    run(async () => {
      await send("checkin", {
        session_id: activeSession.id,
        user_id: $<HTMLInputElement>("#badge-uuid").value.trim(),
      });
      await adminView();
    });
  document.querySelectorAll<HTMLElement>("[data-checkin]").forEach(
    (b) =>
      (b.onclick = () =>
        run(async () => {
          await send("checkin", {
            session_id: activeSession.id,
            user_id: b.dataset.checkin,
          });
          await adminView();
        })),
  );
  $("#export").onclick = () => {
    const cell = (v: any) =>
      '"' +
      String(v ?? "")
        .replace(/^[\s]*[=+@-]/, "'$&")
        .replace(/"/g, '""') +
      '"';
    const csv =
      "\uFEFF" +
      [
        ["姓名", "科別", "餐盒", "報到"],
        ...rows.map((r: any) => [
          r.profiles?.display_name,
          r.profiles?.department,
          r.meal_preference,
          r.checked_in ? "已報到" : "未報到",
        ]),
      ]
        .map((r) => r.map(cell).join(","))
        .join("\r\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(
      new Blob([csv], { type: "text/csv;charset=utf-8" }),
    );
    a.download = "ntucc-registrations.csv";
    a.click();
    URL.revokeObjectURL(a.href);
  };
}
async function refreshProfile() {
  if (!user) return;
  const { data, error } = await client!
    .from("profiles")
    .select("id,display_name,department,role,passcode_verified")
    .eq("id", user.id)
    .single();
  if (error) throw error;
  profile = data;
}
async function init() {
  try {
    page = "announcements";
    if (client) {
      user = (await client.auth.getSession()).data.session?.user ?? null;
      if (user) await refreshProfile();
    }
    if (profile?.passcode_verified) await load();
    const link = location.hash.match(
      /^#project\/([0-9a-f-]{36})(?:\/thread\/([0-9a-f-]{36}))?$/i,
    );
    const pending = sessionStorage
      .getItem("ntucc-project-link")
      ?.match(/^#project\/([0-9a-f-]{36})(?:\/thread\/([0-9a-f-]{36}))?$/i);
    const target = link ?? pending;
    if (target && profile?.passcode_verified) {
      sessionStorage.removeItem("ntucc-project-link");
      await openSpace(target[1], target[2], !link);
    } else {
      if (link) sessionStorage.setItem("ntucc-project-link", link[0]);
      render();
    }
    if (client && profile?.passcode_verified) {
      client
        .channel("registration-updates")
        .on(
          "postgres_changes",
          { event: "*", schema: "public", table: "registrations" },
          () => {
            if (page === "admin") void run(adminView);
            if (page === "registration") void run(registration);
          },
        )
        .subscribe();
    }
  } catch (e) {
    $("#app").innerHTML =
      `<div class="content"><h1>NTUCC Meetup Spaces</h1><div class="panel error">暫時無法載入資料，請確認 Supabase migration、環境變數與網路設定。</div><button id="retry">重新載入</button></div>`;
    $("#retry").onclick = () => location.reload();
    console.error(e);
  }
}
client?.auth.onAuthStateChange((event) => {
  if (event === "SIGNED_OUT" && !isPublicRoute()) {
    user = null;
    profile = null;
    spaces = [];
    announcements = [];
    pains = [];
    mySpaces = [];
    tokens = [];
    currentSpace = null;
    document
      .querySelectorAll<HTMLDialogElement>("dialog[open]")
      .forEach((d) => d.close());
    render();
  }
});
window.addEventListener("popstate", () => {
  if (isPublicRoute()) return;
  const link = location.hash.match(/^#project\/([^/]+)(?:\/thread\/([^/]+))?$/);
  if (link && (profile?.passcode_verified || demoEntered))
    void run(() =>
      openSpace(
        decodeURIComponent(link[1]),
        link[2] ? decodeURIComponent(link[2]) : undefined,
        false,
      ),
    );
  else if (profile?.passcode_verified || demoEntered) {
    page =
      navs.some((n) => n[0] === location.hash.slice(1)) ||
      featureNavs().some((n) => n.id === location.hash.slice(1))
        ? location.hash.slice(1)
        : "announcements";
    render();
  }
});
if (isPublicRoute()) mountPublicEvents(client);
else {
  window.addEventListener("hashchange", () => {
    if (isPublicRoute()) location.reload();
  });
  void init();
}

async function speakerCheckin(s: any) {
  const own = await read(
    client!
      .from("spaces")
      .select("id")
      .eq("owner_id", user.id)
      .eq("session_id", s.id)
      .eq("visibility", "public")
      .not("slot_order", "is", null),
  );
  if (!own.length && profile.role !== "admin") return;
  const rows = await send("registrations", { session_id: s.id });
  if (!$("#speaker-checkin")) return;
  $("#speaker-checkin").innerHTML =
    `<div class="panel"><h2>講者／工作人員現場報到</h2><p class="sub">應到 ${rows.length} 位 · 實到 ${rows.filter((r: any) => r.checked_in).length} 位</p>${rows.map((r: any) => `<div class="list-item row"><span>${esc(r.profiles?.display_name)} · ${esc(r.meal_preference)}</span><button class="secondary" data-speaker-checkin="${r.user_id}" ${r.checked_in ? "disabled" : ""}>${r.checked_in ? "已報到" : "報到"}</button></div>`).join("")}</div>`;
  document.querySelectorAll<HTMLElement>("[data-speaker-checkin]").forEach(
    (b) =>
      (b.onclick = () =>
        run(async () => {
          await send("checkin", {
            session_id: s.id,
            user_id: b.dataset.speakerCheckin,
          });
          await speakerCheckin(s);
        })),
  );
}
async function scanQR(onResult: (value: string) => void) {
  const { BrowserQRCodeReader } = await import("@zxing/browser");
  const dialog = $<HTMLDialogElement>("#scanner");
  const reader = new BrowserQRCodeReader();
  dialog.showModal();
  let controls: { stop: () => void } | undefined;
  const close = () => {
    controls?.stop();
    $<HTMLVideoElement>("#scan-video").srcObject = null;
    dialog.close();
  };
  $("#scan-close").onclick = close;
  dialog.oncancel = (e) => {
    e.preventDefault();
    close();
  };
  try {
    controls = await reader.decodeFromVideoDevice(
      undefined,
      $<HTMLVideoElement>("#scan-video"),
      (result) => {
        if (result) {
          onResult(result.getText());
          close();
        }
      },
    );
  } catch (e) {
    close();
    throw Error("無法開啟相機，請允許相機權限，或改用貼上 QR Code 內容。");
  }
}
