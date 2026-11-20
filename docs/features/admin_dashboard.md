# F13 營運儀表板 `admin_dashboard`

管理員專用的彙總統計頁（管理後台「營運儀表板」）。只回傳彙總數字與內容標題，不含個人層級資料或排名。

## 權限

- DB RPC 皆為 security definer；順序檢查：`admin_dashboard` flag（否則 `FEATURE_DISABLED`）→ `is_admin()`（否則 `ADMIN_REQUIRED`）→ 日期範圍（起日 ≤ 迄日、最長 730 天，否則 `INVALID_RANGE`）。
- 只授權 `authenticated`；`anon` 無法執行。不新增任何資料表，關閉 flag 不影響資料。

## RPC

- `dashboard_overview(p_from, p_to)`：認證同仁／新增同仁、已舉辦活動、報名（同仁／訪客）、報到率（以範圍內已結束活動計）、候補、公開展示、討論串／回覆、痛點與票數；以及各功能指標（polls、event_feedback 平均分數、notifications 已讀率、content_reports、talk_proposals 與 member_hosted_events 依狀態）。對應功能 flag 關閉時該欄位為 `null`。
- `dashboard_department_participation(p_from, p_to)`：各科別同仁、報名、報到、展示、討論串；同仁數 < 5 的科別合併為「其他（人數少於 5）」。
- `dashboard_top_content(p_from, p_to, p_limit=10)`：熱門展示（票＋反應）、痛點（票）、討論（回覆數），僅標題；排除私人與被隱藏（`is_hidden` 或 018 版務隱藏）內容。上限 50。
- `dashboard_timeseries(p_metric, p_from, p_to, p_bucket)`：`registrations|checkins|threads|members`，`week|month`，時區 Asia/Taipei。

## 其他

- 為統計新增 `event_registrations.created_at`（以 `updated_at` 回填）與數個 `created_at` 索引（`if not exists`）。
- UI：日期範圍（預設近 90 天）、KPI 方塊、趨勢圖（SVG，可切換資料表）、科別表、熱門清單；每個表格可匯出 CSV（UTF-8 BOM，`= + - @` 開頭的儲存格加 `'` 前綴）。
- 部署：依序執行 026 migration，於管理後台開啟 `admin_dashboard`。
