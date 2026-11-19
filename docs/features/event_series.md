# 活動系列與複製 `event_series`

管理員建立系列（例：每月 AI Meetup），把活動歸屬到系列；同仁可在「活動系列」頁看到各系列的即將舉辦與歷屆活動。管理員可「複製上一場」，建立一場未上架的草稿。

## 權限

| 角色                   | 能做什麼                                                         |
| ---------------------- | ---------------------------------------------------------------- |
| 管理員                 | 建立／編輯／封存系列、指派活動、複製活動、看全部活動（含草稿）   |
| 已驗證同仁             | 讀取未封存系列，以及系列內**已上架**活動的標題、地點、時間與狀態 |
| 未驗證者、訪客（anon） | 無任何存取                                                       |

`public_events` 仍不開放瀏覽器直接讀取；同仁僅能透過 `event_series_events()` 取得已上架活動的最小欄位（不含名額、議程等），可見範圍沒有放寬。關閉 flag 不刪資料（`series_id` 與系列保留）。

## 資料庫（migration `024_event_series.sql`）

- `event_series(id, title ≤80, description ≤1000, slug unique, created_by, created_at, archived)`；`public_events.series_id`（nullable FK，系列刪除時設為 null）。
- RLS：已驗證成員可讀未封存系列（管理員含封存），需 `is_feature_enabled('event_series')`；無直接寫入權限。
- service_role：`create_event_series(p_actor,p_title,p_description,p_slug)`、`update_event_series(p_actor,p_id,p_title,p_description,p_archived)`（由 Netlify function 呼叫，先過 PII Guard）。`p_slug` 省略時自動產生 `series-xxxxxxxxxx`。
- authenticated（管理員）：`assign_event_series(p_event,p_series)`（`p_series` 為 null 即移出系列）、`event_series_admin_events()`、`clone_event(p_source,p_starts_at,p_ends_at) returns uuid`。
- authenticated（已驗證同仁）：`list_event_series()`、`event_series_events(p_series)`。
- 錯誤碼：`FEATURE_DISABLED`、`ADMIN_REQUIRED`、`MEMBER_REQUIRED`、`SERIES_NOT_FOUND`、`EVENT_NOT_FOUND`、`INVALID_WINDOW`、`INVALID_SERIES`、`INVALID_SLUG`、`SLUG_TAKEN`。

### `clone_event`

複製：標題、介紹、地點、名額、`series_id`；報名截止與報到時段**依開始時間差平移**；議程時間為 `HH:MM` 者依台北時間開始時刻的差平移（其他格式如「晚間」原樣保留）；若來源活動有回饋問卷，複製題目與匿名設定，開放／截止時間以新結束時間為基準平移，且為**未發布**。

新活動一律為 `status='scheduled'`、`is_published=false`、`sequence=0`。**不複製**：報名、報到、票券 token、工作人員（`event_staff`）、訪客、照片、回饋回覆。需 `p_ends_at > p_starts_at`，否則 `INVALID_WINDOW`。

## API（`netlify/functions/event-series-api.ts`）

- `POST /api/v1/event-series`（建立）、`PUT /api/v1/event-series/:id`（編輯／封存）；僅管理員、互動式登入；先 `requireFeature(db,'event_series')`；標題與說明經後端 PII Guard（`force_override` 會記錄）。
- 指派與複製由前端直接呼叫上述管理員 RPC（與其他 RPC 型功能一致），不經 events-api，故未修改既有活動 API。

## 前端（`public/features/event_series.ts`）

- 導覽「活動系列」：列出系列與即將舉辦／歷屆活動（連到 `#event/<id>`）。
- 管理後台「活動系列與複製」：新增／編輯／封存系列、下拉指派活動、「複製上一場」輸入新開始／結束時間（以台北時間解讀）。

## 部署

1. 執行 `024_event_series.sql`。
2. 部署 Netlify（`netlify.toml` 已加入 `/api/v1/event-series` 轉送）。
3. 管理後台「功能開關」開啟 `event_series`。

## 後續整合備註

- 若 F7（候補）、F10（同仁發起活動）在 `public_events` 新增設定欄位，`clone_event` 需視需要補上對應欄位（目前複製 006／007／009 的欄位）。
