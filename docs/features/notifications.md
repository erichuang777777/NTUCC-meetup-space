# 站內通知中心（`notifications`）

Migration：`supabase/migrations/014_notifications.sql`　測試：`tests/notifications.sql`、`tests/notifications.test.ts`

## 功能

- 頂部鈴鐺＋未讀數（Realtime 更新，另每 60 秒輪詢）；通知頁（每頁 20 筆、單筆／全部已讀、點擊導向 `link`）；偏好區可依類型關閉。
- 所有物件皆受 `notifications` 旗標控制。旗標關閉：通知列與偏好不可見、標記已讀為 no-op、`notify()` 與所有 trigger 不產生資料；資料不刪除。

## 資料庫

| 物件                                                       | 說明                                                                                                                          |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `notification_preferences(user_id,type,enabled)`           | 只能存取自己的列（已驗證＋旗標開啟）                                                                                          |
| `notifications_flag_gate`                                  | restrictive select policy，旗標關閉時隱藏 013 的列                                                                            |
| `notify()`（replace）                                      | 簽章與授權不變（僅 service_role）；使用者對該類型 `enabled=false` 時不建立                                                    |
| `mark_*_read`（replace）                                   | 旗標關閉回傳 0                                                                                                                |
| trigger `private_messages_notify`                          | 新私訊 → 收件者，type `private_message`，body 為寄件者名稱；任一方封鎖則不通知                                                |
| trigger `discussion_replies_notify`                        | 回覆 → 討論串作者（略過自己、隱藏回覆），type `discussion_reply`，link `#project/<space>/thread/<id>`                         |
| trigger `event_registrations_review_notify`                | 審核 pending→approved／rejected 或 status→rejected → 註冊者（僅有 user_id），type `registration_review`，link `#registration` |
| `event_reminders_sent` / `queue_event_reminders(p_window)` | 僅 service_role；對視窗內（預設 24 小時）已通過的註冊者各提醒一次，type `event_reminder`；旗標關閉回傳 0                      |

通知類型：`private_message`、`discussion_reply`、`registration_review`、`event_reminder`（前端偏好清單見 `NOTIFICATION_TYPES`）。其他功能新增類型時請一併加入該清單。

## Netlify

`netlify/functions/event-reminders.ts`：`@hourly` 排程，使用 service client，先 `requireFeature(db,'notifications')` 再呼叫 `queue_event_reminders`。

## 部署

1. 套用 014。2. 部署 functions。3. 管理後台開啟 `notifications` 旗標。Realtime：013 已嘗試將 `notifications` 加入 `supabase_realtime`。

## 備註

通知頁以 `ctx.navigate("notifications")` 開啟（鈴鐺）；尚未加入導覽列項目，因此直接以網址 `#notifications` 重新整理會回到預設頁。
