# Email 通知與摘要（`email_notifications`）

依 F1 站內通知產生 Email。使用者可選「關閉（預設）／即時／每日摘要」。信件**只含通知標題與站內連結**，不含訊息正文與個資。Flag：`email_notifications`（預設關閉，關閉不刪資料）。

## 資料庫（migration `028_email_notifications.sql`）

| 物件                                  | 說明                                                                                                                                               |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `email_preferences`                   | `mode` off/instant/daily，預設 off（無列即 off）。本人唯讀（需 verified 且 flag 開），寫入僅經 `set_email_preference(p_mode)`。                    |
| `email_outbox`                        | 僅 `service_role`。`kind` instant/digest/test、`status` pending/sending/sent/failed/skipped、`attempts`、`last_error`（<=500，已去除信箱與金鑰）。 |
| `email_notified`                      | 記錄已被 email 涵蓋的通知，避免摘要重複。僅 service_role。                                                                                         |
| trigger `notifications_email_enqueue` | `notifications` AFTER INSERT：flag 開、使用者為 instant、該類型未被關閉時排入 outbox；收件者未驗證則標 `skipped`。不修改 `notify()`。              |
| `build_email_digests(p_now)`          | service_role。每位 daily 使用者建立一封過去 24 小時未讀且尚未寄過的通知摘要；可重複執行（冪等）。                                                  |
| `claim_email_batch(p_limit<=50)`      | service_role。`for update skip locked` 領取到期列並設 10 分鐘租約（逾時可重領）；未驗證／無信箱者標 `skipped`；回傳收件信箱（不存於 outbox）。     |
| `complete_email(p_id,p_ok,p_error)`   | 成功 → sent；失敗 → 指數退避 2/4/8/16 分鐘，第 5 次失敗 → failed。                                                                                 |
| `enqueue_test_email(p_actor)`         | service_role。僅管理員；每小時最多 3 封（`RATE_LIMITED`）。                                                                                        |
| `email_outbox_stats()`                | 管理員。各狀態筆數與最近錯誤（不含信箱）。                                                                                                         |

## Netlify Functions

- `email-dispatch.ts`：`*/10 * * * *`，領取最多 50 封寄出並回報結果；未設定環境變數時不領取、保持 pending，只記錄一次警告。
- `email-digest.ts`：`17 0 * * *`（UTC，台北 08:17）呼叫 `build_email_digests`。
- `email-test.ts`：`POST /api/email-test`，僅管理員，寄測試信給自己並立即派送。
- 三者皆先 `requireFeature(db,'email_notifications')`。信件文字 = outbox 標題清單 + `APP_ORIGIN` + 站內連結。
- 日誌只輸出遮罩後的信箱（`a***@e***.com`），不輸出金鑰。

## 寄信服務

`netlify/functions/shared/email-provider.ts`：對 `EMAIL_PROVIDER_URL` 以 `Authorization: Bearer ${EMAIL_API_KEY}` POST JSON `{from: EMAIL_FROM, to, subject, text}`，與 Resend 的 `POST /emails` 格式相容；需換服務時只改這個檔案。

## 部署

1. 依序執行 migration 028。
2. 於 Netlify 設定 `EMAIL_PROVIDER_URL`、`EMAIL_API_KEY`、`EMAIL_FROM`（不可加 `VITE_` 前綴）與 `APP_ORIGIN`。
3. 管理後台開啟 `email_notifications` 旗標；於「Email 通知」頁選擇模式；管理後台可寄測試信。

## UI

`public/features/email_notifications.ts`：導覽「Email 通知」（模式選擇）與管理面板（outbox 統計、最近錯誤、寄測試信）。F1 通知頁目前沒有擴充點，故使用獨立導覽。
