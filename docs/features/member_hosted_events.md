# 同仁發起活動 `member_hosted_events`（F10）

已驗證同仁可提出活動（草稿 → 送審 → 核准上架／退回），管理員審核。核准後建立 `public_events` 並僅對**該活動**授予發起人 `event_staff` 權限，可看報名名單與現場報到。管理員可撤下。

## 權限與隱私

- 同仁發起的活動預設 `audience = 'members'`：**僅登入的院內同仁可見／可報名**。匿名訪客、訪客報名（guest）、公開照片牆皆看不到。管理員審核時必須明確勾選「公開給外部訪客」才會 `audience = 'public'`。
- `public_events.audience`（預設 `public`，既有活動不受影響）。`events-api` 列表／詳情在非登入同仁時加上 `audience = 'public'`；`event_registrations` 觸發器 `MEMBERS_ONLY` 擋下未驗證者與訪客；`event-photos-api` 公開照片亦限 `public`。
- 發起人永遠不是管理員；`event_staff` 只有該活動一列。撤下時刪除該列。報名名單僅回傳姓名／單位／狀態／報到時間（不含 Email）。
- 5 次送審／30 天／發起人（`hosted_event_submissions`，退回後重送也計入）。

## DB（`023_member_hosted_events.sql`，需在 014 之後執行）

| 物件                                                                     | 說明                                                                                       |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| `hosted_event_requests`                                                  | 提案表；RLS 僅發起人本人／管理員可讀，無直接寫入                                           |
| `hosted_event_submissions`                                               | 送審紀錄（限流用，僅 service_role）                                                        |
| `save/submit/cancel_hosted_event_request(p_actor, …)`                    | service_role；自由文字由 Netlify function 先過 PII Guard                                   |
| `review_hosted_event(p_actor,p_id,p_decision,p_note,p_publish,p_public)` | service_role；approve 於同交易建立活動＋staff＋通知 `hosted_event_reviewed`；return 需意見 |
| `revoke_hosted_event(p_actor,p_id,p_note)`                               | service_role；`is_published=false`、移除發起人 staff、通知；報名資料保留                   |
| `hosted_event_registrations(p_actor,p_id,p_page)`                        | service_role；僅發起人本人、已核准、且為該活動 staff                                       |
| `hosted_event_admin_list()`                                              | 管理員（authenticated）審核佇列                                                            |

所有函式與 policy 皆檢查 `is_feature_enabled('member_hosted_events')`；關閉不刪資料。

## API（`/api/v1/hosted-events`，`hosted-events-api.ts`，`requireFeature`）

`POST /`（儲存草稿，PII 422／`force_override` 記錄 `pii_override_logs`）、`POST /:id/submit`、`POST /:id/cancel`、`GET /:id/registrations?page=`、`POST /:id/review`（`decision`, `note`, `publish`, `public`）、`POST /:id/revoke`。現場報到沿用既有 `#event-checkin/:id`（`event_staff` 授權）。

## 部署

1. 依序執行 013–018 後執行 `023_member_hosted_events.sql`。
2. 管理後台「功能開關」開啟 `member_hosted_events`（建議同時開 `notifications`）。
3. 導覽「發起活動」；管理後台「同仁發起活動審核」。
