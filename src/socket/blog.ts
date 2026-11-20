import { Collection, Document, ObjectId } from "mongodb";
import type Redis from 'ioredis';
import { getMongoDb, MongoDBClient } from "../mongodb.js";
import {
    actorFromUser,
    buildLikeDedupeKey,
    loadActor,
    recordNotification,
    removeNotification,
} from "../notifications/inApp.js";
import { resolveMentionedUserIds } from "../notifications/mentions.js";
import { contentUrl } from "../notifications/targets.js";
import { BlogPost, NotificationActor, NotificationTarget, PostSchema, ReactionType, SharedBlogPost } from "../types.js";
import { io } from '../socket.js';
import { deleteFileFromS3 } from "../s3.js";
import { offlineMessageManager } from '../offline-messages.js';
import { redis } from '../redis.js';
import { deliverPush, messagePreview } from '../push.js';
import { loadNotificationPreferences } from '../notifications/settings.js';

interface MentionPushParams {
    inboxDb: MongoDBClient;
    redis: Redis;
    recipientId: string;
    actorId: string;
    actorName: string;
    postId: string;
    snippet?: string;
}

interface SharePushParams {
    inboxDb: MongoDBClient;
    redis: Redis;
    recipientId: string;
    actorId: string;
    actorName: string;
    postId: string;
    isQuote: boolean;
    snippet?: string;
}

/**
 * Sends a push notification when a user is mentioned in a post or comment.
 */
async function sendMentionPushNotification(params: MentionPushParams): Promise<void> {
    const { inboxDb, redis, recipientId, actorId, actorName, postId, snippet } = params;

    try {
        const [preferences, blockedRows] = await Promise.all([
            loadNotificationPreferences(inboxDb, [recipientId]),
            inboxDb
                .blockedUsers()
                .find(
                    { blockerId: recipientId, blockedId: actorId },
                    { projection: { blockerId: 1, _id: 0 } }
                )
                .toArray(),
        ]);

        // Skip if user blocked the actor
        if (blockedRows.length > 0) return;

        const userPrefs = preferences.get(recipientId);
        // Skip if user has mentions disabled
        if (!userPrefs?.mentions) return;

        const body = snippet ? messagePreview(snippet, 0) : 'You were mentioned in a post';

        await deliverPush({
            kind: 'mention',
            sourceId: postId,
            userIds: [recipientId],
            payload: {
                title: actorName,
                body,
                url: `/notifications`,
                tag: `mention:${postId}`,
            },
            requireOffline: false,
            redis,
        });
    } catch (error) {
        console.error('Error sending mention push notification:', error);
    }
}

/**
 * Sends a push notification when a user's post is shared (reposted or quoted).
 */
async function sendSharePushNotification(params: SharePushParams): Promise<void> {
    const { inboxDb, redis, recipientId, actorId, actorName, postId, isQuote, snippet } = params;

    try {
        const [preferences, blockedRows] = await Promise.all([
            loadNotificationPreferences(inboxDb, [recipientId]),
            inboxDb
                .blockedUsers()
                .find(
                    { blockerId: recipientId, blockedId: actorId },
                    { projection: { blockerId: 1, _id: 0 } }
                )
                .toArray(),
        ]);

        // Skip if user blocked the actor
        if (blockedRows.length > 0) return;

        const userPrefs = preferences.get(recipientId);
        // Skip if user has follow/engagement notifications disabled (we use 'follows' for share notifications)
        if (!userPrefs?.follows) return;

        const action = isQuote ? 'quoted' : 'reposted';
        const body = isQuote && snippet 
            ? messagePreview(snippet, 0)
            : `${actorName} ${action} your post`;

        await deliverPush({
            kind: 'follow',
            sourceId: postId,
            userIds: [recipientId],
            payload: {
                title: isQuote ? actorName : `${actorName} ${action} your post`,
                body: isQuote ? body : '',
                url: `/notifications`,
                tag: `share:${postId}`,
            },
            requireOffline: false,
            redis,
        });
    } catch (error) {
        console.error('Error sending share push notification:', error);
    }
}

io.on('connection', (socket) => {
    const userId = socket.handshake.query.userId as string;

    socket.on('reactToPost', async (data: ReactionType) => {

        let targetType: NotificationTarget = 'post';

        try {
            // Connect to MongoDB
            const db = await new MongoDBClient().init();
            const collection = db.users();
            const posts = db.posts();
            const shares = db.postsShares();
            const comments = db.postsComments();
            let PostsOrSharesOrComments: Collection<PostSchema>;
        
            // Retrieve user and post data
            const user = await collection.findOne({ _id: new ObjectId(userId.toString()) });
        
            if (!user) {
                return io.to(`user:${userId}`).emit("post_reaction_response", { message: `You're not allowed to ${data.type} this post!`, success: false, postId: data.postId, reaction: data.type });
            }
            // Check if the post exists in the posts collection
            let post = await posts.findOne({ PostID: data.postId });
            PostsOrSharesOrComments = posts;
            
            // If not found, check in the shares collection
            if (!post) {
                post = await shares.findOne({ PostID: data.postId });
                PostsOrSharesOrComments = shares;
            } 
            
            if (!post) {
                // Check if the post is a comment
                post = await comments.findOne({ PostID: data.postId });
                PostsOrSharesOrComments = comments;
                targetType = 'comment';
            }

            if (!post) {
                return io.to(`user:${userId}`).emit("post_reaction_response", { message: "Blog is not available!", success: false, postId: data.postId, reaction: data.type });
            }

            if (!data.type) return io.to(`user:${userId}`).emit("post_reaction_response", { message: "This is an invalid reaction!", success: false, postId: data.postId, reaction: data.type });

            const currentCollection = data.type.includes('like') ? db.postsLikes() : db.postsBookmarks();
            
            const existingReaction = await currentCollection.findOne({ postId: data.postId, userId: userId });

            if(data.type.includes('un')){
                // Check if the user has already reacted to the post
                if (!existingReaction) {
                    return io.to(`user:${userId}`).emit("post_reaction_response", {
                        message: `You have not ${data.type} this post!`,
                        success: false,
                        postId: data.postId,
                        reaction: data.type,
                    });
                }
                // Remove the reaction
                await currentCollection.deleteOne({ postId: data.postId, userId: userId })

                
                await PostsOrSharesOrComments.updateOne(
                    { PostID: data.postId }, 
                    { $inc: { [data.key]: -1 } } // if data.type is like -> { $inc: { [`NoOfLikes`]: -1 } }
                );

                if (data.type === 'unlike' && post.UserId && post.UserId !== userId) {
                    try {
                        await removeNotification(
                            db,
                            buildLikeDedupeKey(targetType, data.postId, post.UserId, userId)
                        );
                    } catch (error) {
                        console.error('Error removing like notification:', error);
                    }
                }
            } else {
                // Check if the user has already reacted to the post
                if (existingReaction) {
                    return io.to(`user:${userId}`).emit("post_reaction_response", {
                        message: `You have already ${data.type} this post!`,
                        success: false,
                        postId: data.postId,
                        reaction: data.type,
                    });
                }
                // Add the reaction
                const reactionDoc: {
                    _id: ObjectId;
                    postId: string;
                    userId: string;
                    searchText?: string;
                } = { _id: new ObjectId(), postId: data.postId, userId };
                if (data.type === "bookmark") {
                    const parts = [post.Caption, post.Username, post.NameOfPoster, post.PostID]
                        .filter((v) => v != null && String(v).trim() !== "")
                        .map((v) => String(v));
                    reactionDoc.searchText = parts.join("\n");
                }
                await currentCollection.insertOne(reactionDoc)

                
                await PostsOrSharesOrComments.updateOne(
                    { PostID: data.postId }, 
                    { $inc: { [data.key]: 1 } } // if data.type is like -> { $inc: { [`NoOfLikes`]: 1 } }
                );

                if (data.type === 'like' && post.UserId && post.UserId !== userId) {
                    try {
                        await recordNotification(db, {
                            recipientId: post.UserId,
                            actorId: userId,
                            actor: actorFromUser(user, userId) ?? undefined,
                            type: 'like',
                            targetType,
                            targetId: post.PostID,
                            url: contentUrl(post),
                            snippet: post.Caption,
                        });
                    } catch (error) {
                        console.error('Error writing like notification:', error);
                    }
                }
            }

            io.to(`user:${userId}`).emit("post_reaction_response", { message: "Reaction added successfully!", success: true, reaction: data.type });
            
            // Use offline message system instead of direct broadcast
            await offlineMessageManager.broadcastMessage({
                type: 'updatePost',
                data: { 
                    postId: post.PostID,  
                    update: {
                        [data.key]: data.value === 'inc' ? post[data.key] + 1 : post[data.key] - 1
                    },
                    type: data.type
                }
            }, userId);
        } catch (err) {
            console.error('Error processing reaction(reactToPost):', err);
            io.to(`user:${userId}`).emit('error', 'Error processing reaction(reactToPost)');
        }

    })

    socket.on('reactToPost(share)', async (data: {
        action: "share" | "unshare";
        type: "repost" | "quote";
        post: SharedBlogPost;
    }) => {

        try {
            // Connect to MongoDB
            const db = await new MongoDBClient().init();
            const inboxDb = await new MongoDBClient().init();
            const collection = db.users();
            const shares = db.postsShares();
            const posts = db.posts();
            const comments = db.postsComments();
            let PostsOrSharesOrComments: Collection<PostSchema>;
        
            // Retrieve user and post data
            const user = await collection.findOne({ _id: new ObjectId(userId.toString()) });
        
            if (!user) {
                return io.to(`user:${userId}`).emit("post_reaction_response", { message: `You're not allowed to ${data.type} this post!`, success: false, postId: data.post.PostID, reaction: data.type });
            }
            // Quotes reference the target via OriginalPostId; repost/unshare send the target post itself.
            const targetPostId = data.action === 'share' && data.type === 'quote'
                ? data.post.OriginalPostId
                : data.post.PostID;

            // Check if the post exists in the posts collection
            let post = await posts.findOne({ PostID: targetPostId });
            PostsOrSharesOrComments = posts;
            
            // If not found, check in the shares collection
            if (!post) {
                post = await shares.findOne({ PostID: targetPostId });
                PostsOrSharesOrComments = shares;
            } 
            
            if (!post) {
                // Check if the post is a comment
                post = await comments.findOne({ PostID: targetPostId });
                PostsOrSharesOrComments = comments;
            }

            if (!post) {
                return io.to(`user:${userId}`).emit("post_reaction_response", { message: "Post is not available!", success: false, postId: data.post.PostID, reaction: data.action });
            }

            if (!data.action) return io.to(`user:${userId}`).emit("post_reaction_response", { message: "This is an invalid reaction!", success: false, postId: data.post.PostID, reaction: data.action });

            // Check if the user has already reposted
            const existingRepost = await shares.findOne({ OriginalPostId: targetPostId, UserId: userId, Type: "repost" });
            
            if(data.action === 'unshare'){
                if (!existingRepost) {
                    return io.to(`user:${userId}`).emit("post_reaction_response", {
                        message: "You have not reposted this post!",
                        success: false,
                        postId: data.post.PostID,
                        reaction: data.action,
                    });
                }
                await shares.deleteOne({ OriginalPostId: targetPostId, UserId: userId, Type: "repost" })

                await PostsOrSharesOrComments.updateOne(
                    { PostID: data.post.PostID }, 
                    { $inc: { NoOfShares: -1 } }
                );

                await offlineMessageManager.broadcastMessage({
                    type: 'deletePost',
                    data: { 
                        postId: post.PostID,
                        type: data.action
                    }
                }, userId);
            } else {
                if (data.type === "repost") {
                    if (existingRepost) {
                        return io.to(`user:${userId}`).emit("post_reaction_response", {
                            message: "You have already reposted this post!",
                            success: false,
                            postId: data.post.PostID,
                            reaction: data.action,
                        });
                    }
        
                    // Create a new repost (only references the original post)
                    const repost = {
                        _id: new ObjectId(),
                        UserId: userId,
                        DisplayPicture: user.displayPicture || "",
                        NameOfPoster: `${user.firstname ?? ""} ${user.lastname ?? ""}`.trim(),
                        Verified: user.verified ?? false,
                        Username: user.username || "",
                        IsFollowing: false,
                        Type: "repost",
                        PostID: "",
                        OriginalPostId: data.post.PostID,
                        TimeOfPost: new Date().toISOString(),
                    };
                    repost.PostID = repost._id.toString();

                    await shares.insertOne(repost as PostSchema);
                    await PostsOrSharesOrComments.updateOne(
                        { PostID: targetPostId },
                        { $inc: { NoOfShares: 1 } }
                    );
            
                    await offlineMessageManager.broadcastMessage({
                        type: 'updatePost',
                        data: { 
                            postId: targetPostId,
                            update: {
                                NoOfShares: (post.NoOfShares ?? 0) + 1
                            },
                            type: data.action 
                        }
                    }, userId);
        
                    await offlineMessageManager.broadcastMessage({
                        type: 'newPost',
                        data: {
                            blog: repost,
                        }
                    }, userId);

                    // Notify original post author about the repost
                    try {
                        const notificationActor = await loadActor(inboxDb, userId);
                        const originalAuthorId = post.UserId ? String(post.UserId) : '';

                        if (notificationActor && originalAuthorId && originalAuthorId !== userId) {
                            const wasRecorded = await recordNotification(inboxDb, {
                                recipientId: originalAuthorId,
                                actorId: userId,
                                actor: notificationActor,
                                type: 'share',
                                targetType: PostsOrSharesOrComments === comments ? 'comment' : 'post',
                                targetId: String(post.PostID),
                                url: contentUrl(post),
                            });

                            if (wasRecorded) {
                                await sendSharePushNotification({
                                    inboxDb,
                                    redis,
                                    recipientId: originalAuthorId,
                                    actorId: userId,
                                    actorName: notificationActor.name,
                                    postId: String(post.PostID),
                                    isQuote: false,
                                });
                            }
                        }
                    } catch (error) {
                        console.error('Error writing repost notifications:', error);
                    }
                } else if (data.type === "quote") {
                    // Create a new quoted post
                    const quote: SharedBlogPost = {
                        _id: new ObjectId(),
                        ParentId: "",
                        UserId: userId,
                        DisplayPicture: user.displayPicture || "",
                        NameOfPoster: `${user.firstname ?? ""} ${user.lastname ?? ""}`.trim(),
                        Verified: user.verified ?? false,
                        TimeOfPost: new Date().toISOString(),
                        Visibility: data.post.Visibility,
                        Caption: data.post.Caption ?? "", // Include user's caption
                        Image: data.post.Image ?? [],
                        IsFollowing: false,
                        NoOfLikes: 0,
                        Liked: false,
                        NoOfComment: 0,
                        NoOfShares: 0,
                        NoOfBookmarks: 0,
                        Bookmarked: false,
                        Shared: false,
                        Username: user.username || "",
                        Code: data.post.Code,
                        WhoCanComment: data.post.WhoCanComment,
                        Type: "quote",
                        PostID: "",
                        OriginalPostId: data.post.OriginalPostId,
                    };
                    quote.PostID = quote._id.toString();
        
                    await shares.insertOne(quote);
                    await PostsOrSharesOrComments.updateOne(
                        { PostID: targetPostId },
                        { $inc: { NoOfShares: 1 } }
                    );
            
                    await offlineMessageManager.broadcastMessage({
                        type: 'updatePost',
                        data: { 
                            postId: targetPostId,
                            update: {
                                NoOfShares: (post.NoOfShares ?? 0) + 1
                            },
                            type: data.action 
                        }
                    }, userId);
        
                    await offlineMessageManager.broadcastMessage({
                        type: 'newPost',
                        data: {
                            blog: quote,
                        }
                    }, userId);

                    // Notify original post author and parse mentions from quote caption
                    try {
                        const notificationActor = await loadActor(inboxDb, userId);
                        let mentionedActors: NotificationActor[] = [];
                        
                        if (notificationActor) {
                            mentionedActors = await resolveMentionedUserIds(inboxDb, quote.Caption);
                        }

                        const originalAuthorId = post.UserId ? String(post.UserId) : '';
                        const mentionedIds = new Set(mentionedActors.map((actor) => actor.id));

                        // Notify original author (if not the same person and not mentioned)
                        if (notificationActor && originalAuthorId && originalAuthorId !== userId && !mentionedIds.has(originalAuthorId)) {
                            const wasRecorded = await recordNotification(inboxDb, {
                                recipientId: originalAuthorId,
                                actorId: userId,
                                actor: notificationActor,
                                type: 'share',
                                targetType: PostsOrSharesOrComments === comments ? 'comment' : 'post',
                                targetId: String(post.PostID),
                                url: contentUrl(quote),
                                snippet: quote.Caption,
                            });

                            if (wasRecorded) {
                                await sendSharePushNotification({
                                    inboxDb,
                                    redis,
                                    recipientId: originalAuthorId,
                                    actorId: userId,
                                    actorName: notificationActor.name,
                                    postId: String(post.PostID),
                                    isQuote: true,
                                    snippet: quote.Caption,
                                });
                            }
                        }

                        // Notify mentioned users
                        if (notificationActor) {
                            for (const mention of mentionedActors) {
                                if (mention.id === userId) continue;

                                const wasRecorded = await recordNotification(inboxDb, {
                                    recipientId: mention.id,
                                    actorId: userId,
                                    actor: notificationActor,
                                    type: 'mention',
                                    targetType: 'post',
                                    targetId: quote.PostID,
                                    url: contentUrl(quote),
                                    snippet: quote.Caption,
                                });

                                if (wasRecorded) {
                                    await sendMentionPushNotification({
                                        inboxDb,
                                        redis,
                                        recipientId: mention.id,
                                        actorId: userId,
                                        actorName: notificationActor.name,
                                        postId: quote.PostID,
                                        snippet: quote.Caption,
                                    });
                                }
                            }
                        }
                    } catch (error) {
                        console.error('Error writing quote notifications:', error);
                    }
                }
            }

            io.to(`user:${userId}`).emit("post_reaction_response", { message: `Post ${data.action}d successfully!`, success: true, reaction: data.action });
        } catch (err) {
            console.error('Error processing reaction(reactToPost(share)):', err);
            io.to(`user:${userId}`).emit('error', 'Error processing reaction(reactToPost(share))');
        }

    })

    socket.on('post', async (data: BlogPost) => {

        try {
            // Connect to MongoDB
            const db = await getMongoDb();
            const inboxDb = await new MongoDBClient().init();
            const collection = db.collection('Users');
            const posts = db.collection('Posts');
            const comments = db.collection('Posts_Comments');
            const shares = db.collection('Posts_Shares');
            let PostsOrSharesOrComments: Collection<Document>;
        
            // Retrieve user and post data
            const user = await collection.findOne({ _id: new ObjectId(userId.toString()) });
        
            if (!user) {
                return io.to(`user:${userId}`).emit("post_response", { message: `You're not allowed to ${data.Type}!`, success: false });
            }
        
            // Create a new blog
            const blog: BlogPost = {
                _id: new ObjectId(),
                ParentId: data.ParentId || '',
                UserId: userId,
                DisplayPicture: user.displayPicture || '',
                NameOfPoster: `${user.firstname ?? ''} ${user.lastname ?? ''}`.trim(),
                Verified: user.verified ?? false,
                TimeOfPost: data.TimeOfPost ?? new Date().toISOString(),
                Visibility: data.Visibility,
                Caption: data.Caption ?? '',
                Image: data.Image ?? [],
                IsFollowing: false,
                NoOfLikes: 0,
                Liked: false,
                NoOfComment: 0,
                NoOfShares: 0,
                NoOfBookmarks: 0,
                Bookmarked: false,
                Shared: false,
                Username: user.username || '',
                Code: data.Code,
                WhoCanComment: data.WhoCanComment,
                Type: data.Type,
                PostID: "",
            };
            blog.PostID = blog._id.toString();
            // console.log(data)

            let notificationActor: NotificationActor | null = null;
            let mentionedActors: NotificationActor[] = [];
            try {
                notificationActor = await loadActor(inboxDb, userId);
                if (notificationActor) {
                    mentionedActors = await resolveMentionedUserIds(inboxDb, blog.Caption);
                }
            } catch (error) {
                console.error('Error resolving notification recipients:', error);
            }

            if(blog.Type === 'comment') {
                if (!data.ParentId) {
                    return io.to(`user:${userId}`).emit("post_response", { 
                        message: "ParentId is needed!", 
                        success: false 
                    });
                }
                // Check if the post exists in the posts collection
                let post = await posts.findOne({ PostID: data.ParentId });
                PostsOrSharesOrComments = posts;
                
                // If not found, check in the shares collection
                if (!post) {
                    post = await shares.findOne({ PostId: data.ParentId });
                    PostsOrSharesOrComments = shares;
                } 
                
                if (!post) {
                    // Check if the post is a comment
                    post = await comments.findOne({ PostID: data.ParentId });
                    PostsOrSharesOrComments = comments;
                }

                if (!post) {
                    return io.to(`user:${userId}`).emit("post_reaction_response", { message: "Post is not available!", success: false, postId: data.PostID, reaction: data.Type });
                }

                // Save the new comment and update the post
                await comments.insertOne(blog);
            
                await PostsOrSharesOrComments.updateOne({ PostID: data.ParentId }, { $inc: { NoOfComment: 1} });

                // Use offline message system for new comments
                await offlineMessageManager.broadcastMessage({
                    type: 'newComment',
                    data: { 
                        blog: blog 
                    }
                }, userId);

                // broadcastMessage skips the author, so send them their own comment too.
                io.to(`user:${userId}`).emit('newComment', { excludeUser: userId, blog });

                await offlineMessageManager.broadcastMessage({
                    type: 'updatePost',
                    data: { 
                        postId: blog.ParentId, 
                        update: {
                            NoOfComment: post.NoOfComment + 1
                        },
                        type: blog.Type 
                    }
                }, userId);

                try {
                    if (notificationActor) {
                        const mentionedIds = new Set(mentionedActors.map((actor) => actor.id));
                        const ownerId = post.UserId ? String(post.UserId) : '';

                        if (ownerId && ownerId !== userId && !mentionedIds.has(ownerId)) {
                            await recordNotification(inboxDb, {
                                recipientId: ownerId,
                                actorId: userId,
                                actor: notificationActor,
                                type: 'comment',
                                targetType: PostsOrSharesOrComments === comments ? 'comment' : 'post',
                                targetId: String(post.PostID),
                                sourceId: blog.PostID,
                                url: contentUrl(post),
                                snippet: blog.Caption,
                            });
                        }

                        for (const mention of mentionedActors) {
                            if (mention.id === userId) continue;

                            const wasRecorded = await recordNotification(inboxDb, {
                                recipientId: mention.id,
                                actorId: userId,
                                actor: notificationActor,
                                type: 'mention',
                                targetType: 'comment',
                                targetId: blog.PostID,
                                url: contentUrl(blog),
                                snippet: blog.Caption,
                            });

                            if (wasRecorded) {
                                await sendMentionPushNotification({
                                    inboxDb,
                                    redis,
                                    recipientId: mention.id,
                                    actorId: userId,
                                    actorName: notificationActor.name,
                                    postId: blog.PostID,
                                    snippet: blog.Caption,
                                });
                            }
                        }
                    }
                } catch (error) {
                    console.error('Error writing comment notifications:', error);
                }
            } else {
                await posts.insertOne(blog)
                
                // Use offline message system for new posts
                await offlineMessageManager.broadcastMessage({
                    type: 'newPost',
                    data: { 
                        blog: blog 
                    }
                }, userId);

                try {
                    if (notificationActor) {
                        for (const mention of mentionedActors) {
                            if (mention.id === userId) continue;

                            const wasRecorded = await recordNotification(inboxDb, {
                                recipientId: mention.id,
                                actorId: userId,
                                actor: notificationActor,
                                type: 'mention',
                                targetType: 'post',
                                targetId: blog.PostID,
                                url: contentUrl(blog),
                                snippet: blog.Caption,
                            });

                            if (wasRecorded) {
                                await sendMentionPushNotification({
                                    inboxDb,
                                    redis,
                                    recipientId: mention.id,
                                    actorId: userId,
                                    actorName: notificationActor.name,
                                    postId: blog.PostID,
                                    snippet: blog.Caption,
                                });
                            }
                        }
                    }
                } catch (error) {
                    console.error('Error writing post notifications:', error);
                }
            }
        
            io.to(`user:${userId}`).emit("post_response", { 
                message: `${data.Type.toUpperCase()} added successfully!`, 
                success: true 
            });

        } catch (err) {
            console.error('Error processing form data:', err);
            io.to(`user:${userId}`).emit('error', 'Error processing form data');
        }

    });
    
    socket.on('deletePost', async (data: { postId: string }) => {

        try {
            if (!data.postId) {
                return io.to(`user:${userId}`).emit("delete_post_response", { 
                    message: "PostId is needed!", 
                    success: false 
                });
            }

            // Connect to MongoDB
            const db = await getMongoDb();
            const posts = db.collection('Posts');
            const shares = db.collection('Posts_Shares');
            const comments = db.collection('Posts_Comments');
            let PostsOrSharesOrComments: Collection<Document>;

            // Check if the post exists in the posts collection
            let post = await posts.findOne({ PostID: data.postId });
            PostsOrSharesOrComments = posts;

            // If not found, check in the shares collection
            if (!post) {
                post = await shares.findOne({ PostID: data.postId });
                PostsOrSharesOrComments = shares;
            }

            // If not found, check in the comments collection
            if (!post) {
                post = await comments.findOne({ PostID: data.postId });
                PostsOrSharesOrComments = comments;
            }

            if (!post) {
                return io.to(`user:${userId}`).emit("delete_post_response", { 
                    message: "Post not found!", 
                    success: false 
                });
            }

            // Delete the post
            await PostsOrSharesOrComments.deleteOne({ PostID: data.postId });
            await db.collection('Posts_Likes').deleteMany({ OriginalPostId: data.postId }); 
            await db.collection('Posts_Bookmarks').deleteMany({ OriginalPostId: data.postId });
            await shares.deleteMany({ OriginalPostId: data.postId });
            await comments.deleteMany({ ParentId: data.postId });

            if(post.Image.length > 0) {
                post.Image.map(async (media: string) => {
                    await deleteFileFromS3('post-s', [media]);
                })
            }
            // If the post is a comment, update the parent post
            if(post.Type === 'comment') {
                await offlineMessageManager.broadcastMessage({
                    type: 'updatePost',
                    data: { 
                        postId: post.ParentId, 
                        update: {
                            NoOfComments: post.NoOfComments > 0 ? post.NoOfComments - 1 : 0
                        },
                        type: post.Type 
                    }
                }, userId);
            }

            // Use offline message system for post deletion
            await offlineMessageManager.broadcastMessage({
                type: 'deletePost',
                data: { 
                    postId: data.postId 
                }
            }, userId);

            io.to(`user:${userId}`).emit("delete_post_response", { 
                message: "Post deleted successfully!", 
                success: true 
            });
        } catch (err) {
            console.error('Error deleting post:', err);
            io.to(`user:${userId}`).emit("delete_post_response", { 
                message: "Error deleting post!", 
                success: false 
            });
        }

    })
})