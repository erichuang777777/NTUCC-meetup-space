# F7 名額上限與候補 `event_waitlist`

活動沿用既有 `public_events.capacity`；新增每場活動的 `waitlist_enabled`。額滿後（旗標開啟且該活動勾選候補）新報名進入候補，有人取消時於同一交易內依登記順序自動遞補。

## 座位語意（決策）
- 只有 `status='registered'` 佔名額（會員與訪客一致）。`pending`（008 遺留）、`rejected`、`cancelled`、`waitlisted` 都不佔名額。
- 只有通過單位關鍵字判定者才會進候補（`eligibility_status='approved'`）；008 沒有人工審核步驟，因此遞補直接成為 `registered`。
- 候補順序：`waitlisted_at`（在活動列鎖內取 `clock_timestamp()`，單調遞增），同時間以 `id` 排序。`waitlist_position` 動態計算。
- 釋出名額的路徑，皆在同一交易呼叫 `promote_event_waitlist`：會員取消、訪客取消、已報名者改成不符資格的資料、管理員調高名額、活動由取消改回 scheduled。
- 遞補：會員收到 `waitlist_promoted` 通知（連到 `#event/<id>`）；訪客不寄信，私人管理連結狀態顯示已遞補並取得票券。
- 候補者沒有票券：`event_ticket`、`check_in_public_event`、訪客票券皆要求 `status='registered'`。
- 旗標關閉：行為與原本完全相同（額滿回 `EVENT_FULL`）；已存在的候補資料保留，但不再自動遞補。

## 並行
所有報名/取消 RPC 先 `select ... for no key update` 鎖定活動列，遞補函式在持鎖狀態下執行，名額不會超賣、不會重複遞補。`tests/event-waitlist-concurrency.sh` 以 12 人並行報名（名額 3）及並行取消驗證。

## DB 物件（020）
`public_events.waitlist_enabled`、`event_registrations.waitlisted_at`、狀態新增 `waitlisted`、`event_waitlist_position(uuid)`（service_role）、`promote_event_waitlist(uuid)`（內部）、觸發器 `public_events_promote_waitlist`；改寫 `submit_event_application`、`register_guest_event`、`access_guest_event`、`register_public_event`。

## API（皆加欄位、不破壞舊回應；旗標關閉時回應不變）
- `POST /events/:id/registration`、`/guest-registration`：額滿且開候補時回 `status:'waitlisted'` 與 `waitlist_position`。
- `GET /events/:id/registration`、訪客 `GET`：候補中時含 `waitlist_position`。
- 管理名單 `GET /events/manage/:id`：旗標開啟時含 `waitlisted` 計數與每列 `waitlist_position`。
- 管理儲存活動：`waitlist_enabled`（旗標關閉時忽略）。公開活動回應在旗標開啟時含 `waitlist_enabled`。

## 部署
套用 `020_event_waitlist.sql`，於管理員旗標頁開啟 `event_waitlist`（建議同時開啟 `notifications`），再於活動編輯勾選「額滿後開放候補」。
