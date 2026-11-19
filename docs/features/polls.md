# 投票／意見調查（`polls`）

Flag：`polls`（預設關閉）。Migration：`supabase/migrations/017_polls.sql`（需先完成 001–013）。

## 功能

- 單選／複選（`max_choices`）、2–10 個選項、可設截止時間、匿名或記名、結果顯示時機（`always`／`after_vote`／`after_close`）。
- 可記錄附加對象（`announcement`／`event`／`thread`，建立時驗證對象存在）。本期不修改公告、活動、討論串的 UI；日後以 `renderPollEmbed` 嵌入。
- 關閉 flag 不刪除資料；重新開啟後完整恢復。

## 權限

| 角色         | 建立                                | 投票 | 結束投票     | 看結果          |
| ------------ | ----------------------------------- | ---- | ------------ | --------------- |
| 未驗證／匿名 | 否                                  | 否   | 否           | 否              |
| 已驗證同仁   | 僅當 `members_can_create = true` 時 | 是   | 僅自己建立者 | 依 show_results |
| 管理員       | 是                                  | 是   | 任何投票     | 依 show_results |

- `poll_settings`（單列表，`members_can_create` 預設 false）僅能由管理員經 `set_poll_settings(bool)` 修改。
- 結果顯示規則對所有人一致（含管理員、建立者）：`after_vote` = 已投票或已截止；`after_close` = 已截止（`status='closed'` 或 `closes_at` 已過）。
- 匿名投票：任何人（含管理員）都無法取得投票者身分；`poll_votes` 的 RLS 只允許讀自己的列。記名投票：`poll_results` 對已驗證同仁回傳各選項投票者顯示名稱。

## DB API（皆 security definer，需 flag 開啟，錯誤碼為例外訊息）

- `create_poll(p_title, p_description, p_kind, p_max_choices, p_is_anonymous, p_show_results, p_closes_at, p_attached_type, p_attached_id, p_options text[]) → uuid`
  錯誤：`FEATURE_DISABLED`、`MEMBER_REQUIRED`、`CREATE_NOT_ALLOWED`、`INVALID_POLL`、`INVALID_OPTIONS`、`INVALID_ATTACHMENT`、`PII_DETECTED`。
  DB 端 PII 檢查（`polls_has_pii`）拒絕身分證字號格式與帶上下文的病歷號（標題、說明、選項皆檢查）；DB 端不接受 override，前端 `ctx.review` 為第一道。
- `cast_poll_vote(p_poll, p_options uuid[])`：以 advisory lock 序列化同一人同一投票的請求，原子地取代先前選擇；檢查選項屬於該投票、不重複、數量 ≤ `max_choices`、未截止。錯誤：`INVALID_CHOICES`、`POLL_CLOSED`、`POLL_NOT_FOUND`。
- `close_poll(p_poll)`：管理員或建立者；錯誤 `FORBIDDEN`。
- `poll_results(p_poll) → jsonb`：`visible`、`has_voted`、`my_options`、`total_voters`、`options[{id,label,position,votes,voters}]`；結果不可見時不含票數。
- `set_poll_settings(p_members_can_create)`：僅管理員。
- 資料表只有 SELECT 權限（RLS 皆含 `is_feature_enabled('polls')`），所有寫入走 RPC。

## 前端

`public/features/polls.ts`：導覽「投票」（進行中／已結束、建立表單、投票、CSS 長條圖結果）與管理後台「投票管理」面板（允許同仁建立、結束投票）。

### 嵌入其他功能

```ts
import { renderPollEmbed } from "./polls";
await renderPollEmbed(containerEl, pollId, ctx); // flag 關閉或無權限時不渲染
```

## 測試

- `tests/polls.sql`：建立權限、選項上限、單選／複選、截止／過期拒絕、匿名性、結果可見規則、flag 關閉。
- `tests/polls-concurrency.sh`：同一使用者平行投票永遠不超過 `max_choices`。

## 部署

在 Supabase SQL Editor 執行 `017_polls.sql`，以管理員到「管理後台 → 功能開關」開啟 `polls`。

## 留給其他功能

- 通知：本期未呼叫 `notify`（計畫未要求）；日後可於建立投票／即將截止時通知。
- F1/F2/F6 可在公告、活動、討論串頁面用 `renderPollEmbed` 與 `attached_type/attached_id` 嵌入投票。
