# F14 個人參與紀錄 `participation_history`

Migration `027_participation_history.sql`; tests `tests/participation_history.sql`. No points/credits.

## 權限

- 已驗證同仁，flag 開啟才可用；只回傳呼叫者本人資料（管理員也不例外）。

## RPC

- `my_participation(p_limit,p_offset)`：時間軸（活動報名/出席含候補、午餐聚會、我的展示（含私人）、投稿、發起活動、已填回饋）。投稿/發起活動/回饋/投票僅在各自 flag 開啟時計入。
- `my_participation_summary()`：各項總數，含討論串/回覆數、投票數與公開設定。
- `set_participation_visibility(p_show)`：寫入 `participation_visibility`（預設不公開）。
- `member_participation_summary(p_user)`：僅在對方已選擇公開、已列於名錄、`member_directory` 與本功能 flag 皆開、雙方未封鎖時，回傳 `{events_attended,talks_given,threads_started}` 三個彙總數；否則回傳 null。

## UI

「我的參與」頁（月份分組時間軸、統計卡、公開開關）。`renderParticipationBadge(container,userId,ctx)` 可由 member_directory 卡片呼叫（尚未接線；需要時加一行 guarded call）。

## 部署

套用 027 後於後台開啟 `participation_history`；關閉 flag 不刪資料。
