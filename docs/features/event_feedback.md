# 會後回饋問卷 `event_feedback`

管理員為活動建立問卷（評分 1–5、單選、開放文字，最多 15 題），發布後通知已報到的同仁；每人每場限填一份，可設為匿名。

## 權限

| 角色                                                                                        | 能做什麼                                         |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| 管理員                                                                                      | 建立／編輯問卷、發布、看彙總與 CSV               |
| 該活動的 `event_staff`                                                                      | 看彙總與 CSV（不能建立或發布）                   |
| 已報到的同仁（`event_registrations.checked_in_at` 不為空、狀態 registered、已通過密碼驗證） | 問卷發布且在開放期間內可填寫一次；可讀自己的回答 |
| 其他人（未報到、未驗證、訪客）                                                              | 看不到問卷、不能填寫                             |

匿名問卷：管理員與工作人員**無法直接讀取回答表**（RLS 只允許本人讀自己的列），只能透過彙總／匯出 RPC；匿名時匯出不含填答者欄位與時間，列順序以雜湊打散，開放文字彙總亦不依時間排序。資料庫仍保留 `respondent_id` 以防重複填寫。

問卷發布後若已有人填寫，題目與匿名設定即鎖定（`FORM_LOCKED`），避免事後改題或改匿名。關閉 flag 不刪資料。

## 資料庫（migration `016_event_feedback.sql`）

- `event_feedback_forms`（`event_id` unique）、`event_feedback_responses`（unique `form_id, respondent_id`）。
- `validate_feedback_questions(jsonb)`：題目結構驗證（1–15 題、id 格式與不重複、單選 2–10 個不重複選項）。
- service_role：`upsert_event_feedback_form(p_actor,…)`、`submit_event_feedback(p_user,p_event,p_answers)`（由 Netlify function 呼叫，先過 PII Guard）。
- authenticated：`publish_event_feedback(p_event)`（僅管理員；每位已報到同仁通知一次，重複發布不再通知）、`my_event_feedback_forms()`、`event_feedback_admin_list()`、`event_feedback_summary(p_event)`、`event_feedback_export(p_event)`。
- 所有 RLS policy 與 RPC 皆檢查 `is_feature_enabled('event_feedback')`；通知使用 `notify()`（`notifications` flag 關閉時 no-op），連結 `#event_feedback`。
- 錯誤碼：`FEATURE_DISABLED`、`ADMIN_REQUIRED`、`STAFF_REQUIRED`、`NOT_ELIGIBLE`、`FEEDBACK_UNAVAILABLE`、`FEEDBACK_NOT_OPEN`、`FEEDBACK_CLOSED`、`ALREADY_SUBMITTED`、`INVALID_ANSWERS`、`INVALID_QUESTIONS`、`INVALID_WINDOW`、`FORM_LOCKED`、`FORM_NOT_FOUND`。

## API（`netlify/functions/event-feedback-api.ts`，`/api/v1/event-feedback/*`）

僅限互動式登入（不接受 `ntucc_sk_`／`ntucc_event_` token）；先 `requireFeature(db,'event_feedback')`（關閉回 `404 FEATURE_DISABLED`）。

| 方法與路徑                                 | 說明                                                                                                                                                                              |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/v1/event-feedback/:eventId`     | 送出回答 `{ answers: {questionId: number\|string}, force_override? }`；文字內容經 PII Guard，偵測到回 `422 PII_DETECTED`，`force_override` 會寫入 `pii_override_logs`。回 `201`。 |
| `PUT /api/v1/event-feedback/:eventId/form` | 管理員建立／更新問卷 `{ questions, opens_at?, closes_at, is_anonymous, force_override? }`；題目文字經 PII Guard。`opens_at` 預設為活動結束時間。                                  |

## UI（`public/features/event_feedback.ts`）

- 管理後台面板「會後回饋問卷」：選活動 → 題目編輯器 → 儲存 → 發布；已發布者可看彙總（平均、分布、各選項計數、開放文字）與匯出 CSV（UTF-8 BOM，防公式注入）。
- 導覽「活動回饋」：列出已報到活動的問卷、填寫表單與完成畫面。送出前使用 `ctx.review`。

## 部署

1. 執行 `supabase/migrations/016_event_feedback.sql`（需先完成 001–013）。
2. 部署 Netlify（含 `netlify.toml` 新增的 `/api/v1/event-feedback/*` redirect）。
3. 管理後台 → 功能開關，開啟 `event_feedback`（要收到站內通知需同時開啟 `notifications`）。

## 給其他功能的銜接

- F14 `participation_history` 可讀 `event_feedback_responses`（本人）顯示「已填回饋」。
- F11 `event_archive` 可引用 `event_feedback_summary` 的平均分（需自行處理權限）。
