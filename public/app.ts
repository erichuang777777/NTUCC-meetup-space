/// <reference types="vite/client" />
import { createClient } from "@supabase/supabase-js";
import { scanValue, maskValue } from "./pii";
import { sandboxDocument } from "./player";
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
  page = "stage",
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
const navs = [
  ["stage", "◈", "展示舞台"],
  ["announcements", "▤", "公布欄"],
  ["registration", "▦", "活動報名"],
  ["pain", "◇", "痛點許願池"],
  ["workspace", "▧", "我的工作空間"],
];
const LIST =
  "id,owner_id,title,category_tag,summary,highlights,slide_count,reference_links,votes,vibe_counts,slot_order,session_id,visibility,created_at";
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
async function load() {
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
        .select("id,title,session_date,start_time,location,credits")
        .eq("is_active", true),
    ),
  ]);
  [spaces, announcements, pains] = results;
  activeSession = results[3][0] ?? null;
}
function render() {
  const title = navs.find((n) => n[0] === page)?.[2] ?? "管理後台";
  $("#app").innerHTML =
    `<div class="shell"><aside class="sidebar"><a href="#stage" class="brand"><span class="brand-icon">✳</span><br>NTUCC<br>Meetup Spaces<small>CONNECT · SHARE · INSPIRE</small></a><nav class="nav">${navs.map(([id, icon, label]) => `<button data-nav="${id}" class="${page === id ? "active" : ""}"><span>${icon}</span>${label}</button>`).join("")}${profile?.role === "admin" ? `<button data-nav="admin" class="${page === "admin" ? "active" : ""}"><span>⚙</span>管理後台</button>` : ""}</nav><div class="sidebar-foot">一個小實驗，一次新連結。<br>臺大癌醫內部交流與 AI 展示空間<br><span>NTUCC · INTERNAL COMMUNITY</span></div></aside><main class="main"><header class="topbar"><div class="breadcrumb">Meetup Spaces　/　<b>${title}</b></div><div class="top-actions"><span class="muted">${profile ? esc(profile.display_name) : "訪客瀏覽"}</span><button id="auth" class="${user ? "secondary" : ""}">${user ? "登出" : "Google 登入　↗"}</button></div></header><div class="content">${demo ? '<div class="notice">介面預覽模式 · 以下展示為示例。完成 Supabase 與 Netlify 設定後即可使用真實資料。</div>' : ""}${user && !profile?.passcode_verified ? gate() : ""}<div id="view"></div><footer><span>NTUCC Meetup Spaces · 讓好的想法，在這裡相遇。</span><span>以分享連結彼此 ↗</span></footer></div></main></div>`;
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
  $("#auth").onclick = () =>
    run(async () => {
      if (!client) throw Error("請先設定 Supabase 環境變數");
      if (user) {
        await client.auth.signOut();
        location.reload();
      } else {
        const { error } = await client.auth.signInWithOAuth({
          provider: "google",
          options: { redirectTo: location.origin },
        });
        if (error) throw error;
      }
    });
  if (user && !profile?.passcode_verified)
    $("#passcode-form").onsubmit = (e) => {
      e.preventDefault();
      run(async () => {
        const input = $<HTMLInputElement>("#passcode");
        const { data, error } = await client!.rpc("verify_ntucc_passcode", {
          input_code: input.value,
        });
        input.value = "";
        if (error || !data) throw Error("密語不正確或嘗試過多，請稍後再試");
        await refreshProfile();
        render();
      });
    };
  switch (page) {
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
function gate() {
  return `<div class="panel"><h2>歡迎加入院內交流</h2><p class="sub">首次登入請輸入院內通關密語，開啟報名、分享與互動功能。</p><form id="passcode-form"><label>院內通關密語<input id="passcode" type="password" required autocomplete="off" maxlength="100"></label><button>驗證並加入</button></form></div>`;
}
async function run(fn: () => Promise<any>) {
  try {
    await fn();
  } catch (e) {
    toast(e instanceof Error ? e.message : "操作失敗");
  }
}
function heading(kicker: string, title: string, desc: string) {
  return `<div class="eyebrow">${kicker}</div><h1>${title}</h1><p class="sub">${desc}</p>`;
}
function stage() {
  const list = spaces.filter(
    (s) =>
      (filter === "全部" || s.category_tag === filter) &&
      (s.title + s.summary).toLowerCase().includes(search.toLowerCase()),
  );
  $("#view").innerHTML =
    heading(
      "THE 10-MINUTE SHOWCASE",
      "把日常的小突破，變成大家的靈感。",
      "不必等到完美才分享。10 分鐘，一起看看 AI 在醫療日常裡的更多可能。",
    ) +
    `<div class="hero"><div><span class="badge dark">${activeSession ? "NEXT MEETUP" : "A SPACE FOR EVERY SMALL IDEA"}</span><h2>${activeSession ? esc(activeSession.title) : "跨出第一步，就從分享開始。"}</h2><p class="sub">${activeSession ? `${esc(activeSession.session_date)} · ${esc(activeSession.start_time.slice(0, 5))} · ${esc(activeSession.location)}<br>${esc(activeSession.credits)}` : "7 分鐘實戰演示，3 分鐘交流問答。<br>成功的嘗試、踩過的坑，都能成為別人的起點。"}</p><div class="actions"><button id="create-space">分享我的小實驗　＋</button><button id="go-register" class="ghost">${activeSession ? "報名本次交流" : "查看活動資訊"}　↗</button></div></div><div class="hero-art">✳<small>SMALL IDEAS. REAL IMPACT.</small></div></div><div class="row section-head"><h2>探索同仁的實驗室 <span class="muted">${spaces.length} 個分享</span></h2><span class="muted">每個經驗，都有值得帶走的地方。</span></div><div class="row" style="margin-top:22px"><div class="tabs">${["全部", "實戰展示", "踩坑避雷"].map((t) => `<button data-filter="${t}" class="${filter === t ? "active" : ""}">${t === "實戰展示" ? "✨ " : t === "踩坑避雷" ? "💣 " : ""}${t}</button>`).join("")}</div><input id="space-search" class="search" placeholder="⌕　搜尋主題、關鍵字…" aria-label="搜尋展示" value="${esc(search)}"></div><div class="grid">${list.map(card).join("")}</div>${!list.length ? '<div class="empty">目前還沒有符合的展示。成為第一位分享者吧。</div>' : ""}<div class="notice">🔒 分享前，先照顧好個資。請使用合成或完整去識別化資料，避免病歷、姓名、床號與任何可辨識病患的資訊。</div>`;
  $("#create-space").onclick = () => {
    if (requireMember()) editSpace();
  };
  $("#go-register").onclick = () => {
    page = "registration";
    render();
  };
  document.querySelectorAll<HTMLElement>("[data-filter]").forEach(
    (b) =>
      (b.onclick = () => {
        filter = b.dataset.filter!;
        stage();
      }),
  );
  $<HTMLInputElement>("#space-search").oninput = (e) => {
    const pos = (e.target as HTMLInputElement).selectionStart;
    search = (e.target as HTMLInputElement).value;
    stage();
    const input = $<HTMLInputElement>("#space-search");
    input.focus();
    input.setSelectionRange(pos, pos);
  };
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
  const fail = s.category_tag === "踩坑避雷";
  return `<article class="card"><div class="preview ${fail ? "warm" : i % 3 === 2 ? "blue" : ""}"><span class="number">EXPERIMENT / ${String(i + 1).padStart(2, "0")}</span>${fail ? "TRIAL & LEARN" : "IDEA → IMPACT"}<small>NTUCC · ${s.slide_count || 0} SLIDES</small></div><div class="card-body"><div class="row"><span class="badge ${fail ? "orange" : ""}">${fail ? "💣" : "✨"} ${esc(s.category_tag)}</span><span class="muted">${slotLabel(s)}</span></div><h3>${esc(s.title)}</h3><p>${esc(s.summary)}</p><div class="actions">${(
    s.highlights ?? []
  )
    .slice(0, 3)
    .map((t: string) => `<span class="muted"># ${esc(t)}</span>`)
    .join(
      "",
    )}</div></div><div class="card-footer"><span>♡ ${s.votes} 位同仁感興趣</span><button data-open="${esc(s.id)}" class="secondary">進入空間 ↗</button></div></article>`;
}
async function openSpace(id: string) {
  currentSpace =
    spaces.find((s) => s.id === id) ?? mySpaces.find((s) => s.id === id);
  if (!currentSpace) throw Error("找不到展示");
  const s = currentSpace;
  const dialog = $<HTMLDialogElement>("#detail");
  dialog.innerHTML = `<div class="row"><span class="badge">${esc(s.category_tag)}</span><button id="close-detail" class="ghost">關閉 ×</button></div><h2>${esc(s.title)}</h2><p class="detail-summary">${esc(s.summary)}</p><div class="actions"><button id="project">▶ 全螢幕投影</button><button id="space-vote" class="secondary">♡ 我想聽 · ${s.votes}</button>${user?.id === s.owner_id ? '<button id="edit-current" class="ghost">編輯展示</button>' : ""}</div><h3>延伸資源與參考連結</h3>${(s.reference_links ?? []).map((l: any) => safeLink(l)).join("") || '<p class="sub">講者尚未提供延伸資源。</p>'}<div class="actions">${vibeButtons()}</div><h3>Slido 問答牆 <span class="qa-sort" id="qa-sort">高票優先 · 會前也能點菜</span></h3><div id="questions">讀取中…</div><form id="question-form"><label>想聽什麼實機細節？<textarea name="question_text" required maxlength="2000" placeholder="把你的好奇，留給講者。"></textarea></label><label class="check"><input name="is_anonymous" type="checkbox"> 匿名發問（系統保留帳號供權限驗證）</label><button>送出提問</button></form>`;
  dialog.showModal();
  $("#close-detail").onclick = () => dialog.close();
  $("#project").onclick = () => run(() => project(s));
  $("#space-vote").onclick = () =>
    run(async () => {
      await send("vote", { target_type: "space", target_id: s.id });
      toast("已記錄您的一票");
    });
  if ($("#edit-current"))
    $("#edit-current").onclick = () => {
      dialog.close();
      editSpace(s);
    };
  document
    .querySelectorAll<HTMLElement>("#detail [data-vibe]")
    .forEach((b) => (b.onclick = () => run(() => vibe(s.id, b.dataset.vibe!))));
  $("#question-form").onsubmit = (e) => {
    e.preventDefault();
    run(async () => {
      const f = new FormData(e.target as HTMLFormElement);
      await send("question", {
        space_id: s.id,
        question_text: f.get("question_text"),
        is_anonymous: f.get("is_anonymous") === "on",
      });
      (e.target as HTMLFormElement).reset();
      await loadQuestions(s);
    });
  };
  await loadQuestions(s);
  if (qaPoll) clearInterval(qaPoll);
  qaPoll = setInterval(() => {
    if (dialog.open) void run(() => loadQuestions(s));
  }, 10000);
  dialog.onclose = () => {
    if (qaPoll) clearInterval(qaPoll);
    qaPoll = null;
  };
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
          `<div class="list-item"><div class="row"><span class="muted">${esc(q.author_name)} ${q.is_resolved ? "· ✅ 已回答" : ""}</span><button class="secondary" data-qa-vote="${q.id}">↑ ${q.upvotes}</button></div><p>${esc(q.question_text)}</p>${q.speaker_reply ? `<p class="sub">講者：${esc(q.speaker_reply)}</p>` : ""}${s.owner_id === user?.id && !q.is_resolved ? `<button data-resolve="${q.id}" class="ghost">標記已回答</button>` : ""}</div>`,
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
    if (currentSpace && $("#detail").hasAttribute("open"))
      void loadQuestions(currentSpace);
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
  const cats = ["全部", "場地異動", "資安紅線", "教育學分", "活動公告"];
  $("#view").innerHTML =
    heading(
      "COMMUNITY NOTICEBOARD",
      "重要的事，在這裡知道。",
      "活動資訊、教育學分與資安提醒，一起掌握交流日常。",
    ) +
    `<div class="tabs">${cats.map((t) => `<button data-cat="${t}" class="${filter === t ? "active" : ""}">${t}</button>`).join("")}</div><div class="panel">${
      announcements
        .filter((a) => filter === "全部" || a.category === filter)
        .map(
          (a) =>
            `<article class="list-item"><span class="badge">${esc(a.category)}</span> <span class="muted">${a.is_pinned ? "📌 置頂" : ""}</span><h3>${esc(a.title)}</h3><p class="detail-summary">${esc(a.content)}</p>${profile?.role === "admin" ? `<button class="ghost" data-pin="${a.id}" data-value="${!a.is_pinned}">${a.is_pinned ? "取消置頂" : "置頂"}</button>` : ""}</article>`,
        )
        .join("") || '<p class="sub">目前沒有公告。</p>'
    }</div>`;
  document.querySelectorAll<HTMLElement>("[data-cat]").forEach(
    (b) =>
      (b.onclick = () => {
        filter = b.dataset.cat!;
        announcementView();
      }),
  );
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
      "留一個午休，給新的可能。",
      "一起吃飯、聊聊實驗，也把彼此的經驗帶回工作現場。",
    ) +
    (!s
      ? '<div class="empty">新的 Meetup 正在準備中，請留意公布欄。</div>'
      : `<div class="two"><section class="panel"><span class="badge">本期 Meetup</span><h2>${esc(s.title)}</h2><p>▦ ${esc(s.session_date)}　${esc(s.start_time.slice(0, 5))}<br>⌖ ${esc(s.location)}</p><p class="sub">${esc(s.credits)}</p><p class="sub">餐盒將依報名需求準備，請於活動現場完成報到後領取。</p></section><section class="panel"><h2>報名與報到</h2><div id="registration-state"></div></section></div><div id="speaker-checkin"></div>`);
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
    `<div class="row"><input id="pain-search" class="search" placeholder="搜尋痛點或科別…" value="${esc(search)}"><button id="add-pain">＋ 留下一個痛點</button></div>${list.map((p) => `<article class="panel"><div class="row"><span class="badge">${esc(p.department || "跨職類")}</span><button data-pain-vote="${p.id}" class="secondary">＋1 我也有 · ${p.upvotes}</button></div><h3>${esc(p.title)}</h3><p class="detail-summary">${esc(p.scenario)}</p><p class="sub">目前耗時：${esc(p.time_cost || "未填寫")}<br>期待改善：${esc(p.ideal_outcome || "一起想想看")}</p></article>`).join("") || '<div class="empty">還沒有符合的痛點。留下一個讓你困擾的小事吧。</div>'}`;
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
        .select("id,token_prefix,created_at,last_used_at")
        .eq("user_id", user.id),
    ),
  ]);
  $("#view").innerHTML =
    heading(
      "YOUR PRIVATE WORKSPACE",
      "自己的小實驗，自己掌舵。",
      "私人草稿只有你能讀取。準備好了，再分享給全院同仁。",
    ) +
    `<div class="row"><h2>我的展示</h2><button id="new-draft">＋ 新增展示</button></div>${mySpaces.map((s) => `<div class="panel row"><div><span class="badge">${s.visibility === "private" ? "🔒 私人草稿" : "🌐 全院公開"}</span><h3>${esc(s.title)}</h3><span class="muted">${s.slide_count} 張投影片</span></div><div class="actions"><button class="ghost" data-preview="${s.id}">預覽</button><button class="secondary" data-edit="${s.id}">編輯</button></div></div>`).join("") || '<div class="empty">還沒有草稿。從一個大綱開始吧。</div>'}<div class="panel"><h2>個人資料</h2><form id="profile-form">${field("顯示名稱", "display_name", profile.display_name)}${field("科別／部門", "department", profile.department)}<button>更新資料</button></form></div><div class="panel"><div class="row"><h2>個人 Agent API Token</h2><button id="new-token" class="secondary">產生 Token</button></div><p class="sub">供 Claude Code、Cursor 等 Agent 使用。Token 僅建立當下顯示一次，請妥善保存。</p><div id="token-once"></div>${tokens.map((t) => `<div class="list-item row"><code>${esc(t.token_prefix)}…</code><span class="muted">${esc(t.last_used_at?.slice(0, 10) ?? "尚未使用")}</span><button class="danger" data-revoke="${t.id}">撤銷</button></div>`).join("")}<details><summary>Agent 連線設定</summary><pre>${esc(JSON.stringify({ mcpServers: { "ntucc-meetup-spaces": { url: location.origin + "/api/mcp", transport: "streamable-http", headers: { Authorization: "Bearer ${NTUCC_PERSONAL_TOKEN}" } } } }, null, 2))}</pre></details></div>`;
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
      const { token } = await send("token_create");
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
      `<label>發布狀態<select name="visibility"><option value="private" ${s.visibility !== "public" ? "selected" : ""}>🔒 私人草稿</option><option value="public" ${s.visibility === "public" ? "selected" : ""}>🌐 全院公開</option></select></label><label>上傳自包含 HTML（10–15 張）<input id="html-upload" type="file" accept=".html,text/html"></label><p id="upload-state" class="sub">${s.slide_count ? `已儲存 ${s.slide_count} 張；未上傳新檔會保留原檔。` : "尚未上傳投影片。"}</p><details><summary>用 AI 從大綱生成投影片</summary>${area("7 分鐘分享大綱", "outline", "", false)}<button id="generate" type="button" class="secondary">✳ 生成 10–15 張 HTML 投影片</button></details><label>參考連結（每行：分類 | 標題 | https://網址）<textarea name="links" placeholder="開源專案 | 專案名稱 | https://github.com/...">${esc((s.reference_links ?? []).map((l: any) => `${l.label} | ${l.title} | ${l.url}`).join("\n"))}</textarea></label><p class="sub">允許分類：工具官網、Prompt 範本、開源專案、臨床指引。儲存前會執行個資檢查。</p>`,
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
    `<div class="actions"><button id="new-session">建立活動場次</button><button id="new-announcement" class="secondary">發布公告</button></div><div class="panel"><h2>本期報名與餐盒統計</h2><div id="registration-report">${activeSession ? "讀取中…" : "請先建立活動場次。"}</div></div><div class="panel"><h2>10 分鐘議程順序</h2><p class="sub">每個時段含 7 分鐘演示與 3 分鐘 Q&A。順序從 0 起算。</p>${spaces.map((s) => `<div class="list-item row"><span>${esc(s.title)}</span><form data-schedule="${s.id}" class="row"><input name="slot_order" type="number" min="0" max="100" value="${s.slot_order ?? 0}" aria-label="議程順序" style="width:75px"><button class="secondary">排入本期</button></form></div>`).join("")}</div>`;
  $("#new-session").onclick = () =>
    formDialog(
      "建立新場次",
      field("活動名稱", "title") +
        field("日期", "session_date", "", "date") +
        field("開始時間", "start_time", "12:30", "time") +
        field("地點", "location") +
        field("教育學分資訊", "credits", "", "text", false),
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
        `<label>分類<select name="category"><option>活動公告</option><option>場地異動</option><option>資安紅線</option><option>教育學分</option></select></label>` +
        area("公告內容", "content") +
        '<label class="check"><input name="is_pinned" type="checkbox">置頂</label>',
      async (f) => {
        await send("announcement", {
          title: f.get("title"),
          category: f.get("category"),
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
    page = location.hash.slice(1) || "stage";
    if (client) {
      user = (await client.auth.getSession()).data.session?.user ?? null;
      if (user) await refreshProfile();
    }
    await load();
    render();
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
void init();

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
