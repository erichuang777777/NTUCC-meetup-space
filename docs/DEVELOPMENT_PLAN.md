# NTUCC Meetup Spaces — 擴充功能開發計劃

> 目標：讓同仁可以**發起活動交流**、**互相聯絡**、**發表意見**。
> 原則：每個新功能都有獨立的 **Feature Flag**，管理員可在後台即時開啟／關閉；**預設全部關閉**，上線後逐項開啟驗收。
> 本計劃與既有 SPEC.md、PUBLIC_EVENTS.md 並存；衝突時以 SPEC.md 開頭的「最新產品決策」為準（院內成員限定、PII Guard、無教育積分）。

## 0. 尚待產品決策（先採用的預設值）

| 問題                     | 本計劃預設                                                                                   | 可調整方式                       |
| ------------------------ | -------------------------------------------------------------------------------------------- | -------------------------------- |
| 誰可以發起活動？         | 預設僅管理員；開啟 `member_hosted_events` 後，同仁可提案、經管理員審核才上架                 | Feature flag                     |
| 通知管道                 | 站內通知中心；Email 為獨立 flag `email_notifications`，需設定寄信服務環境變數才會真正寄出    | Feature flag + Netlify 環境變數  |
| LINE / Teams             | 不在本期範圍，通知模組預留 channel 欄位                                                      | 後續擴充                         |
| 使用規模                 | 以數百至上千人設計：清單分頁、搜尋走 PostgreSQL full-text / trigram，不引入外部搜尋服務      | —                                |

## 1. 共用基礎（Phase 0，所有功能的前置）

### 1.1 Feature Flags

- migration `013_feature_flags.sql`
  - `feature_flags(key text primary key, enabled boolean not null default false, label text, description text, updated_by uuid, updated_at timestamptz)`
  - RLS：已驗證成員可讀；寫入僅能透過 `set_feature_flag(p_key, p_enabled)`（security definer，`is_admin()` 檢查，寫入 `member_admin_events` 或專用稽核表）。
  - `is_feature_enabled(p_key text) returns boolean`（stable, security definer）：未知 key 一律回傳 false。
  - 預先 seed 本計劃所有 key（皆為 false）。
- 強制點（三層都要擋，不能只靠前端隱藏）：
  1. **資料庫**：功能相關 RLS policy 與 RPC 皆加 `is_feature_enabled('<key>')` 條件。
  2. **Netlify Functions / REST / MCP**：`netlify/functions/shared/features.ts` 提供 `requireFeature(db, key)`，關閉時回傳 `404 { code: "FEATURE_DISABLED" }`。
  3. **前端**：`public/features.ts` 載入 flags，`isEnabled(key)`；關閉時不顯示導覽、按鈕與區塊。
- 管理後台新增「功能開關」面板：列出所有 flag、說明、最後修改者與時間，一鍵切換。
- 關閉功能**不刪除資料**；重新開啟後資料完整恢復。

### 1.2 前端功能模組註冊（降低多人平行開發衝突）

- `public/feature-registry.ts`：各功能以 `registerFeature({ key, nav?, adminPanel?, render, ... })` 註冊；`app.ts` 只負責讀取 registry 產生導覽與頁面。
- 每個功能的 UI 放在自己的 `public/features/<key>.ts`，避免大家都改 `app.ts`。

### 1.3 站內通知核心（供其他功能呼叫）

- 在 Phase 0 一起建立 `notifications(id, user_id, type, title, body, link, payload jsonb, read_at, created_at)` 與 `notify(p_user uuid, p_type text, p_title text, p_body text, p_link text, p_payload jsonb)`。
- `notify()` 在 `notifications` flag 關閉時直接 no-op，其他功能可放心呼叫，不必互相等待。

### 1.4 測試基礎

- `scripts/test-sql-local.sh [port]`：以獨立 PostgreSQL cluster 執行 CI 中全部 SQL/RLS 步驟，平行開發時每個 worktree 用不同 port。
- 每個功能必須附：migration 對應的 `tests/<key>.sql`（含 flag 關閉時被拒的案例）、必要的 `tests/<key>.test.ts`，並把 SQL 步驟加入 `.github/workflows/ci.yml`。

## 2. 功能清單與 Feature Flag

| #   | Flag key                | 功能                         | Migration | Wave |
| --- | ----------------------- | ---------------------------- | --------- | ---- |
| F1  | `notifications`         | 站內通知中心                 | 014       | A    |
| F2  | `member_directory`      | 同仁名錄與專長標籤           | 015       | A    |
| F3  | `event_feedback`        | 會後回饋問卷                 | 016       | A    |
| F4  | `polls`                 | 投票／意見調查               | 017       | A    |
| F5  | `content_reports`       | 檢舉與版務審核               | 018       | A    |
| F6  | `forum_plus`            | 論壇強化                     | 019       | B    |
| F7  | `event_waitlist`        | 名額上限與候補               | 020       | B    |
| F8  | `talk_proposals`        | 徵稿／講者報名               | 021       | B    |
| F9  | `event_series`          | 活動系列與複製               | 022       | B    |
| F10 | `member_hosted_events`  | 同仁發起活動（需審核）       | 023       | B    |
| F11 | `event_archive`         | 活動回顧與知識庫             | 024       | C    |
| F12 | `global_search`         | 全站搜尋                     | 025       | C    |
| F13 | `admin_dashboard`       | 營運儀表板                   | 026       | C    |
| F14 | `participation_history` | 個人參與紀錄                 | 027       | C    |
| F15 | `email_notifications`   | Email 通知與摘要             | 028       | C    |

Migration 編號預先分配，平行開發不會撞號。

## 2.1 實作狀態（15 / 15 已實作，flag 預設全部關閉）

- 全部功能已完成並整合；每項的說明、權限與部署步驟見 `docs/features/<key>.md`。
- 部署順序：Supabase 依序執行 013 → 028；Netlify 部署後，到管理後台「功能開關」逐項開啟驗收。
- 已知限制與後續可做：
  - `global_search` 以子字串比對，錯字不會命中；`event_archive` 尚未納入搜尋。
  - `event_archive` 的相關展示以 id 貼上選取，尚無選擇器介面。
  - `email_notifications` 需設定 `EMAIL_PROVIDER_URL`、`EMAIL_API_KEY`、`EMAIL_FROM` 才會真正寄出。
  - 各功能 UI 僅以建置、型別檢查與示例預覽驗證，尚未對真實 Supabase 專案做端對端驗收。

### F1 站內通知中心 `notifications`
- 頂部小鈴鐺＋未讀數；通知列表（分頁）、單筆／全部標為已讀。
- 觸發來源（由各功能呼叫 `notify()`）：報名審核結果、活動前提醒、私訊、討論被回覆／@提及、候補遞補、投稿審核結果。
- 個人偏好：可依類型關閉通知（`notification_preferences`）。
- Supabase Realtime 推播未讀數（無 Realtime 時退回輪詢）。

### F2 同仁名錄與專長標籤 `member_directory`
- 個人資料擴充：專長／興趣標籤、簡介、「歡迎請教」開關與主題。
- 名錄頁：依科別、標籤搜尋與篩選；只顯示**自願公開**的同仁（預設不公開，opt-in）。
- 從名錄、展示頁、討論串一鍵「私訊」（沿用既有 private_messages 與封鎖機制）。
- 簡介與標籤送出前經 PII Guard。

### F3 會後回饋問卷 `event_feedback`
- 管理員為活動設定問卷（評分題、單選、開放文字）；活動結束後對已報到者開放。
- 每人每場一份；可匿名（對其他同仁匿名，資料庫仍記錄以防重複）。
- 管理員看彙總統計與匯出 CSV；開放文字經 PII Guard。
- 發布問卷時通知已報到者。

### F4 投票／意見調查 `polls`
- 管理員或（可設定）同仁建立投票：單選／複選、截止時間、是否匿名、是否顯示即時結果。
- 可附加於公告、活動或討論串。
- 一人一票（或依複選上限）以 DB constraint 保證。

### F5 檢舉與版務 `content_reports`
- 同仁可檢舉討論、回覆、問答、痛點、展示（附原因）。
- 管理員審核佇列：隱藏內容、駁回、聯絡作者；被隱藏內容在 RLS 層級對一般同仁不可見，作者本人看得到並顯示「已隱藏」。
- 所有處置寫入稽核紀錄。

### F6 論壇強化 `forum_plus`
- @提及同仁（觸發通知）、按讚「有幫助」、作者標記最佳解答、追蹤主題（新回覆通知）、管理員置頂／精華。

### F7 名額上限與候補 `event_waitlist`
- 活動可設定名額；額滿後自動進入候補（依時間排序）。
- 有人取消時於同一交易內自動遞補，並通知遞補者。
- 必須與既有報名、審核、訪客報名、QR 票券流程相容，加上並行測試（避免超賣）。

### F8 徵稿／講者報名 `talk_proposals`
- 同仁投稿題目（摘要、類型：實戰展示／踩坑避雷、預計時長、希望場次），可連結痛點許願池的痛點（「我來解這個痛點」）。
- 管理員審核：接受／退回（附意見）／排入議程（連到既有 agenda）。
- 痛點頁顯示「已有人認領」。

### F9 活動系列與複製 `event_series`
- 建立系列（例：每月 AI Meetup），活動歸屬系列；系列頁列出歷屆。
- 一鍵「複製上一場」：帶入地點、時長、名額、問卷模板，日期需重新設定，不複製報名資料。

### F10 同仁發起活動 `member_hosted_events`
- 開啟後，已驗證同仁可提出活動（讀書會、科內小聚），狀態：草稿 → 送審 → 核准上架／退回。
- 發起人可管理自己活動的報名名單與報到（對該活動授予 event_staff 權限）。
- 管理員可撤下。

### F11 活動回顧與知識庫 `event_archive`
- 活動結束後自動產生回顧頁：議程、各講者展示與投影片連結、高票 Q&A、已同意公開的照片、回饋摘要。
- 歷屆回顧列表，可依主題／系列瀏覽。

### F12 全站搜尋 `global_search`
- 跨公告、活動、展示、討論、痛點、投稿（與名錄中公開同仁）搜尋。
- PostgreSQL full-text + `pg_trgm`（中文以 trigram 為主）；結果遵守各自 RLS 與 feature flags。

### F13 營運儀表板 `admin_dashboard`
- 管理員限定：報名數、出席率、各科室參與、熱門展示／痛點／討論、通知開啟率、問卷平均分數。
- 只呈現彙總數字，不顯示個人層級排名；可匯出 CSV。

### F14 個人參與紀錄 `participation_history`
- 個人頁顯示參加過的活動、分享過的展示、投稿紀錄（僅本人可見；可選擇在名錄公開）。
- 不做積分（教育積分已取消）。

### F15 Email 通知與摘要 `email_notifications`
- 依 F1 通知產生 email outbox；使用者可選即時／每日摘要／關閉。
- 透過環境變數設定 HTTP 寄信服務（`EMAIL_PROVIDER_URL`、`EMAIL_API_KEY`、`EMAIL_FROM`）；未設定時只排入 outbox 不寄出。
- Netlify Scheduled Function 處理寄送與重試；信件內容只放標題與站內連結，不含 PII 正文。

## 3. 開發流程

1. **Phase 0**（單一子代理）：Feature flag、前端註冊機制、通知核心、管理後台開關面板。完成並通過全部測試後合併。
2. **Wave A → B → C**：每個 wave 內的功能由多個 Sonnet 子代理在**獨立 git worktree** 平行開發，各自使用預先分配的 migration 編號、`public/features/<key>.ts`、獨立測試檔與獨立 SQL port。
3. 每個 wave 結束：整合到 `claude/clever-brahmagupta-hsz69k`，解決衝突，跑完整驗證（`npm run build`、`npm test`、`bash scripts/test-sql-local.sh`、`npm run test:browser`），推送並更新 draft PR。
4. 定期 `git fetch origin main` 並合併，與另一處同時進行的開發保持一致。

## 4. 每個功能的完成定義（Definition of Done）

- [ ] Migration 可在既有資料庫上**增量**執行，不重跑 001。
- [ ] Flag 關閉時：DB RLS/RPC、API、MCP、UI 三層皆無法使用；資料保留。
- [ ] 所有使用者輸入的自由文字經前後端雙層 PII Guard。
- [ ] RLS 測試涵蓋：非成員、未通關、一般成員、作者本人、管理員，以及 flag 關閉。
- [ ] `npm run build`、`npm test`、`scripts/test-sql-local.sh` 全綠。
- [ ] `docs/features/<key>.md` 說明功能、權限、API、部署步驟。

## 5. 部署注意

- Migration 013–028 需依序在 Supabase SQL Editor 執行；flag 預設關閉，部署後不會立即改變現有行為。
- 新環境變數（F15）：`EMAIL_PROVIDER_URL`、`EMAIL_API_KEY`、`EMAIL_FROM`，僅 Functions 可讀，不可加 `VITE_` 前綴。
