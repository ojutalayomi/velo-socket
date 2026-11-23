import { ObjectId } from 'mongodb';
import { io } from '../socket.js';
import { redis } from '../app.js';
import { offlineMessageManager } from '../offline-messages.js';
import { MongoDBClient } from '../mongodb.js';
import { selectRecipients } from '../notifications/eligibility.js';
import {
    actorFromUser,
    buildFollowDedupeKey,
    recordNotification,
    removeNotification,
} from '../notifications/inApp.js';
import { loadNotificationPreferences } from '../notifications/settings.js';
import { profileUrl } from '../notifications/targets.js';
import { filterOnlineUsers } from '../presence.js';
import { deliverPush } from '../push.js';

function formatName(user: {
    username?: string;
    firstname?: string;
    lastname?: string;
} | null): string {
    return [user?.firstname, user?.lastname].filter(Boolean).join(' ').trim() || user?.username || 'Someone';
}

/**
 * The follower as other people will see them. The client says who it is following; who it is
 * comes from the connection and the database, so a forged name can't ride along in the toast.
 */
async function trustedFollowerDetails(db: MongoDBClient, followerId: string, claimed: any) {
    const user = ObjectId.isValid(followerId)
        ? await db.users().findOne({ _id: new ObjectId(followerId) }, { projection: { username: 1 } })
        : null;
    return { ...(claimed ?? {}), _id: followerId, username: user?.username ?? '' };
}

io.on('connection', async (socket) => {
    // Handle follow event
    socket.on('follow', async (data: { followedDetails: any, followerDetails: any, time: string }, ack?: () => void) => {
        try {
            const followerId = socket.handshake.query.userId as string;
            const followedId = data?.followedDetails?._id ? String(data.followedDetails._id) : '';

            if (!followerId || !followedId || followerId === followedId) {
                ack?.();
                return;
            }

            const db = await new MongoDBClient().init();
            const existing = await db.followers().findOne({ followerId, followedId });
            if (!existing) {
                console.warn(`follow: no Followers row for ${followerId} -> ${followedId}`);
                ack?.();
                return;
            }

            await offlineMessageManager.broadcastMessage({
                type: 'followNotification',
                data: {
                    followedDetails: { ...data.followedDetails, _id: followedId },
                    followerDetails: await trustedFollowerDetails(db, followerId, data.followerDetails),
                    timestamp: data.time,
                    following: true,
                }
            }, undefined, [followedId, followerId]);

            const follower = ObjectId.isValid(followerId)
                ? await db.users().findOne(
                    { _id: new ObjectId(followerId) },
                    {
                        projection: {
                            username: 1,
                            firstname: 1,
                            lastname: 1,
                            displayPicture: 1,
                            verified: 1,
                        },
                    }
                )
                : null;
            const username = follower?.username || 'Someone';

            try {
                const followerActor = actorFromUser(follower, followerId);
                if (followerActor) {
                    await recordNotification(db, {
                        recipientId: followedId,
                        actorId: followerId,
                        actor: followerActor,
                        type: 'follow',
                        targetType: 'user',
                        targetId: followerId,
                        url: profileUrl(username),
                    });
                }
            } catch (error) {
                console.error('Error writing follow notification:', error);
            }

            const candidates = [followedId];
            const [preferences, onlineIds, blockedRows] = await Promise.all([
                loadNotificationPreferences(db, candidates),
                filterOnlineUsers(redis, candidates),
                db.blockedUsers()
                    .find(
                        { blockerId: followedId, blockedId: followerId },
                        { projection: { blockerId: 1, _id: 0 } }
                    )
                    .toArray(),
            ]);

            const recipients = selectRecipients({
                candidates,
                senderId: followerId,
                kind: 'follow',
                participants: new Set(candidates),
                blocked: new Set(blockedRows.map((row) => row.blockerId)),
                preferences,
                muted: new Set(),
                online: new Set(onlineIds),
                requireOffline: false,
            });

            await deliverPush({
                kind: 'follow',
                sourceId: followerId,
                userIds: recipients,
                payload: {
                    title: 'New follower',
                    body: `${formatName(follower)} started following you`,
                    url: `/${encodeURIComponent(username)}`,
                    tag: `follow:${followerId}`,
                },
                requireOffline: false,
                redis,
            });

            ack?.();
        } catch (error) {
            console.error('Error handling follow event:', error);
            ack?.();
        }
    });

    // Handle unfollow event
    socket.on('unfollow', async (data: { followedDetails: any, followerDetails: any, time: string }, ack?: () => void) => {
        try {
            const { followedDetails, followerDetails, time } = data ?? ({} as typeof data);
            const followerId = socket.handshake.query.userId as string;
            const followedId = followedDetails?._id ? String(followedDetails._id) : '';

            if (!followerId || !followedId || followerId === followedId) {
                ack?.();
                return;
            }

            // Only announce an unfollow that really happened: the follow row is already gone.
            const db = await new MongoDBClient().init();
            if (await db.followers().findOne({ followerId, followedId })) {
                ack?.();
                return;
            }

            await offlineMessageManager.broadcastMessage({
                type: 'followNotification',
                data: {
                    followedDetails: { ...followedDetails, _id: followedId },
                    followerDetails: await trustedFollowerDetails(db, followerId, followerDetails),
                    timestamp: time,
                    following: false,
                }
            }, undefined, [followedId, followerId]);

            {
                try {
                    await removeNotification(db, buildFollowDedupeKey(followedId, followerId));
                } catch (error) {
                    console.error('Error removing follow notification:', error);
                }
            }

            ack?.();
        } catch (error) {
            console.error('Error handling unfollow event:', error);
            ack?.();
        }
    });
});
