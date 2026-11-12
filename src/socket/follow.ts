import { io } from '../socket.js';
import { redis } from '../app.js';
import { ONLINE_USERS_KEY } from '../utils.js';
import { offlineMessageManager } from '../offline-messages.js';
import { sendPushToUsers } from '../push.js';

io.on('connection', async (socket) => {
    // Handle follow event
    socket.on('follow', async (data: { followedDetails: any, followerDetails: any, time: string }, ack?: () => void) => {
        try {
            const { followedDetails, followerDetails, time } = data;
            const followedId = String(followedDetails._id);

            await offlineMessageManager.broadcastMessage({
                type: 'followNotification',
                data: {
                    followedDetails,
                    followerDetails,
                    timestamp: time,
                    following: true,
                }
            }, undefined, [followedId, String(followerDetails._id)]);

            // Update online users list if needed
            const isOnline = Boolean(await redis.sismember(ONLINE_USERS_KEY, String(followerDetails._id)));
            if (isOnline) {
                io.emit('userStatus', { userId: String(followerDetails._id), status: 'online' });
            }

            const offlineFollowers = await offlineMessageManager.filterOfflineUsers([followedId]);
            void sendPushToUsers(offlineFollowers, {
                title: 'New follower',
                body: `${followerDetails.username || 'Someone'} started following you`,
                url: `/${followerDetails.username || ''}`,
                tag: `follow-${String(followerDetails._id)}`,
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
            const { followedDetails, followerDetails, time } = data;
            const followedId = String(followedDetails._id);

            await offlineMessageManager.broadcastMessage({
                type: 'followNotification',
                data: {
                    followedDetails,
                    followerDetails,
                    timestamp: time,
                    following: false,
                }
            }, undefined, [followedId, String(followerDetails._id)]);
            ack?.();
        } catch (error) {
            console.error('Error handling unfollow event:', error);
            ack?.();
        }
    });
}); 