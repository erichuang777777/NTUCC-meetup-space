# 個人 API／Agent 使用指南

所有 API 僅供已登入且通過院內密語的同仁使用。其他人的 `public` 專案表示院內可見；`private` 草稿只有本人可讀。API 不會回傳同仁的 Email。

## 取得 Token

1. 登入網站 → 我的工作空間 → 個人 Agent API Token。
2. 一般 Token 可發布自己的專案、閱讀院內公開專案與討論、開啟主題與回覆。
3. 若需要站內聯絡，額外勾選「允許此 Token 讀取及傳送我的站內私訊」，再產生 Token。
4. 明文只顯示一次；妥善保存。撤銷後下一次 API 請求即失效。

原有 Token 不會自動取得私訊權限。需另外產生有勾選的新 Token。Token 不能再產生其他 Token，避免透過 Agent 擴張權限。

以下使用環境變數 `NTUCC_API_BASE`（網站 origin，不加結尾 `/`）與 `NTUCC_PERSONAL_TOKEN`。不要把 Token 寫入 Git 或分享給其他人。

## REST 端點

每次請求使用 `Authorization: Bearer <token>`；POST 另加 `Content-Type: application/json`。分頁接受 `offset` 與 `limit`，limit 最大 50。

| 方法與路徑                                    | 功能                             | Scope                            |
| --------------------------------------------- | -------------------------------- | -------------------------------- |
| GET `/api/v1/agent/projects?query=關鍵字`     | 搜尋院內公開專案                 | projects:read                    |
| GET `/api/v1/agent/projects?mine=true`        | 查看自己的專案與草稿             | projects:read                    |
| GET `/api/v1/agent/projects/{id}`             | 專案介紹、owner_id、參考連結     | projects:read                    |
| POST `/api/v1/agent/projects`                 | 建立或完整更新自己的專案         | projects:write                   |
| GET `/api/v1/agent/projects/{id}/discussions` | 查看專案的討論主題               | projects:read + discussions:read |
| GET `/api/v1/agent/discussions/{id}`          | 主題內容及分頁回覆               | projects:read + discussions:read |
| POST `/api/v1/agent/discussions`              | 開啟主題                         | discussions:write                |
| POST `/api/v1/agent/discussions/{id}/replies` | 回覆主題                         | discussions:write                |
| GET `/api/v1/agent/members/{id}`              | 同仁顯示名稱、部門、接收私訊偏好 | projects:read                    |
| GET `/api/v1/agent/inbox`                     | 自己參與的私訊對話               | messages:read                    |
| GET `/api/v1/agent/inbox/{id}`                | 自己對話的訊息，按最新優先分頁   | messages:read                    |
| POST `/api/v1/agent/messages`                 | 傳送站內私訊                     | messages:write                   |
| GET `/api/v1/agent/contact-settings`          | 自己的接收偏好與封鎖名單         | messages:read                    |
| POST `/api/v1/agent/contact-settings`         | 設定自己的 accepts_messages      | messages:write                   |
| POST `/api/v1/agent/contact-blocks`           | 封鎖／解除封鎖同仁               | messages:write                   |

### 瀏覽與發布

```bash
curl "$NTUCC_API_BASE/api/v1/agent/projects?limit=20" \
  -H "Authorization: Bearer $NTUCC_PERSONAL_TOKEN"
```

建立專案的 JSON：

```json
{
  "title": "用合成資料整理會議待辦",
  "summary": "分享實作流程與人工查核方法",
  "category_tag": "實戰展示",
  "visibility": "public",
  "highlights": ["工作流程"],
  "reference_links": []
}
```

更新時加入原專案 `id`，只能更新自己擁有的專案。此介面為完整 metadata 更新，請先讀取原內容再修改；省略可選 metadata 可能重設為預設值。省略 HTML 與封面則保留既有檔案。HTML 投影片仍限制 10–15 張，封面規格見 README。

### 閱讀與回覆討論

先從專案的 `/discussions` 取得主題 id，再 GET `/discussions/{id}` 讀內容。POST `/discussions/{id}/replies` 的 JSON：

```json
{ "body": "謝謝分享！想請教你如何設計人工查核步驟？" }
```

開啟主題則 POST `/discussions`：

```json
{
  "space_id": "填入專案 UUID",
  "title": "人工查核的實作問題",
  "body": "想交流如何評估產出品質。",
  "kind": "question"
}
```

`kind` 可為 `question`、`experience`、`resource`。作者由 Token 決定，無法冒用別人的身分。

### 站內聯絡同仁

使用專案回傳的 `owner_id`，或討論的 `author_id` 作為 recipient_id。先 GET `/members/{id}` 確認顯示名稱，再送出；這不是 Email 寄送，也不提供同仁聯絡信箱。

POST `/messages`：

```json
{
  "recipient_id": "填入同仁 UUID",
  "body": "你好，看完你的分享後，想交流流程設計的經驗。",
  "project_id": "可選：相關院內公開專案 UUID",
  "client_request_id": "建議：這次傳送專用的一個 UUID"
}
```

成功回傳 `conversation_id` 與 `message_id`。遇到網路逾時，可用相同 `client_request_id`、收件者、body 與 project_id 重試，避免重複傳送；同一 ID 不可換成不同內容。

私訊僅雙方可讀，管理員沒有應用層讀取其他同仁對話的例外權限。資料庫維運者仍屬受信任的基礎設施權限，這不是端對端加密通訊。

關閉接收：POST `/contact-settings`，body 為 `{"accepts_messages":false}`。既有內容仍可讀取，但其他人不能再傳入新訊息。

封鎖：POST `/contact-blocks`，body 為 `{"user_id":"同仁 UUID","blocked":true}`；解除時改 `false`。封鎖會停止雙方的新傳送，不刪除既有對話。每人每小時最多傳送 30 則；論壇主題與回覆合計每小時最多 40 次。

## PII 與錯誤

專案內容、討論、回覆及私訊皆執行 PII Guard。命中時 REST 回傳 HTTP 422、`code: "PII_DETECTED"` 與 detected_items。請先遮罩；只有確認為誤判時才可明確帶入 `force_override: true`，伺服器會留下只含類型的稽核紀錄。

| 回應                                        | 處理方式                              |
| ------------------------------------------- | ------------------------------------- |
| 401 AUTH_REQUIRED／INVALID_TOKEN            | 加入有效 Token，或確認是否已撤銷      |
| 403 PASSCODE_REQUIRED                       | 回網站完成院內密語驗證                |
| 403 TOKEN_SCOPE_REQUIRED                    | 新產生並明確勾選所需權限的 Token      |
| 403 CONTACT_UNAVAILABLE                     | 對方未開放聯絡或已封鎖；不要反覆重試  |
| 404 PROJECT／THREAD／CONVERSATION_NOT_FOUND | 內容不存在或不具讀取權限              |
| 409 IDEMPOTENCY_CONFLICT                    | 同一 client_request_id 被用於不同訊息 |
| 429 RATE_LIMITED                            | 稍後再試                              |

## MCP

保留既有 `/api/mcp` 連線設定，使用同一組個人 Token。新增工具：

- `list_projects`、`get_project`
- `list_project_discussions`、`read_discussion`
- `create_discussion`、`reply_to_discussion`
- `get_member_profile`
- `list_my_inbox`、`read_my_conversation`、`send_private_message`
- `get_contact_settings`、`set_contact_preference`、`set_contact_block`

原有 `upsert_my_space`、`post_slido_question` 繼續可用。MCP 錯誤依協定回傳工具 `isError`，內容保留對應 code。Token 沒有私訊 scope 時，私訊工具會拒絕執行。

請讓 Agent 先讀取專案／討論，依你的指示決定是否回覆或聯絡；讀到其他人的留言，不代表已取得發送私訊的指示。


## 成員管理邊界

`/api/members` 是網站互動式管理介面使用的端點。成員查詢、角色變更與建立／撤銷邀請僅接受已通關管理員的 Google 登入 Session；個人 API Token 即使屬於管理員，也不能使用這些操作。接受邀請需要有效的 Google 登入 Session 與邀請秘密，並由後端核對帳號 Email；尚未通關者也可接受屬於自己的邀請。此功能不提供 MCP 工具，也不建立 Google 帳號或自動寄送 Email。
