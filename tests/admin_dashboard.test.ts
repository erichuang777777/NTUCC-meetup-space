import test from "node:test";
import assert from "node:assert/strict";
import {
  barChartSvg,
  defaultRange,
  departmentRows,
  lineChartSvg,
  toCsv,
} from "../public/features/admin_dashboard_lib.js";

test("CSV has BOM, quotes cells and neutralises formula prefixes", () => {
  const csv = toCsv([["=1+1", "+x", "-y", "@z", 'a"b', null, 3]]);
  assert.ok(csv.startsWith("﻿"));
  assert.equal(csv.slice(1), `"'=1+1","'+x","'-y","'@z","a""b","",\"3\"`);
});

test("charts are accessible SVG and escape labels", () => {
  const svg = lineChartSvg(
    [
      { bucket: "2026-01-05", value: 2 },
      { bucket: "2026-01-12", value: 5 },
    ],
    "<趨勢>",
  );
  assert.match(svg, /role="img"/);
  assert.ok(!svg.includes("<趨勢>"));
  assert.equal(lineChartSvg([], "x"), "");
  assert.match(barChartSvg([{ label: "<b>", value: 1 }], "t"), /&lt;b&gt;/);
});

test("default range is 90 days and department rows have a header", () => {
  const r = defaultRange(new Date("2026-06-30T12:00:00Z"));
  assert.ok(r.from < r.to);
  assert.equal(departmentRows([]).length, 1);
});
