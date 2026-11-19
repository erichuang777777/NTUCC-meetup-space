# F6 論壇強化 (`forum_plus`)

Flag key `forum_plus` (default off). Migration `supabase/migrations/019_forum_plus.sql`, tests `tests/forum_plus.sql`.
Requires migrations 013-018. With the flag off nothing changes: triggers no-op, RPCs raise `FEATURE_DISABLED`, existing views and server functions are untouched. Turning it off keeps all data.

## What

- **@mentions**: on thread/reply insert, `@<display_name>` is matched against verified members. Duplicate (ambiguous) or unknown names are ignored; the longest matching name wins. Rows go to `discussion_mentions` and a `forum_mention` notification is sent. Skipped: self, blocked pairs (`contact_blocks`, either direction), content hidden by moderation or not visible to the mentioned user.
- **Helpful votes**: `discussion_reactions` (one per user per target). `toggle_helpful(p_type 'thread'|'reply', p_id)` returns the new count.
- **Best answer**: `discussion_threads.accepted_reply_id`. `set_accepted_reply(p_thread, p_reply)` — thread author or admin; reply must belong to the thread (else `INVALID_REPLY`); `null` clears. Accepting marks the thread resolved and notifies the reply author (`forum_accepted`).
- **Follow**: `discussion_follows`; the author auto-follows on creation. `toggle_follow_thread(p_thread)` returns whether the caller now follows. New replies notify followers (`forum_followed_reply`) except the replier, blocked pairs, and the thread author (already covered by F1 `discussion_reply`); users notified by a mention in the same reply are not notified twice.
- **Pinned / featured**: `set_thread_flags(p_thread, p_pinned, p_featured)` admin only (null = unchanged). `is_pinned` already existed and lists already sort pinned first; `is_featured` is new.
- `mention_suggestions(p_prefix)` returns up to 8 verified members (display_name, department).

## Read API

The `discussion_*_read` views are not re-created (so 018's hide condition stays). Use `forum_plus_threads(p_ids)` (is_pinned, is_featured, accepted_reply_id, helpful_count, helpful_mine, following) and `forum_plus_replies(p_ids)` (helpful_count, helpful_mine). Both are visibility/moderation aware.

## Permissions

All RPCs: verified member + flag on. `set_thread_flags`: admin. `set_accepted_reply`: thread author or admin. Direct table writes are denied; members can read reactions, and only their own mentions/follows.

## UI

`public/features/forum_plus.ts` (+ css) with hooks in `public/forum.ts`: 👍 有幫助, ✅ 最佳解答, 追蹤, 📌/⭐ badges and admin controls, @mention dropdown in the thread and reply composers. Notification types added to `NOTIFICATION_TYPES`.

## Deploy

Apply 019, then enable `forum_plus` (and `notifications` for notices) in the admin feature-flag panel. No server/env changes; `netlify/functions/shared/discussions.ts` is unchanged (it returns no thread lists).
