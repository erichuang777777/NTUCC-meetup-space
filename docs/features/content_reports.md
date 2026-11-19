# 檢舉與版務審核（`content_reports`）

同仁可檢舉討論主題、討論回覆、問答、痛點與公開展示；管理員在後台審核佇列中隱藏、駁回或標記已處理。被隱藏的內容在 RLS 層級對一般同仁不可見，作者本人與管理員仍可看到並顯示「已隱藏」。所有處置寫入稽核紀錄。Flag 關閉時，既有可見性完全不變，資料不刪除。

## 資料庫（migration `018_content_reports.sql`，需先完成 001–013）

| 物件                                                              | 說明                                                                                                                                                                                           |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `content_reports`                                                 | 檢舉。`target_type` ∈ thread/reply/qa/pain_point/space，`reason` ∈ pii/harassment/spam/incorrect/other，`detail` ≤500，`status` open/dismissed/actioned。每位檢舉人對同一目標只能有一筆 open。 |
| `content_moderation`                                              | `(target_type,target_id)` 主鍵，`hidden`、`hidden_by`、`hidden_at`、`reason`。僅管理員可讀。                                                                                                   |
| `moderation_events`                                               | 稽核紀錄：hide / unhide / dismiss / action，含操作者、檢舉 id、備註。僅管理員可讀。                                                                                                            |
| 限制型 RLS policy `moderation_hide`                               | 加在 `spaces`、`discussion_threads`、`discussion_replies`、`pain_points`、`space_qa`（`as restrictive for select`）。                                                                          |
| `qa_public`、`discussion_threads_read`、`discussion_replies_read` | 這三個 view 以擁有者權限繞過 RLS，migration 以 `pg_get_viewdef` 動態包一層隱藏條件（保留既有欄位與授權）。`service_role` 由伺服器端 helper 過濾。                                              |
| `content_hidden_for/ _from_viewer`                                | 判斷內容（含上層：回覆→主題→展示、問答→展示）是否對某人隱藏；flag 關閉一律回傳 false；管理員與該被隱藏項目的作者例外。                                                                         |

RPC（皆檢查 flag，關閉時 `FEATURE_DISABLED`）：

- `report_content(p_type,p_id,p_reason,p_detail)`：需已驗證同仁；目標須存在且對檢舉人可見（私人展示、已隱藏內容不可檢舉）；不可檢舉自己的內容（`CANNOT_REPORT_OWN`）；重複 open 檢舉 `ALREADY_REPORTED`；每人每 24 小時最多 20 筆（`REPORT_RATE_LIMITED`）；說明含個資 `PII_DETECTED`。
- `moderate_content(p_type,p_id,p_hidden,p_note)`：僅管理員。隱藏時自動將該目標所有 open 檢舉結案（actioned）並通知檢舉人與作者（不引用內容）。
- `resolve_report(p_id,p_status,p_note)`：僅管理員，`dismissed` / `actioned`，通知檢舉人「您的檢舉已處理」。
- `admin_report_queue(p_status,p_limit,p_offset)`、`admin_moderation_history(p_limit)`：管理員佇列與歷史（含內容預覽）。
- `moderation_hidden_visible(p_type,p_ids)`：回傳作者／管理員可見但對他人隱藏的項目（UI 顯示「已隱藏」）。
- `moderation_hidden_ids(p_type,p_ids,p_viewer)`：僅 `service_role`，供 Netlify functions 過濾。

通知（`notify()`，`notifications` flag 關閉時 no-op）：`report_handled`（檢舉人）、`content_hidden`（作者）。

## Netlify functions

`netlify/functions/shared/moderation.ts`：`filterHidden` / `isHidden` / `hiddenIds`。因 functions 以 service role 讀取（繞過 RLS），在 `agent-service.ts`（專案列表／詳情、討論列表／內容、回覆）、`spaces.ts`（投影片）、`spaces-api.ts`（公開展示列表）、`mcp.ts`（展示、問答、痛點）加入過濾；flag 關閉時只多一次快取的 flag 查詢。RPC 失敗時 fail closed（503 `MODERATION_UNAVAILABLE`）。注意：過濾在分頁後進行，列表頁可能少於 limit 筆。

## 前端

`public/features/content_reports.ts`：

- `openReportDialog(ctx, type, id)`：通用檢舉對話框（送出前經 `ctx.review` PII 檢查）。
- `reportAttrs(type, id, authorId?)`：在 `app.ts`／`forum.ts` 的卡片標籤中插入 `data-report-*` 屬性（flag 關閉時為空字串）；模組以 MutationObserver 在這些元素後面插入「檢舉」按鈕（自己的內容不顯示），並為作者／管理員顯示「已隱藏」徽章。
- 管理後台面板「檢舉與版務審核」：待處理／已駁回／已處置佇列、內容預覽、隱藏／取消隱藏、駁回、標記已處理（備註）與處置紀錄。

## 部署

1. 於 Supabase SQL Editor 執行 `018_content_reports.sql`。
2. 部署程式後，管理後台 → 功能開關 開啟 `content_reports`（建議同時開啟 `notifications`）。
3. 關閉功能不刪除資料；隱藏紀錄在 flag 關閉期間不生效，重新開啟後恢復。
