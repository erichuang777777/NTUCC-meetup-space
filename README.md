> 更新：分享與問答已改為院內成員限定。訪客與尚未通關的帳號不可讀取任何活動／分享內容；下方早期「公開唯讀」說明由此更新取代。public visibility 現在代表「已驗證院內成員可見」。
>
> 已執行 001 的專案：請另行在 Supabase SQL Editor 執行 `supabase/migrations/002_members_only.sql`，無須重跑 001。新專案須依序執行 001、002。Netlify 也需部署本次 API 更新。

# NTUCC Meetup Spaces

公布欄以單一公告清單呈現，管理員發布僅需標題、內容與置頂選項，不提供分類篩選。既有公告保留顯示，新公告統一使用活動公告類型；不需執行新的資料庫 migration。

臺大癌醫內部交流與 AI 展示空間。單一講者、10 分鐘展示、Slido 問答、痛點許願池與雙層 PII 防護。

## 本機啟動

需要 Node.js 22+。

```bash
npm ci
cp .env.example .env
npm run dev
```

首頁先顯示登入畫面，Google 登入後預設進入公布欄，功能導覽以底部 SVG 圖示列呈現。僅本機開發環境未設定 Supabase 時可透過登入頁的「預覽介面」進入**示例預覽模式**，所有示例卡片都有整體模式提示，不會寫入資料。`npm run dev` 只提供前端；需要 API 時用 Netlify CLI 的 `netlify dev`，並將 `APP_ORIGIN` 設為實際本機來源（例如 `http://localhost:8888`）。

## Supabase 設定

1. 建立 Supabase 專案，在 SQL Editor 依序執行 [001 migration](supabase/migrations/001_init_schema.sql) 與 [002 migration](supabase/migrations/002_members_only.sql)。新專案需啟用 Vault（標準 Supabase 專案已提供）、pgcrypto、Realtime。不要在既有正式資料庫重複執行初始 migration。
2. 在 Supabase Dashboard 的 Vault 建立 secret：名稱 `ntucc_passcode`，值為院方自行設定的通關密語。勿把密語放入前端或 Git。
3. 啟用 Google OAuth，設定 Google OAuth client、Supabase callback URI、Site URL，以及 Netlify 網站／本機 Redirect URLs。
4. 先用 Google 登入建立 profile，再由維運者在 SQL Editor 指定管理員：

```sql
update public.profiles set role = 'admin'
where email = 'YOUR_ADMIN_EMAIL';
```

管理員仍須完成通關驗證。前端不能設定 role 或 passcode_verified。
5. 在 Supabase API 設定中確認 exposed schema 為 `public`。不要對匿名角色額外授予資料表寫入權限、`space_qa` 讀取權限或 privileged RPC execute 權限。

## Netlify 部署

連結此 GitHub 儲存庫，保留既有的 `netlify.toml`。儲存庫是否設為 Private 由擁有者於 GitHub 設定；本實作未變更 repository visibility。

| 環境變數                    | 用途                                                            |
| --------------------------- | --------------------------------------------------------------- |
| `VITE_SUPABASE_URL`         | 前端 Supabase URL                                               |
| `VITE_SUPABASE_ANON_KEY`    | 前端公開 anon/publishable key；不是 service role key            |
| `SUPABASE_URL`              | Functions 使用的 Supabase URL                                   |
| `SUPABASE_SERVICE_ROLE_KEY` | 僅 Functions 可讀的機密金鑰                                     |
| `APP_ORIGIN`                | 正式網站 origin，無尾斜線，例如 `https://YOUR_SITE.netlify.app` |
| `CLOUD_LLM_BASE_URL`        | HTTPS OpenAI 相容 `/v1` base URL                                |
| `CLOUD_LLM_API_KEY`         | 僅 Functions 可讀                                               |
| `CLOUD_LLM_MODEL`           | 模型名稱，預設 `gpt-4.1-mini`                                   |

`VITE_*` 在建置時注入；更新後需要重新部署。不要把 service key 或 LLM key 加上 `VITE_` 前綴。正式站台名稱必須在 Netlify 確認可用，程式不假設固定 hostname。

部署後驗收：Google 登入 → 通關 → 私人草稿 → 上傳 10–15 頁 HTML → 本機 PII 確認 → 公開展示 → 問答、投票與共鳴 → 管理員新增場次、排程與報到。以第二個帳號及登出狀態確認私人草稿不可見。實際 OAuth、LLM、Realtime 與 Netlify 運行需使用真實專案驗收，本機 mock 測試不代替這一步。

## REST API

- `GET /api/v1/spaces`：已通關同仁可讀的 metadata 清單，絕不含 HTML。
- `GET /api/v1/spaces/{uuid}/slides`：已通關 Bearer 身分可讀公開展示，或自己的私人草稿。
- `POST /api/v1/spaces`：以原始 JSON 建立或完整更新自己的展示；`id` 省略表示建立。更新時未提供的可選 metadata 會採預設值；省略 `html_slides` 保留原投影片。僅允許 HTTPS 參考連結。

```json
{
  "title": "我的小實驗",
  "summary": "使用合成資料示範流程改善",
  "category_tag": "實戰展示",
  "visibility": "private",
  "highlights": ["合成資料"],
  "reference_links": [],
  "force_override": false
}
```

使用 `Authorization: Bearer ntucc_sk_...`。Token 在「我的工作空間」產生，僅顯示一次；資料庫僅儲存 SHA-256。呼叫者仍須保持 `passcode_verified`，撤銷立即生效。Token 等同個人寫入權限，請勿放入共享電腦或版本控制。

其他前端操作使用同一閘道 `{ "action": "question", "payload": {...}, "force_override": false }`；由後端驗證身分、角色、所有權與欄位，不信任前端旗標。`PII_DETECTED` 回傳 HTTP 422 與 detected_items。只有嚴格布林 `force_override: true` 可以放行；稽核僅保存類型、帳號與來源，不保存匹配原文。

## Remote MCP

端點 `/api/mcp`，無狀態 Streamable HTTP，僅 POST；GET 為 405，OPTIONS 供 CORS preflight。每次請求建立獨立 server/transport，沒有 Session ID。

```json
{
  "mcpServers": {
    "ntucc-meetup-spaces": {
      "url": "https://YOUR_SITE.netlify.app/api/mcp",
      "transport": "streamable-http",
      "headers": { "Authorization": "Bearer ${NTUCC_PERSONAL_TOKEN}" }
    }
  }
}
```

提供 `meetup://spaces/public`、`meetup://spaces/{id}/slides`、`search_pain_points`、`upsert_my_space`、`post_slido_question`。所有 MCP 請求皆要求已通關 Token，投影片原始碼依門禁規則要求已通關 Token。MCP tool 執行錯誤依 JSON-RPC 回傳 `isError`，其中包含 `PII_DETECTED` 與 detected_items；REST 則使用 HTTP 422。

**協定相容性**：鎖定的官方 MCP SDK 最新協商版本為 `2025-11-25`，支援 `WebStandardStreamableHTTPServerTransport` 與 `sessionIdGenerator: undefined`。原規格列出的 `2026-07-28` 不在這個 SDK 的支援清單，沒有偽造該版本。需要升級 SDK 並重新執行互通驗收後，才能宣告支援該日期。

## 安全與目前限制

- Private draft 的 RLS 不含 admin 例外；service role 是受信任後端能力，必須保護。資料庫擁有者仍具有維運層存取權，不能將 RLS 描述為對 DBA 的加密隔離。
- 大型 HTML 分表，防止訪客透過直接 Supabase SELECT 下載原始碼。公開問答由不含 author_id 的投影 view 提供；底層問答表不對客戶端開放。匿名表示對同仁匿名，後端仍保留 author_id 供權限與稽核使用。
- HTML 在 `sandbox="allow-scripts"` 的 opaque-origin iframe 呈現，沒有 allow-same-origin。剝除講者的任意 JS、inline handlers、iframe、form、外部導向連結；只載入站方控制的翻頁 runtime。限制外部載入的 CSP 置於文件開頭。**目前不執行講者自訂 JavaScript**，因此互動指站方翻頁／計時／問答／共鳴；複雜 HTML app 需另行安全設計。自包含 CSS、內嵌圖片可用。
- PII Regex 是提示與人工確認機制，並非完整去識別化保證。未涵蓋 OCR、圖片文字、所有 Unicode 混淆或任意程式碼編碼。禁止放入真實病患資料；請用合成資料。
- AI 每人每小時最多 10 次；共鳴每分鐘最多 30 次。其他已驗證寫入目前無完整防濫用配額，正式上線可依活動規模配置平台限流。
- 報名唯一鍵改為 `(user_id, session_id)`，避免一人終生只能報名一場。活動開始時間以院內當地時間（建議臺灣時間）輸入，不作使用者時區轉換。
- QR 相機掃描與貼上均可用；同仁自助掃描本期報到 URL，管理員掃描 UUID 型識別證。院內實際員工證格式、員工編號對應與外部身分系統尚未提供，未宣稱已完成該院務系統串接。現場 URL 可被轉傳，目前不保證實體在場。
- 工作人員使用 admin 權限；排入本期的講者可查看本期報名名單並協助報到。CSV 匯出限 admin。
- 報到與共鳴使用 Supabase Realtime；問答每 10 秒同步，Q&A 階段將最高票未回答問題顯示於投影角落。報名統計提供即時訂閱更新。全院分享僅限登入且通過院內密語的同仁瀏覽；訪客不可讀取活動、分享、問答或痛點。
- 尚未部署、建立外部專案、修改 repository 可見性或注入正式密鑰。

## 驗證

```bash
npm run build
npm test
npx playwright install chromium
npm run test:browser
npm audit
```

`tests/rls.sql` 需在**隔離的 Supabase 測試資料庫**執行，會在 transaction 中插入合成帳號後 rollback；不可對正式 auth schema 隨意執行。涵蓋 owner/admin/guest 隔離、角色與通關防繞過、Token 欄位、匿名身分與重複投票。一般 PostgreSQL 可用 `tests/postgres-bootstrap.sql` 建立 Supabase auth/Vault 測試替身；此替身只驗證 SQL，不驗證真正 Supabase Auth/Vault 服務。

完整規格與實作取捨見 [SPEC.md](SPEC.md)。

## 圖片探索與專案討論區

分享舞台改為圖片探索，可左右滑動封面或切換圖片總覽。每份 Space 對應獨立專案頁：專案頁以討論為主，介紹、資源與原有講者 Q&A 按需展開。既有 Q&A 不搬移也不遺失。

每個專案可開啟多個主題，分為提問、實作心得、資源分享；可回覆、依最近活躍／最新排序、搜尋標題。主題每頁 20 筆，回覆每頁 50 筆，提供手動更新。專案擁有者與 admin 可置頂、標記已解決、隱藏主題或回覆；隱藏採軟隱藏，不刪除資料。論壇使用具名身分，現場 Q&A 保留匿名選項。

**已有專案請在部署新程式前執行 `supabase/migrations/003_project_discussions.sql`**（前提為已執行 001、002），以加入論壇資料表、權限、計數 Trigger 與封面欄位。新專案須依序執行全部 migrations。不要重跑初始 migration。

封面支援 JPG／PNG／WebP，瀏覽器在本機將圖片縮至最長寬 960×640 範圍並壓縮，最大約 165 KB（220,000 字元 data URI）。清單只查詢是否有封面的旗標；圖片捲入可視範圍後，才透過受 RLS 保護的查詢非同步載入小型封面，仍不載入 HTML 投影片。沒有封面使用標示「示意封面」的站方圖像。圖片內容不經 OCR；上傳者須確認不含病患資料，文字討論及回覆則使用既有雙層 PII 檢查。

新增 API action：`thread_create`、`thread_reply`、`thread_moderate`，均要求已通關 Bearer 身分；發布與回覆合計每人每小時最多 40 次。所有作者與 moderator 身分由伺服器決定，前端不得直接寫入資料表。私人草稿的討論資料即使對 admin 也不開放，發布後才開啟互動。論壇提供 `#project/{uuid}` 與 `#project/{uuid}/thread/{uuid}` 深連結；訪客仍需先登入與通關。

Sites／本機示例中的論壇新增與回覆僅保留在當次頁面預覽的記憶體，重新整理會還原，並不假裝已寫入正式 Supabase。SQL 權限與計數驗證見 `tests/discussions.sql`。

## 個人 Agent API 與站內聯絡

新增 `/api/v1/agent/*` 和 MCP 對應工具，供同仁以個人 Token 發布自己的專案、閱讀院內公開專案與討論、開啟主題及回覆。專案頁可「聯絡分享者」，底部「同仁訊息」可查看自己的私訊、設定接收偏好及封鎖對方。

**部署前請依序確認 001、002、003 已執行，再執行 `004_agent_contacts.sql`**。這會新增私訊資料表、RLS、聯絡偏好、封鎖與 Token scopes。既有 Token 預設只有專案／討論權限，不會自動取得私訊權限；需在工作空間產生新 Token 時額外勾選。Token 管理限互動登入，既有 Token 無法再產生權限更高的 Token。

完整端點、範例、MCP 工具與錯誤說明見 [API_GUIDE.md](API_GUIDE.md)。私訊只對雙方開放，admin 沒有讀取其他人對話的例外；不公開 Email、不發送 Email。發送、封鎖、限流與重試去重在資料庫內執行，私訊內容仍經 PII Guard。

## 極簡介面

頁面改為白底與清單，移除重複標語、卡片外框及多餘按鈕。探索頁以圖片與標題為主，篩選使用單一選單；專案頁直接呈現討論，介紹與 Q&A 以摺疊區塊展開。投影、聯絡與管理功能收在「⋯」選單；個人資料及 Agent 設定也預設收合。這次只調整介面，不需新增 SQL 或環境變數。
