# Notification System Fixes

## Summary

Fixed two critical gaps in the post notification system:

1. **Sharing/reposts now create notifications** - Both reposts and quotes now notify the original post author
2. **Quote captions are parsed for mentions** - Any `@username` in a quote's caption now creates mention notifications
3. **Push notifications added for post mentions** - Mentions in posts, comments, and quotes now send push notifications (previously only in-app)

## Changes Made

### 1. Added Share Notifications (`velo-socket/src/socket/blog.ts`)

**Reposts:**
- Original post author receives a `type: "share"` notification when their post is reposted
- Includes push notification (respects user's "follows" notification setting)
- Skips notification if author reposts their own post

**Quotes:**
- Original post author receives a `type: "share"` notification with the quote caption as snippet
- Quote caption is parsed for `@mentions` using the same regex pattern as regular posts
- Mentioned users receive `type: "mention"` notifications
- Both share and mention notifications include push delivery
- Self-mentions and blocked users are filtered out

### 2. Push Notifications for Post Mentions

**Previously:** Only in-app/DB notifications were created for post/comment mentions  
**Now:** Push notifications are sent when:
- A user is mentioned in a regular post
- A user is mentioned in a comment
- A user is mentioned in a quote caption

**Delivery Rules:**
- Respects user's "mentions" notification preference
- Skips users who blocked the author
- Only sends to offline users (checked via Redis presence)
- Deduplicated by post/comment ID to prevent spam
- Uses `messagePreview()` to truncate long captions for the push body

### 3. Type System Updates

**`velo-socket/src/types.ts`:**
- Added `'share'` to `NotificationType` union type
- Now: `'like' | 'comment' | 'follow' | 'mention' | 'share'`

## Technical Implementation

### Helper Functions Added

```typescript
sendMentionPushNotification(params: MentionPushParams): Promise<void>
```
- Checks notification preferences and block status
- Sends push via `deliverPush()` with deduplication
- Tag: `mention:{postId}`

```typescript
sendSharePushNotification(params: SharePushParams): Promise<void>
```
- Differentiates between reposts and quotes in the message
- Tag: `share:{postId}`
- Uses "follows" preference setting (treats shares as engagement notifications)

### Dependencies Added

- `redis` from `../redis.js` - for presence checks and dedup
- `deliverPush`, `messagePreview` from `../push.js` - push delivery
- `loadNotificationPreferences` from `../notifications/settings.js` - user prefs

## Behavior Notes

### Mention Parsing Limitations (unchanged)

The existing mention regex only recognizes `@[a-zA-Z0-9_]+`:
- Usernames with `.` or `-` are truncated at that character
- No autocomplete picker exists in the post composer (only in chat)
- Users must type exact handles manually

### Notification Grouping

- Share notifications group by `share:post:{targetId}` in the UI
- Mention notifications group by `mention:post:{postId}` or `mention:comment:{commentId}`
- This allows multiple actors to be shown together (e.g., "Alice and 3 others mentioned you")

### Error Handling

All notification writes are best-effort with try/catch:
- Errors logged to console with context (e.g., `Error writing quote notifications:`)
- Failures don't block the share/post creation
- Check MongoDB `Notifications` collection and socket logs to debug

## Testing Checklist

- [ ] Repost a post → original author gets in-app + push notification
- [ ] Quote a post with caption → original author gets notification with snippet
- [ ] Quote with `@username` → mentioned user gets mention notification + push
- [ ] Mention user in regular post → user gets in-app + push notification
- [ ] Mention user in comment → user gets in-app + push notification
- [ ] Self-mention does not create notification
- [ ] Blocked users don't receive notifications
- [ ] Online users don't receive push (only in-app)
- [ ] Users with mentions disabled don't get push for mentions
- [ ] Users with follows disabled don't get push for shares

## Migration Notes

**Existing deployments must:**
1. Rebuild `velo-socket` with `npm run build`
2. Restart the socket server to load the new handlers
3. No database migration needed (new notification type is backward compatible)
4. Frontend already handles unknown notification types gracefully

**Optional follow-up:**
- Add UI for "share" notification type in the notifications list
- Currently displays with generic formatting; could show "reposted your post" vs "quoted your post"
- Add notification preference toggle for "shares" (currently uses "follows" setting)
