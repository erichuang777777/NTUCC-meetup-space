# 功能開關（Feature Flags）與共用基礎

Phase 0 的共用基礎：功能開關、站內通知核心、前端功能註冊機制。所有新功能預設**關閉**，管理員於「管理後台 → 功能開關」即時切換；關閉不刪除資料。

## 機制

### 資料庫（migration `013_feature_flags.sql`）

| 物件                                                                      | 說明                                                                                                                                                                                 |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `feature_flags`                                                           | `key` 主鍵、`enabled`（預設 false）、`label`、`description`、`updated_by`、`updated_at`。已 seed 全部 15 個 key。已驗證成員可讀，無任何直接寫入權限。                                |
| `feature_flag_events`                                                     | 切換稽核（flag_key, enabled, actor_id, created_at），僅管理員可讀。                                                                                                                  |
| `is_feature_enabled(p_key)`                                               | stable、security definer；未知 key 回傳 false。授權給 `authenticated`、`service_role`；**不授權 anon**（避免匿名者探測功能清單）。                                                   |
| `set_feature_flag(p_key, p_enabled)`                                      | 僅 `is_admin()`；錯誤碼 `ADMIN_REQUIRED`、`UNKNOWN_FEATURE`；寫入 `updated_by` 並新增稽核列。                                                                                        |
| `notifications`                                                           | 站內通知。使用者只能讀自己的列（且需 `is_verified()`），無直接 insert/update/delete。                                                                                                |
| `notify(p_user, p_type, p_title, p_body, p_link, p_payload)`              | `notifications` flag 關閉時 no-op 並回傳 null。`link` 必須以 `/` 或 `#` 開頭，否則 `INVALID_LINK`。**僅授權 `service_role`**，供其他 security definer 函式呼叫；使用者不能直接呼叫。 |
| `mark_notifications_read(p_ids uuid[])` / `mark_all_notifications_read()` | 使用者標記自己的通知已讀，回傳更新筆數。                                                                                                                                             |

`notifications` 已加入 `supabase_realtime` publication（可重複執行）。

### 三層強制

1. **資料庫**：功能相關 RLS policy / RPC 加上 `is_feature_enabled('<key>')`。
2. **Functions / REST / MCP**：`netlify/functions/shared/features.ts`
   - `isFeatureEnabled(db, key)`：呼叫 RPC，記憶體快取 15 秒，錯誤時視為關閉。
   - `requireFeature(db, key)`：關閉時拋出 `HttpError(404, "FEATURE_DISABLED", { feature })`，經 `fail()` 回應 `404 { code: "FEATURE_DISABLED", feature }`。
3. **前端**：`public/features.ts`（`loadFeatureFlags(client)`、`isEnabled(key)`、`allFlags()`）。無 Supabase client 的示例預覽模式下所有 flag 視為開啟（僅供預覽，正式環境不會發生）。若讀取失敗（例如尚未執行 013）則全部視為關閉。

### 前端註冊（`public/feature-registry.ts`）

```ts
registerFeature({
  key: "polls",                                  // 對應 feature_flags.key
  nav?: { id, label, iconPath },                 // 導覽項目（顯示在「更多」選單）
  render?(container, ctx),                       // page === nav.id（無 nav 時為 key）時呼叫
  adminPanel?: { id, label, render(container, ctx) },  // 管理後台額外面板
  topbar?(ctx): HTMLElement | null,              // 放入 .top-actions（例如鈴鐺）
});
```

`ctx`（`FeatureCtx`）：`client`、`user`、`profile`、`demo`、`isAdmin`、`esc`、`toast`、`run(fn)`、`review(payload)`、`navigate(page)`、`isEnabled(key)`。

- `ctx.review` 就是 `app.ts` 送出前使用的 PII Guard：掃描 payload，若有個資則開啟 `#pii` 對話框；回傳 `{ payload, force_override }`（可能已遮罩），使用者取消則回傳 `null`。所有自由文字送出前都必須經過它，後端另有 PII Guard。
- 只有 flag 開啟的功能才會出現在導覽、頁面路由、topbar 與管理後台。
- 基礎導覽項目維持原樣；功能導覽項目一律收納在「更多」選單，避免導覽列過長。

## 新增功能模組檢查清單

**DB**

- [ ] `supabase/migrations/0NN_<key>.sql`（增量，使用預先分配編號）
- [ ] RLS policy 與 RPC 加上 `is_feature_enabled('<key>')`
- [ ] 需要通知時呼叫 `notify(...)`（security definer 函式內）
- [ ] `tests/<key>.sql`（含 flag 關閉被拒案例），並加入 `.github/workflows/ci.yml`

**API**

- [ ] Function handler 開頭 `await requireFeature(db, "<key>")`
- [ ] 自由文字經後端 PII Guard
- [ ] `tests/<key>.test.ts`

**UI**

- [ ] `public/features/<key>.ts` 呼叫 `registerFeature`
- [ ] 在 `public/features/index.ts` 加一行 `import "./<key>";`
- [ ] 送出前使用 `ctx.review`
- [ ] 以 `ctx.esc` 跳脫所有動態內容

## 部署

1. 在 Supabase SQL Editor 執行 `supabase/migrations/013_feature_flags.sql`（需先完成 001–012）。
2. 部署後所有 flag 為關閉，現有行為不變。
3. 以管理員登入，到「管理後台 → 功能開關」逐項開啟。
