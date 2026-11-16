> 最新產品決策：活動、分享、問答與痛點限登入且通過院內密語的同仁瀏覽，訪客不再具有公開唯讀權限。REST、MCP 與資料庫皆實施門禁；public 表示院內可見。教育積分功能已取消，活動不限午間。以下 Final v1.0 歷史描述若有衝突，以此更新及 002 migration 為準。

# NTUCC Meetup Spaces — 系統開發規格書

Final v1.0 · 依使用者提供的開發規格建立，以下包含功能要求及本次實作決策。正式名稱：NTUCC Meetup Spaces（臺大癌醫內部交流與 AI 展示空間）；專案代號：ntucc-meetup-spaces；既有 GitHub repository：erichuang777777/NTUCC-meetup-space。

## 產品原則

服務臺大癌醫醫師、護理師、醫技、資訊與行政同仁。每份 Space 由單一講者擁有，沒有多人共編與 Fork。管理員不得讀取其他人的私人草稿。以「✨ 實戰展示／💣 踩坑避雷」降低分享門檻，透過參考連結傳遞資源。每次分享 10 分鐘（7 分鐘演示＋3 分鐘 Q&A），公開展示沉澱為知識庫。

## 技術架構

- Netlify 連結 GitHub repository，託管 Vite 建置的單頁前端；Netlify Functions 提供 REST、LLM 代理與 Remote MCP。
- Supabase PostgreSQL、RLS、Google OAuth、Realtime。Google 首次登入後需以 `verify_ntucc_passcode(input_code)` 通過院內通關。密語存放 Supabase Vault。
- LLM 使用 HTTPS OpenAI 相容 `/v1/chat/completions`，金鑰僅為 Function 環境變數 `CLOUD_LLM_API_KEY`。
- Remote MCP 使用官方 SDK `WebStandardStreamableHTTPServerTransport`，`sessionIdGenerator: undefined`，POST-only；CORS 允許 Content-Type、Authorization、Mcp-Method、Mcp-Name 與 MCP-Protocol-Version。
- 需求原列 MCP `2026-07-28`；目前鎖定 SDK 協商最高 `2025-11-25`。實作無狀態傳輸，不聲稱尚不受 SDK 支援的版本。

## 入口與導覽

首頁優先顯示 Google 登入畫面，登入後預設進入公布欄。未設定 Supabase 的預覽環境提供明確標示的示例入口。主功能以固定底部 SVG 圖示列切換，保留精簡文字標籤與目前頁面提示，支援手機安全區域。登入頁使用暖紅金色的跨職類交流主視覺。

## 五大功能

### 公布欄

顯示場地、日期、午間餐盒、教育學分與去識別化紅線。分類：場地異動／資安紅線／教育學分／活動公告。僅已通關 admin 可發布與置頂，訪客唯讀。

### 報名與報到

已通關同仁對本期活動一鍵報名，可選葷食、素食、不需餐盒。每位同仁每場唯一。管理員與排入本期的講者可協助報到，admin 可匯出 CSV，統計應到、實到與餐盒。支援相機掃描與貼上 QR 內容；自助報到使用本期 URL，員工證目前接收使用者 UUID，正式員工證資料對應待院方提供。

### 10 分鐘展示舞台

- 展示依類型篩選與關鍵字搜尋，議程依管理員設定的場次開始時間＋`slot_order × 10 分鐘` 計算。
- HTML 上傳或 AI 大綱生成 10–15 張；標記 `section.slide` 或 `[data-slide]`，前端 DOMParser 與後端 parse5 皆檢查實際 DOM。
- 播放器提供全螢幕、左右鍵、頁碼進度、7 分鐘青綠演示、2 分鐘琥珀高票 Q&A、最後 1 分鐘紅色閃爍收尾。
- iframe 必須 `sandbox="allow-scripts"`，禁止 `allow-same-origin`。CSP 限制網路、表單、巢狀框架等。為阻擋任意程式碼的導向與個資外送，本版移除講者 JS、inline handlers 與導向，僅保留受控翻頁 runtime；自訂 JS 互動投影片尚未開放。
- 參考連結分類：工具官網／Prompt 範本／開源專案／臨床指引，僅 HTTPS。
- 會前與會中皆可提問，具名或匿名，依票數排序，講者可標記已回答。匿名公開資料不含 author_id。高票未答題在 Q&A 階段顯示。
- 共鳴：🤯 神級效率、🏥 我們科也需要、🔒 資安給過、👏 跪求連結，原子累計＋Realtime 氣泡，不遮擋主要內容。

### 個人工作空間

只有 owner 可編輯／替換投影片／更新連結／發布，private RLS 無 admin 例外。Token 以 `ntucc_sk_` 加 32 隨機 bytes 產生，只在建立時回傳一次明文，資料庫僅保存 SHA-256、前綴與最後使用時間；支援撤銷。

### 痛點許願池

填寫標題、部門、場景、耗時與期待方向。提供關鍵字／部門搜尋與一人一票「我也有」，不實作強制組隊或認領。

## 認證、PII 與稽核

訪客可讀公開公告、展示 metadata、問答與痛點；不可互動、下載 HTML、使用 AI。通關 RPC 在資料庫更新驗證狀態，前端不能修改 profile role 或驗證旗標。所有內容寫入經 Functions PII guard，瀏覽器無直接寫入 grants；service-only RPC 再檢查 owner 與 verified，投票／共鳴原子更新。

前後端共用 Regex：

```text
身分證：[A-Z][12]\d{8} (gi)
病歷號：(?:病歷號|MRN|Chart\s*No\.?|病患編號)[:：\s#-]*\d{6,10} (gi)
姓名：(?:病患|病人|個案|患者)[\u4e00-\u9fa5]{2,4} (g)
床號：\b\d{1,2}[A-Z]-\d{1,2}\b|ICU-\d{2} (gi)
手機：09\d{2}[-\s]?\d{3}[-\s]?\d{3} (g)
```

獨立日期與 URL 數字不觸發 MRN。掃描文字包含 HTML entity 解碼檢查；不支援圖片 OCR 或完整醫療去識別化。

瀏覽器在任何使用者內容送出前先掃描，顯示命中類型與片段，三選一：遮罩後送出／勾選責任確認後放行／返回修改。後端未授權 override 時回傳 422 `PII_DETECTED`，附 detected_items。明確 `force_override: true` 需寫入稽核後才能寫入內容；稽核只保留類型不保留原文。MCP 錯誤使用工具執行的 JSON-RPC `isError` 格式，保留同樣 code 與 detected_items。

## 資料模型與 RLS

主要表格：profiles、user_api_tokens、announcements、registrations、spaces、space_qa、pain_points、user_votes、pii_override_logs。

必要擴充：

- meetup_sessions：活動日期、時間、地點、學分、active 狀態。
- space_slides：大型 HTML 與 public metadata 分表，以便在資料庫層限制原始碼下載。
- vibe_events：共鳴 Realtime 事件與限流依據。
- passcode_attempts：每 15 分鐘最多 10 次通關嘗試。
- api_rate_limits：AI 每小時最多 10 次。
- qa_public：只提供安全公開欄位的 view，匿名作者不外洩。

registrations 唯一鍵採 `(user_id, session_id)`，修正原 schema 的全域 user_id unique 限制。痛點增加 department 以支援科別搜尋。議程按場次與順序唯一。實際完整 DDL、索引、Trigger、RPC、grants 與 RLS 以 `supabase/migrations/001_init_schema.sql` 為準。

展示列表嚴禁 SELECT *，查詢明確欄位且不包含大型 HTML；只有點擊投影才非同步要求 HTML。受信任後端使用 service role，必須逐端點驗證角色與所有權，不能假設 service role 仍受 RLS 保護。

## API 與 MCP 介面

| 類型         | 名稱                        | 權限                              |
| ------------ | --------------------------- | --------------------------------- |
| REST GET     | /api/v1/spaces              | 公開 metadata                     |
| REST GET     | /api/v1/spaces/{id}/slides  | 已通關且公開或自己擁有            |
| REST POST    | /api/v1/spaces              | 已通關 owner 寫入                 |
| REST POST    | /api/chat                   | 已通關，PII guard，限流           |
| MCP Resource | meetup://spaces/public      | 公開清單與高票 Q&A                |
| MCP Resource | meetup://spaces/{id}/slides | 已通關且公開或自己擁有            |
| MCP Tool     | search_pain_points          | 公開唯讀                          |
| MCP Tool     | upsert_my_space             | 個人 Token，owner-only，PII guard |
| MCP Tool     | post_slido_question         | 個人 Token，公開展示，PII guard   |

原文對「公開 MCP HTML 原始碼」與「訪客不可下載原始碼」有衝突；本版採後者，要求已通關身分。原始碼分享保留給院內驗證同仁。

## 驗收與部署邊界

程式包含本機預覽、安全測試、瀏覽器測試與 SQL RLS 測試。真實 Google OAuth、Supabase Realtime、雲端 LLM、Netlify Functions 執行與院內識別證整合需要正式帳號／設定驗收。未自動建立外部專案或更改 repository private 設定。設定與已知限制見 README。
