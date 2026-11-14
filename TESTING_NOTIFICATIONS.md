# Testing the Notification Fixes

## Prerequisites

1. Rebuild velo-socket: `npm run build` (in the velo-socket directory)
2. Restart the socket server
3. Have at least 2 test accounts (e.g., @alice and @bob)
4. Enable push notifications in browser/app for test accounts

## Test Scenarios

### 1. Repost Notifications

**Setup:**
- Login as @alice
- Create a post: "This is Alice's post"

**Test:**
- Login as @bob
- Find Alice's post and repost it (without adding caption)

**Expected:**
- @alice receives an in-app notification: type "share", no snippet
- @alice receives a push notification (if offline): "Bob reposted your post"
- Notification appears in @alice's notifications list

**Verify:**
```javascript
// In MongoDB, check Notifications collection:
db.Notifications.find({ userId: "<alice-id>", type: "share" })
// Should return a document with:
// - actorId: <bob-id>
// - targetId: <original-post-id>
// - type: "share"
// - url: "/<alice>/posts/<post-id>"
```

### 2. Quote with Caption (No Mentions)

**Setup:**
- Login as @alice
- Create a post: "Here's my opinion on TypeScript"

**Test:**
- Login as @bob
- Quote Alice's post with caption: "I disagree! Here's why..."

**Expected:**
- @alice receives a share notification with snippet: "I disagree! Here's why..."
- @alice receives a push notification showing Bob's quote caption
- Bob's quote appears as a new post in the feed

**Verify:**
```javascript
// MongoDB:
db.Notifications.find({ userId: "<alice-id>", type: "share" })
// Should have:
// - snippet: "I disagree! Here's why..."
```

### 3. Quote with Mention

**Setup:**
- Login as @alice
- Create a post: "What do you all think?"
- Have a third user @charlie

**Test:**
- Login as @bob
- Quote Alice's post with: "I think @charlie has the best take on this"

**Expected:**
- @alice receives a share notification (with snippet)
- @charlie receives a mention notification (type "mention", targetType "post")
- @charlie receives a push notification: "Bob mentioned you"
- Both notifications appear in respective users' lists

**Verify:**
```javascript
// Alice should have share notification:
db.Notifications.find({ userId: "<alice-id>", type: "share" })

// Charlie should have mention notification:
db.Notifications.find({ userId: "<charlie-id>", type: "mention" })
// Check:
// - targetId: <quote-post-id> (Bob's quote, not Alice's original)
// - snippet: "I think @charlie has the best take on this"
```

### 4. Regular Post with Mention

**Test:**
- Login as @bob
- Create a new post: "Hey @alice, what do you think about this?"

**Expected:**
- @alice receives an in-app mention notification
- @alice receives a push notification (if offline): "Bob mentioned you" / "Hey @alice, what do you think..."

**Verify:**
```javascript
db.Notifications.find({ userId: "<alice-id>", type: "mention", targetType: "post" })
```

### 5. Comment with Mention

**Setup:**
- Login as @alice
- Create a post: "My thoughts on Rust"

**Test:**
- Login as @bob
- Comment on Alice's post: "@charlie you should read this"

**Expected:**
- @alice receives a comment notification (post owner)
- @charlie receives a mention notification (targetType "comment")
- @charlie gets push: "Bob mentioned you"

**Verify:**
```javascript
// Alice (post owner):
db.Notifications.find({ userId: "<alice-id>", type: "comment" })

// Charlie (mentioned):
db.Notifications.find({ userId: "<charlie-id>", type: "mention", targetType: "comment" })
```

### 6. Edge Cases

#### 6.1 Self-Repost
**Test:**
- @alice reposts her own post

**Expected:**
- NO notification created for Alice
- Post appears in feed but no notification entry

#### 6.2 Self-Mention
**Test:**
- @alice creates post: "I'm @alice and this is my post"

**Expected:**
- NO mention notification for Alice

#### 6.3 Blocked User
**Setup:**
- @alice blocks @bob

**Test:**
- @bob mentions @alice in a post or quote

**Expected:**
- In-app notification IS created (blocking doesn't prevent DB write)
- Push notification is NOT sent (blocked in `sendMentionPushNotification`)
- @alice doesn't see the notification in UI (filtered by frontend)

**Verify:**
```javascript
// Notification exists in DB:
db.Notifications.find({ userId: "<alice-id>", actorId: "<bob-id>" })
// But no push sent (check socket logs for "Skip if user blocked the actor")
```

#### 6.4 Quote Original Author Who's Also Mentioned
**Test:**
- @bob quotes @alice's post with: "Great point @alice"

**Expected:**
- @alice gets ONE share notification (not a duplicate mention)
- The share notification includes the snippet mentioning her

**Verify:**
```javascript
// Should have ONLY share notification, not both:
db.Notifications.find({ userId: "<alice-id>", actorId: "<bob-id>" })
// Count should be 1
```

### 7. Notification Preferences

#### 7.1 Mentions Disabled
**Setup:**
- @alice disables mention notifications in settings
  ```javascript
  db.Users.updateOne(
    { username: "alice" },
    { $set: { "notificationPreferences.mentions": false } }
  )
  ```

**Test:**
- @bob mentions @alice in a post

**Expected:**
- In-app notification IS created
- Push notification is NOT sent

#### 7.2 Follows Disabled
**Setup:**
- @alice disables follow notifications (used for shares)
  ```javascript
  db.Users.updateOne(
    { username: "alice" },
    { $set: { "notificationPreferences.follows": false } }
  )
  ```

**Test:**
- @bob reposts Alice's post

**Expected:**
- In-app notification IS created
- Push notification is NOT sent

### 8. Online vs Offline

**Test:**
- @alice is online (has active socket connection)
- @bob mentions @alice

**Expected:**
- In-app notification created and emitted via socket
- Push notification NOT sent (user is online)

**Test 2:**
- @alice logs out / closes tab
- Wait a few seconds for presence to update
- @bob mentions @alice

**Expected:**
- In-app notification created
- Push notification IS sent

**Verify:**
Check Redis presence:
```bash
redis-cli
> SMEMBERS presence:online
# Should NOT contain alice-id when offline
```

## Debugging

### Check Socket Logs
Look for these messages:
- `Error writing repost notifications:` - Issue with repost handler
- `Error writing quote notifications:` - Issue with quote handler  
- `Error writing post notifications:` - Issue with post mention handler
- `Error writing comment notifications:` - Issue with comment mention handler
- `Error sending mention push notification:` - Push delivery failed
- `Error sending share push notification:` - Share push failed

### Check MongoDB Collections

**Notifications:**
```javascript
// See all notifications for a user:
db.Notifications.find({ userId: "<user-id>" }).sort({ createdAt: -1 })

// See notifications not read:
db.Notifications.find({ userId: "<user-id>", readAt: null })

// Find specific notification types:
db.Notifications.find({ type: "share" })
db.Notifications.find({ type: "mention" })
```

**Posts_Shares:**
```javascript
// Verify quote was created:
db.Posts_Shares.find({ Type: "quote", UserId: "<user-id>" })

// Verify repost was created:
db.Posts_Shares.find({ Type: "repost", UserId: "<user-id>" })
```

### Check Push Delivery
Enable verbose logging in `velo-socket`:
```javascript
// In push.ts, add console.log before fetch:
console.log('[push] Sending to:', recipients.length, 'users');
console.log('[push] Payload:', payload);
```

Check push service logs:
- Web app should log incoming `/api/push/send` requests
- Verify `x-push-secret` header is valid
- Check for FCM/APNS errors

### Common Issues

**Mentions not parsing:**
- Check username has no special chars (`.`, `-` break regex)
- Verify exact case match (usernames are case-insensitive in lookup but must exist)
- Max 20 mentions per post

**Push not received:**
- Check user has valid push subscription in DB
- Verify `PUSH_SERVICE_URL` and `PUSH_INTERNAL_SECRET` env vars
- Check user notification preferences
- Confirm user is offline (presence in Redis)

**Notification created but not appearing:**
- Check user hasn't blocked the actor
- Verify dedupeKey is unique (shouldn't create duplicate)
- Check TTL (notifications expire after 180 days)
