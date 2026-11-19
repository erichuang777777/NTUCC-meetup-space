# F2 同仁名錄 `member_directory`

Migration: `supabase/migrations/015_member_directory.sql` · Tests: `tests/member_directory.sql` · UI: `public/features/member_directory.ts`

## 功能

- 同仁可自願（opt-in，預設不公開）公開簡介（≤500 字）、專長標籤（≤10 個、每個 ≤20 字，自動去除空白與重複）、「歡迎請教」開關與主題（≤200 字）。
- 名錄頁：關鍵字搜尋、科別篩選、標籤篩選；名片上的「私訊」沿用既有私訊流程（`ctx.openMessage(userId)`）。

## 權限

- 僅已驗證同仁可使用；`listed=true` 的資料才會被他人看到；本人永遠能看／改自己的資料。
- 管理員只能看到已公開資料，不能偷看未公開的資料。
- 與你有任一方向封鎖關係（`contact_blocks`）的同仁，不會出現在搜尋、標籤統計或資料表中。
- 資料表沒有任何寫入授權；一律經 `upsert_my_directory_profile`。
- 旗標關閉：所有 RPC 回 `FEATURE_DISABLED`，資料表 RLS 回 0 筆；資料不刪除。

## DB 介面

| 物件                                                                   | 說明                                                                                                             |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `member_directory_profiles`                                            | 資料表（RLS 唯讀）                                                                                               |
| `upsert_my_directory_profile(p_listed,p_bio,p_tags,p_open,p_topics)`   | 伺服端驗證長度並正規化標籤；錯誤碼 `INVALID_BIO/INVALID_TOPICS/INVALID_TAGS/PII_DETECTED`                        |
| `search_member_directory(p_query,p_department,p_tag,p_limit,p_offset)` | 回傳 user_id、display_name、department、bio、expertise_tags、open_to_questions、question_topics（limit 上限 50） |
| `member_directory_tags()`                                              | 公開同仁的標籤與人數                                                                                             |
| `member_directory_departments()`                                       | 篩選用科別列表                                                                                                   |

`PII_DETECTED`：DB 層以與 `public/pii.ts` 相同語意檢查身分證字號 `[A-Z][12]\d{8}` 與帶關鍵字的病歷號，涵蓋簡介、主題與標籤。前端送出前仍會先經 `ctx.review` PII 對話框。

## 部署

1. 套用 `015_member_directory.sql`（需已套用 001–013）。
2. 管理後台「功能開關」開啟 `member_directory`。
