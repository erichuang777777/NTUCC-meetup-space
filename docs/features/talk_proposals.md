# F8 徵稿／講者報名（`talk_proposals`）

同仁投稿分享題目，管理員審核後排入活動議程；痛點許願池可顯示「已有人認領」。Flag：`talk_proposals`（預設關閉；關閉不刪資料）。Migration：`supabase/migrations/021_talk_proposals.sql`（需先完成 001–018；用到 014 的 `notify` 與 018 的 `report_text_has_pii`）。

## 資料與狀態機

`talk_proposals(id, proposer_id, title≤120, abstract≤1500, category_tag '實戰展示'|'踩坑避雷', duration_minutes 5|10|15|20, preferred_event_id, pain_point_id, status, reviewer_note, reviewed_by, reviewed_at, scheduled_event_id, created_at, updated_at)`

```
draft ──submit──> submitted ──review(accepted)──> accepted ──schedule──> scheduled
  ^                   │                              │
  └─ (edit+submit) ── returned <──review(returned)───┘(僅 submitted 可審核)
draft/submitted/returned/accepted ──withdraw──> withdrawn（終態；scheduled 不可由投稿人撤回）
```

編輯只允許 `draft`／`returned`；`returned` 修改後重新送出回到 `submitted`。

## 權限

- 資料表 RLS：投稿人只能讀自己的列；管理員可讀非草稿列。無任何直接寫入權限。
- 其他已驗證同仁透過 `list_accepted_talks()`（security definer）只看到已接受／已排程投稿的題目、類型、時長、投稿人姓名，不含摘要與審核意見。
- 全部 RPC 與 policy 皆檢查 `is_feature_enabled('talk_proposals')`。

## RPC

| RPC                                                                                                    | 授權                    | 說明                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------ | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `upsert_talk_proposal(p_actor,p_id,p_title,p_abstract,p_category,p_duration,p_preferred_event,p_pain)` | service_role            | 建立／編輯（僅 draft/returned、僅本人）                                                                                                                                                                                       |
| `submit_talk_proposal(p_actor,p_id)` / `withdraw_talk_proposal(p_actor,p_id)`                          | service_role            | 送出／撤回                                                                                                                                                                                                                    |
| `review_talk_proposal(p_id,p_status,p_note)`                                                           | authenticated（管理員） | `accepted`／`returned`（退回需意見）；通知投稿人 `talk_proposal_reviewed`；意見經 DB 端 PII 檢查                                                                                                                              |
| `schedule_talk_proposal(p_id,p_event_id)`                                                              | authenticated（管理員） | 僅 `accepted`；於 `public_events.agenda`（009 的 jsonb 陣列，≤30 項，項目 `{time,title,speaker}`）追加一筆（時間＝活動開始時間（台北）、講者＝投稿人姓名），記錄 `scheduled_event_id`，通知投稿人。議程已滿回 `AGENDA_FULL`。 |
| `talk_proposals_admin_list()`                                                                          | authenticated（管理員） | 審核佇列（含投稿人姓名、希望場次、痛點）                                                                                                                                                                                      |
| `list_accepted_talks()`                                                                                | authenticated           | 已接受投稿的透明化清單                                                                                                                                                                                                        |
| `pain_point_claims(p_pain)` / `pain_point_claim_counts()`                                              | authenticated           | 痛點被 accepted/scheduled 投稿認領的數量（單筆／批次）                                                                                                                                                                        |

錯誤碼：`FEATURE_DISABLED` `MEMBER_REQUIRED` `ADMIN_REQUIRED` `PROPOSAL_NOT_FOUND` `NOT_EDITABLE` `INVALID_TRANSITION` `INVALID_PROPOSAL` `INVALID_STATUS` `NOTE_REQUIRED` `EVENT_NOT_FOUND` `PAIN_POINT_NOT_FOUND` `AGENDA_FULL` `PII_DETECTED`。

## HTTP API（`netlify/functions/talk-proposals-api.ts`）

需登入（互動式 session，不接受 API token）、`requireFeature`、後端 PII Guard（`422 PII_DETECTED`；`force_override: true` 寫入 `pii_override_logs`）。

- `POST /api/v1/talk-proposals` 建立草稿；`PUT /api/v1/talk-proposals/:id` 編輯。Body：`title, abstract, category_tag, duration_minutes, preferred_event_id?, pain_point_id?, submit?, force_override?`（`submit:true` 於儲存後立即送審）。
- `POST /api/v1/talk-proposals/:id/submit`、`POST /api/v1/talk-proposals/:id/withdraw`。
- `netlify.toml` 的 redirect 置於 `/api/*` 之前。

## UI

- 導覽「徵稿」（`#talk_proposals`）：我的投稿（新增／編輯／送審／撤回，儲存前經 `ctx.review`）、已接受的分享。
- 管理後台「徵稿審核」：接受／退回（意見）／排入活動。
- 痛點頁：`app.ts` 的 `painView` 結尾有受 flag 保護的一行呼叫 `decoratePainPoints`，加上「已有人認領」徽章與「我來解這個痛點」按鈕（開啟預填 `pain_point_id` 的投稿表單）。Flag 關閉時 DOM 不變。
- `NOTIFICATION_TYPES` 新增 `talk_proposal_reviewed`。

## 部署

1. 執行 `021_talk_proposals.sql`（在 018 之後）。2. 部署 Netlify。3. 管理後台開啟 `talk_proposals`（建議同時開啟 `notifications`）。

## 限制

排入議程後若要移除，需管理員到活動編輯議程；目前不提供「取消排程」RPC（投稿狀態維持 `scheduled`）。
