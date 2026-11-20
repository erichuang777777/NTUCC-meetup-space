# F11 活動回顧與知識庫 `event_archive`

Migration `024_event_archive.sql`；旗標 `event_archive`（預設關閉，關閉不刪資料）。全部僅限已驗證同仁（`is_verified()`），匿名一律拒絕。

## 資料與 RPC

- `event_archives(event_id pk, summary ≤3000, highlights ≤10 則字串, slides_links [{title,url(https only)}] ≤20, related_space_ids uuid[] ≤20, published, published_at, updated_by, updated_at)`；資料表僅管理員可直接讀，寫入只經 RPC。
- `save_event_archive(p_event,p_summary,p_highlights,p_slides,p_related,p_publish)`：僅管理員；DB 端驗證格式、https 連結、相關展示必須為公開展示，並以 `report_text_has_pii`（018）檢查摘要／亮點／連結標題，錯誤碼 `PII_DETECTED`、`INVALID_URL`、`INVALID_ARCHIVE`、`SPACE_NOT_FOUND`。
- `generate_event_archive_draft(p_event)`：僅管理員，**不寫入**，回傳草稿：亮點＝議程＋已排程講題（去重、至多 10）；相關展示＝已排程講題投稿人最新的公開且未被隱藏展示（投稿與展示間無直接關聯欄位，故以投稿人推定，管理員可修改）。
- `event_archive_page(p_event)`：回傳單一 jsonb（活動基本資料、議程、策展欄位、相關公開展示（標題／摘要／分類）與每個展示前 5 高票 Q&A、照片、回饋彙總）。未發布的回顧只有管理員可預覽；被版務隱藏或私人的展示／Q&A 對所有人排除。
  - 照片：沿用公開照片端點規則（published＋同意＋`public_web`，且活動 `audience='public'`），只回 id 與 `/api/v1/event-photos/public/<id>`；members-only 活動不回照片。
  - 回饋：僅回覆數與評分題平均（回覆 ≥3 份才顯示平均，絕不回傳文字答案；匿名問卷同樣只彙總）。需 `event_feedback` 旗標開啟。
- `list_event_archives(p_series,p_query,p_limit,p_offset)`：已發布回顧、最新在前，可依系列／標題搜尋（limit 上限 50）。
- `event_archive_admin_list()`：管理面板用。

## UI

`public/features/event_archive.ts`：導覽「活動回顧」（系列篩選＋搜尋＋回顧頁）；管理後台「活動回顧管理」（自動產生草稿、編輯、`ctx.review` PII 檢查後儲存、發布／取消發布）。相關展示以展示 ID 輸入。

## 部署

依序執行 migration 024，於「管理後台 → 功能開關」開啟 `event_archive`。無新增 Netlify function 或 redirect。
