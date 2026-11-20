// Pure helpers for the admin dashboard (no DOM, unit-testable).
export type Cell = string | number | null | undefined;

/** CSV with UTF-8 BOM for Excel; cells starting with = + - @ (or tab/CR) are neutralised. */
export function toCsv(rows: Cell[][]) {
  const cell = (v: unknown) => {
    let s = v == null ? "" : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return `"${s.replace(/"/g, '""')}"`;
  };
  return "﻿" + rows.map((r) => r.map(cell).join(",")).join("\r\n");
}

export type Point = { bucket: string; value: number };

const esc = (s: unknown) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );

/** Accessible inline SVG line chart; returns "" for no data. */
export function lineChartSvg(points: Point[], title: string) {
  if (!points.length) return "";
  const W = 480,
    H = 160,
    P = 28;
  const max = Math.max(1, ...points.map((p) => p.value));
  const x = (i: number) =>
    points.length === 1 ? W / 2 : P + (i * (W - 2 * P)) / (points.length - 1);
  const y = (v: number) => H - P - (v / max) * (H - 2 * P);
  const path = points
    .map(
      (p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`,
    )
    .join(" ");
  const dots = points
    .map(
      (p, i) =>
        `<circle cx="${x(i).toFixed(1)}" cy="${y(p.value).toFixed(1)}" r="3" fill="currentColor"><title>${esc(p.bucket)}：${p.value}</title></circle>`,
    )
    .join("");
  return `<svg class="dash-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}，共 ${points.length} 個區間，最大值 ${max}">
<title>${esc(title)}</title><line x1="${P}" y1="${H - P}" x2="${W - P}" y2="${H - P}" stroke="currentColor" opacity=".3"/>
<text x="${P}" y="14" font-size="11" fill="currentColor">${max}</text>
<text x="${P}" y="${H - 8}" font-size="11" fill="currentColor">${esc(points[0].bucket)}</text>
<text x="${W - P}" y="${H - 8}" font-size="11" fill="currentColor" text-anchor="end">${esc(points[points.length - 1].bucket)}</text>
<path d="${path}" fill="none" stroke="currentColor" stroke-width="2"/>${dots}</svg>`;
}

/** Accessible inline SVG horizontal bar chart. */
export function barChartSvg(
  items: { label: string; value: number }[],
  title: string,
) {
  if (!items.length) return "";
  const rowH = 24,
    L = 150,
    W = 480;
  const max = Math.max(1, ...items.map((i) => i.value));
  const rows = items
    .map((it, i) => {
      const w = Math.round((it.value / max) * (W - L - 40));
      return `<text x="${L - 6}" y="${i * rowH + 16}" font-size="12" text-anchor="end" fill="currentColor">${esc(it.label.length > 12 ? it.label.slice(0, 11) + "…" : it.label)}</text>
<rect x="${L}" y="${i * rowH + 4}" width="${w}" height="14" fill="currentColor" opacity=".75"><title>${esc(it.label)}：${it.value}</title></rect>
<text x="${L + w + 4}" y="${i * rowH + 16}" font-size="12" fill="currentColor">${it.value}</text>`;
    })
    .join("");
  return `<svg class="dash-chart" viewBox="0 0 ${W} ${items.length * rowH + 4}" role="img" aria-label="${esc(title)}"><title>${esc(title)}</title>${rows}</svg>`;
}

export function defaultRange(today = new Date(), days = 90) {
  const iso = (d: Date) =>
    new Date(d.getTime() - d.getTimezoneOffset() * 60000)
      .toISOString()
      .slice(0, 10);
  return {
    from: iso(new Date(today.getTime() - days * 86400000)),
    to: iso(today),
  };
}

export const pct = (v: number | null | undefined) =>
  v == null ? "—" : `${(Number(v) * 100).toFixed(1)}%`;
export const num = (v: unknown) => (v == null ? "—" : String(v));

/** Rows (header + body) for each exported table. */
export function overviewRows(o: any): Cell[][] {
  const rows: Cell[][] = [["指標", "數值"]];
  const add = (k: string, v: unknown) =>
    rows.push([k, v == null ? "" : (v as any)]);
  add("認證同仁數", o.verified_members);
  add("新增同仁", o.new_members);
  add("已舉辦活動", o.events_held);
  add("報名（同仁）", o.registrations_member);
  add("報名（訪客）", o.registrations_guest);
  add("報到率", o.checkin_rate);
  add("候補人數", o.waitlisted);
  add("新增公開展示", o.public_spaces_created);
  add("討論串", o.threads);
  add("回覆", o.replies);
  add("痛點", o.pain_points);
  add("痛點投票", o.pain_point_votes);
  add("投票建立數", o.polls?.created);
  add("投票票數", o.polls?.votes);
  add("問卷回覆數", o.feedback?.responses);
  add("問卷平均分數", o.feedback?.average_rating);
  add("通知發送數", o.notifications?.sent);
  add("通知已讀率", o.notifications?.read_rate);
  add("檢舉開啟", o.reports?.opened);
  add("檢舉處理", o.reports?.handled);
  for (const [k, v] of Object.entries(o.talk_proposals ?? {}))
    add(`投稿（${k}）`, v);
  for (const [k, v] of Object.entries(o.hosted_event_requests ?? {}))
    add(`同仁發起活動（${k}）`, v);
  return rows;
}
export function departmentRows(d: any[]): Cell[][] {
  return [
    ["科別", "同仁數", "報名", "報到", "展示", "討論串"],
    ...d.map((r) => [
      r.department,
      r.members,
      r.registrations,
      r.checkins,
      r.spaces,
      r.threads,
    ]),
  ];
}
export function topRows(t: any): Cell[][] {
  return [
    ["類型", "標題", "指標", "數值"],
    ...(t.spaces ?? []).map((s: any) => [
      "展示",
      s.title,
      "票數＋反應",
      s.votes + s.vibes,
    ]),
    ...(t.pain_points ?? []).map((s: any) => [
      "痛點",
      s.title,
      "票數",
      s.votes,
    ]),
    ...(t.threads ?? []).map((s: any) => [
      "討論",
      s.title,
      "回覆數",
      s.replies,
    ]),
  ];
}
export function seriesRows(s: any): Cell[][] {
  return [
    ["區間起日", "數值"],
    ...(s.points ?? []).map((p: Point) => [p.bucket, p.value]),
  ];
}
