import { registerFeature, type FeatureCtx } from "../feature-registry";
import {
  barChartSvg,
  defaultRange,
  departmentRows,
  lineChartSvg,
  num,
  overviewRows,
  pct,
  seriesRows,
  toCsv,
  topRows,
  type Cell,
} from "./admin_dashboard_lib";
import "./admin_dashboard.css";

const ERRORS: Record<string, string> = {
  FEATURE_DISABLED: "營運儀表板目前未開啟",
  ADMIN_REQUIRED: "僅管理員可檢視",
  INVALID_RANGE: "日期範圍無效（起日須早於迄日，且最長 2 年）",
  INVALID_METRIC: "不支援的指標",
  INVALID_BUCKET: "不支援的區間",
};
const friendly = (m: string) =>
  ERRORS[Object.keys(ERRORS).find((k) => m.includes(k)) ?? ""] ?? m;

const METRICS: Record<string, string> = {
  registrations: "報名數",
  checkins: "報到數",
  threads: "新討論串",
  members: "新增同仁",
};

function download(name: string, rows: Cell[][]) {
  const url = URL.createObjectURL(
    new Blob([toCsv(rows)], { type: "text/csv;charset=utf-8" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function renderAdmin(box: HTMLElement, ctx: FeatureCtx) {
  const e = ctx.esc;
  const range = defaultRange();
  let metric = "registrations",
    bucket = "week",
    showTable = false;
  let state: { o: any; d: any[]; t: any; s: any } | null = null;
  let error = "";

  const rpc = async (fn: string, args: Record<string, unknown>) => {
    if (!ctx.client) throw new Error("示範模式不支援");
    const { data, error: err } = await ctx.client.rpc(fn, args);
    if (err) throw new Error(friendly(err.message));
    return data;
  };
  async function load() {
    error = "";
    const a = { p_from: range.from, p_to: range.to };
    try {
      const [o, d, t, s] = await Promise.all([
        rpc("dashboard_overview", a),
        rpc("dashboard_department_participation", a),
        rpc("dashboard_top_content", { ...a, p_limit: 10 }),
        rpc("dashboard_timeseries", {
          p_metric: metric,
          ...a,
          p_bucket: bucket,
        }),
      ]);
      state = { o, d, t, s };
    } catch (err) {
      state = null;
      error = err instanceof Error ? err.message : "載入失敗";
    }
    draw();
  }
  const tile = (label: string, v: string) =>
    `<div class="dash-tile"><b>${e(v)}</b><span>${e(label)}</span></div>`;
  const csvBtn = (id: string) =>
    `<button type="button" class="ghost" data-csv="${id}">匯出 CSV</button>`;

  function draw() {
    const head = `<h3>營運儀表板</h3><p class="hint">僅顯示彙總數字，不含個人層級資料；人數少於 5 的科別合併顯示。</p>
<form class="dash-range" id="dash-range"><label>起日<input type="date" name="from" value="${e(range.from)}" required></label>
<label>迄日<input type="date" name="to" value="${e(range.to)}" required></label><button type="submit">套用</button></form>`;
    if (error || !state) {
      box.innerHTML = `${head}<p class="empty" role="alert">${e(error || "載入中…")}</p>`;
      bind();
      return;
    }
    const { o, d, t, s } = state;
    const tiles = [
      tile("認證同仁", num(o.verified_members)),
      tile("新增同仁", num(o.new_members)),
      tile("已舉辦活動", num(o.events_held)),
      tile(
        "報名（同仁／訪客）",
        `${o.registrations_member}／${o.registrations_guest}`,
      ),
      tile("報到率", pct(o.checkin_rate)),
      tile("候補人數", num(o.waitlisted)),
      tile("新增公開展示", num(o.public_spaces_created)),
      tile("討論串／回覆", `${o.threads}／${o.replies}`),
      tile("痛點／投票", `${o.pain_points}／${o.pain_point_votes}`),
      tile(
        "投票／票數",
        o.polls ? `${o.polls.created}／${o.polls.votes}` : "—",
      ),
      tile("問卷平均分數", o.feedback ? num(o.feedback.average_rating) : "—"),
      tile(
        "通知已讀率",
        o.notifications ? pct(o.notifications.read_rate) : "—",
      ),
      tile(
        "檢舉開啟／處理",
        o.reports ? `${o.reports.opened}／${o.reports.handled}` : "—",
      ),
      tile(
        "投稿（依狀態）",
        o.talk_proposals
          ? Object.entries(o.talk_proposals)
              .map(([k, v]) => `${k}:${v}`)
              .join(" ") || "0"
          : "—",
      ),
      tile(
        "同仁發起活動（依狀態）",
        o.hosted_event_requests
          ? Object.entries(o.hosted_event_requests)
              .map(([k, v]) => `${k}:${v}`)
              .join(" ") || "0"
          : "—",
      ),
    ].join("");
    const pts = s.points ?? [];
    const chart = lineChartSvg(pts, `${METRICS[metric]}趨勢`);
    const seriesTable = `<table><caption class="sr-only">${e(METRICS[metric])}</caption><thead><tr><th>區間起日</th><th>數值</th></tr></thead><tbody>${pts
      .map((p: any) => `<tr><td>${e(p.bucket)}</td><td>${p.value}</td></tr>`)
      .join("")}</tbody></table>`;
    const list = (title: string, items: any[], unit: (i: any) => string) =>
      `<div><h5>${e(title)}</h5>${
        items.length
          ? `<ol>${items.map((i) => `<li>${e(i.title)}（${e(unit(i))}）</li>`).join("")}</ol>`
          : `<p class="empty">無資料</p>`
      }</div>`;
    box.innerHTML = `${head}
<div class="dash-section"><div class="dash-tools"><b>關鍵指標</b>${csvBtn("overview")}</div><div class="dash-tiles">${tiles}</div></div>
<div class="dash-section"><h4>趨勢</h4><div class="dash-tools">
<label>指標 <select id="dash-metric">${Object.entries(METRICS)
      .map(
        ([k, v]) =>
          `<option value="${k}"${k === metric ? " selected" : ""}>${v}</option>`,
      )
      .join("")}</select></label>
<label>區間 <select id="dash-bucket"><option value="week"${bucket === "week" ? " selected" : ""}>週</option><option value="month"${bucket === "month" ? " selected" : ""}>月</option></select></label>
<button type="button" class="ghost" id="dash-toggle" aria-pressed="${showTable}">${showTable ? "顯示圖表" : "顯示資料表"}</button>${csvBtn("series")}</div>
${showTable ? seriesTable : chart || `<p class="empty">無資料</p>`}</div>
<div class="dash-section"><div class="dash-tools"><h4>各科別參與</h4>${csvBtn("departments")}</div>
${
  d.length
    ? `<table><thead><tr><th>科別</th><th>同仁數</th><th>報名</th><th>報到</th><th>展示</th><th>討論串</th></tr></thead><tbody>${d
        .map(
          (r) =>
            `<tr><td>${e(r.department)}</td><td>${r.members}</td><td>${r.registrations}</td><td>${r.checkins}</td><td>${r.spaces}</td><td>${r.threads}</td></tr>`,
        )
        .join("")}</tbody></table>${barChartSvg(
        d.map((r) => ({ label: r.department, value: r.registrations })),
        "各科別報名數",
      )}`
    : `<p class="empty">無資料</p>`
}</div>
<div class="dash-section"><div class="dash-tools"><h4>熱門內容</h4>${csvBtn("top")}</div><div class="dash-lists">
${list("熱門展示", t.spaces ?? [], (i) => `票 ${i.votes}・反應 ${i.vibes}`)}
${list("熱門痛點", t.pain_points ?? [], (i) => `${i.votes} 票`)}
${list("熱門討論", t.threads ?? [], (i) => `${i.replies} 則回覆`)}</div></div>`;
    bind();
  }
  function bind() {
    box.querySelector<HTMLFormElement>("#dash-range")!.onsubmit = (ev) => {
      ev.preventDefault();
      const f = new FormData(ev.target as HTMLFormElement);
      range.from = String(f.get("from"));
      range.to = String(f.get("to"));
      void load();
    };
    const m = box.querySelector<HTMLSelectElement>("#dash-metric");
    if (m) m.onchange = () => ((metric = m.value), void load());
    const b = box.querySelector<HTMLSelectElement>("#dash-bucket");
    if (b) b.onchange = () => ((bucket = b.value), void load());
    const tg = box.querySelector<HTMLButtonElement>("#dash-toggle");
    if (tg) tg.onclick = () => ((showTable = !showTable), draw());
    box.querySelectorAll<HTMLButtonElement>("[data-csv]").forEach((btn) => {
      btn.onclick = () => {
        if (!state) return;
        const k = btn.dataset.csv!;
        const rows =
          k === "overview"
            ? overviewRows(state.o)
            : k === "departments"
              ? departmentRows(state.d)
              : k === "top"
                ? topRows(state.t)
                : seriesRows(state.s);
        download(`dashboard-${k}-${range.from}_${range.to}.csv`, rows);
      };
    });
  }
  draw();
  await load();
}

registerFeature({
  key: "admin_dashboard",
  adminPanel: {
    id: "admin-dashboard",
    label: "營運儀表板",
    render: renderAdmin,
  },
});
