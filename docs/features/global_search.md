# F12 全站搜尋 `global_search`

Migration: `supabase/migrations/025_global_search.sql`（需 001–023；於 schema `extensions` 啟用 `pg_trgm`）。

## 功能

頂部放大鏡開啟搜尋視窗：型別篩選、300ms 防抖、依型別分組、Enter 立即搜尋、Esc 關閉、點擊依 `link` 導向。

## RPC `global_search(p_query, p_types, p_limit, p_offset)`

- security definer，僅已驗證同仁；flag `global_search` 關閉 → `FEATURE_DISABLED`；非同仁 → `MEMBER_REQUIRED`；查詢長度 2–100（`QUERY_TOO_SHORT` / `QUERY_TOO_LONG`）；`%` `_` `\` 一律視為字面字元。
- 回傳 `type, id, title, snippet(≤160), link, created_at, score`；排序 = word_similarity + 標題/內文 ILIKE 加權 + 時間衰減。每個來源最多取最新 200 筆候選再排序；limit 上限 50。
- 型別：`announcement`（公布欄 + 已發布公開公告）、`event`（已發布；同仁可見 public/members）、`space`（僅 public、遵守 018 隱藏）、`thread` / `reply`（同 thread_read 規則 + 018 隱藏）、`pain_point`（018 隱藏）、`talk`（僅 accepted/scheduled，需 `talk_proposals` flag）、`member`（僅 listed、未封鎖，需 `member_directory` flag）。
- 可見性沿用 018 `content_visible_to`、015 `directory_blocked`；作者／管理員可見自己／所有被隱藏內容，與 RLS 一致。

## 部署

依序執行 025，於管理後台開啟 `global_search`。關閉 flag 不刪資料。無新增 Netlify function 或 redirect。
