// src/sessions-send.ts - 发送消息到 Agent
import Redis from 'ioredis';
import { getWeGirlRuntime } from "./runtime.js";
// Redis 连接缓存
let redisClient = null;
let redisConnectPromise = null;
async function getRedisPublisher(cfg) {
    if (redisClient && redisClient.status === 'ready') {
        return redisClient;
    }
    if (redisConnectPromise) {
        return redisConnectPromise;
    }
    redisConnectPromise = (async () => {
        const channelCfg = cfg?.channels?.['wegirl'] || {};
        const redisUrl = channelCfg?.redisUrl || process.env.REDIS_URL || `redis://${process.env.REDIS_HOST || 'localhost'}:${process.env.REDIS_PORT || '6379'}`;
        const password = channelCfg?.redisPassword || process.env.REDIS_PASSWORD;
        const db = channelCfg?.redisDb || 1;
        const client = new Redis(redisUrl, {
            password: password,
            db: db,
        });
        await new Promise((resolve, reject) => {
            client.once('ready', resolve);
            client.once('error', reject);
            setTimeout(() => reject(new Error('Redis connect timeout')), 5000);
        });
        redisClient = client;
        return client;
    })();
    return redisConnectPromise;
}
/**
 * 发送消息到 Agent
 *
 * 流程:
 * 1. 获取 PluginRuntime
 * 2. 使用 resolveAgentRoute 查找 agent
 * 3. 构建 inbound context（设置 OriginatingChannel 用于回复路由）
 * 4. 调用 dispatchReplyFromConfig 发送消息给 Agent
 * 5. Gateway 自动处理 Agent 回复的路由
 */
export async function wegirlSessionsSend(options) {
    const { message, cfg, channel, accountId, from, chatId, chatType, log } = options;
    log?.info?.(`[WeGirl SessionsSend] Called: channel=${channel}, accountId=${accountId}, chatId=${chatId}`);
    // 获取 PluginRuntime
    const runtime = getWeGirlRuntime();
    if (!runtime) {
        log?.error?.('[WeGirl SessionsSend] No runtime available');
        return;
    }
    try {
        // 1. 使用 resolveAgentRoute 查找 agent
        const route = runtime.channel.routing.resolveAgentRoute({
            cfg,
            channel,
            accountId,
            peer: {
                kind: chatType,
                id: chatId,
            },
        });
        // 检查 route 是否为空
        if (!route || !route.agentId) {
            log?.error?.(`[WeGirl SessionsSend] Failed to resolve agent route: channel=${channel}, accountId=${accountId}, chatId=${chatId}`);
            return;
        }
        const sessionKey = route.sessionKey;
        const agentId = route.agentId;
        log?.info?.(`[WeGirl SessionsSend] Route resolved: agentId=${agentId}, sessionKey=${sessionKey}, matchedBy=${route.matchedBy}`);
        // 生成追踪ID和时间戳
        const routingId = `routing_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;
        const messageId = `wegirl-${Date.now()}`;
        const createdAt = Date.now();
        // 2. 发送 Redis 消息（包含 sessionKey 和 agentId，用于监控）
        try {
            const redis = await getRedisPublisher(cfg);
            const forwardMsg = {
                type: 'forward',
                routingId,
                messageId,
                message,
                channel,
                accountId,
                from,
                chatId,
                chatType,
                agentId,
                sessionKey,
                status: 'pending',
                source: 'wegirl-connector',
                priority: 'normal',
                createdAt,
                expiresAt: createdAt + 3600000, // 1小时后过期
                metadata: {
                    matchedBy: route.matchedBy,
                    originalChannel: channel,
                },
                workflowId: undefined, // 预留：用于工作流编排
                error: undefined, // 预留：处理失败时填充
                timestamp: Date.now()
            };
            await redis.publish('wegirl:forward', JSON.stringify(forwardMsg));
            log?.info?.(`[WeGirl SessionsSend] Message forwarded via Redis: agentId=${agentId}, sessionKey=${sessionKey}, routingId=${routingId}`);
        }
        catch (err) {
            log?.error?.('[WeGirl SessionsSend] Redis forward failed:', err.message);
        }
        // 3. 构建 envelope
        const body = runtime.channel.reply.formatAgentEnvelope({
            channel: '微妞AI',
            from: from,
            timestamp: new Date(),
            body: message,
        });
        // 构建 inbound context
        // Provider/Surface: wegirl（当前渠道）
        // OriginatingChannel/OriginatingTo: 目标渠道，Gateway 会自动路由回复到该渠道
        const inboundCtx = runtime.channel.reply.finalizeInboundContext({
            Body: body,
            BodyForAgent: message,
            RawBody: message,
            CommandBody: message,
            From: from,
            To: chatId,
            SessionKey: sessionKey,
            AccountId: accountId,
            Provider: 'wegirl',
            Surface: 'wegirl',
            ChatType: chatType,
            GroupSubject: chatType === 'group' ? chatId : undefined,
            SenderId: from,
            SenderName: from,
            MessageSid: messageId,
            Timestamp: Date.now(),
            WasMentioned: true,
            CommandAuthorized: true,
            OriginatingChannel: channel,
            OriginatingTo: chatId,
        });
        log?.info?.(`[WeGirl SessionsSend] dispatching to agent (session=${sessionKey}, replyTo=${channel}:${accountId})`);
        // 创建 dispatcher，处理 Agent 回复
        // 当 channel="wegirl" 时，通过 outbound 发送；其他情况交由 Gateway 自动路由
        const { dispatcher, replyOptions, markDispatchIdle } = runtime.channel.reply.createReplyDispatcherWithTyping({
            deliver: async (payload, info) => {
                const text = payload.text ?? '';
                log?.debug?.(`[WeGirl SessionsSend] agent reply: kind=${info?.kind}, channel=${channel}, text=${text.substring(0, 50)}`);
                // 只处理最终回复
                if (info?.kind !== 'final' || !text.trim()) {
                    return;
                }
                // 只有 channel="wegirl" 时才通过 outbound 发送
                // 其他 channel（如 feishu）由 Gateway 自动路由，不处理
                if (channel !== 'wegirl') {
                    log?.debug?.(`[WeGirl SessionsSend] channel=${channel} !== 'wegirl', skip outbound delivery (Gateway will handle)`);
                    return;
                }
                log?.info?.(`[WeGirl SessionsSend] channel='wegirl', sending reply via outbound: ${text.substring(0, 50)}...`);
                try {
                    const pub = await getRedisPublisher(cfg);
                    if (!pub) {
                        log?.error?.(`[WeGirl SessionsSend] Redis publisher not connected`);
                        return;
                    }
                    const replyId = `wegirl-reply-${Date.now()}`;
                    const replyMessage = {
                        id: replyId,
                        type: 'message',
                        routingId: routingId, // 关联请求
                        inReplyTo: messageId, // 回复哪条消息
                        content: text,
                        to: chatId,
                        from: 'agent',
                        agentId: agentId,
                        sessionId: sessionKey,
                        accountId: accountId,
                        status: 'completed',
                        isFinal: true,
                        replyType: 'text',
                        processedAt: Date.now(),
                        duration: Date.now() - createdAt,
                        workflowId: undefined, // 预留：工作流编排
                        error: undefined, // 预留：错误信息
                        timestamp: Date.now(),
                    };
                    await pub.publish('wegirl:replies', JSON.stringify(replyMessage));
                    log?.info?.(`[WeGirl SessionsSend] Reply published to wegirl:replies`);
                }
                catch (err) {
                    // 发送失败，发布错误回复
                    try {
                        const pub = await getRedisPublisher(cfg);
                        if (pub) {
                            const errorReply = {
                                id: `wegirl-reply-error-${Date.now()}`,
                                type: 'message',
                                routingId: routingId,
                                inReplyTo: messageId,
                                content: '',
                                to: chatId,
                                from: 'agent',
                                agentId: agentId,
                                sessionId: sessionKey,
                                accountId: accountId,
                                status: 'failed',
                                isFinal: true,
                                replyType: 'error',
                                processedAt: Date.now(),
                                duration: Date.now() - createdAt,
                                workflowId: undefined,
                                error: err.message,
                                errorCode: 'REPLY_PUBLISH_FAILED',
                                timestamp: Date.now(),
                            };
                            await pub.publish('wegirl:replies', JSON.stringify(errorReply));
                        }
                    }
                    catch { }
                    log?.error?.(`[WeGirl SessionsSend] Failed to publish reply: ${err.message}`);
                }
            },
            onError: (error, info) => {
                log?.error?.(`[WeGirl SessionsSend] deliver error: ${error}`);
            },
        });
        // 调用 dispatchReplyFromConfig 发送消息给 Agent
        const result = await runtime.channel.reply.dispatchReplyFromConfig({
            ctx: inboundCtx,
            cfg,
            dispatcher,
            replyOptions,
        });
        markDispatchIdle();
        log?.info?.(`[WeGirl SessionsSend] dispatch complete (queuedFinal=${result.queuedFinal}, replies=${result.counts?.final ?? 0})`);
    }
    catch (err) {
        log?.error?.(`[WeGirl SessionsSend] Failed: ${err.message}`);
        throw err;
    }
}
//# sourceMappingURL=sessions-send.js.map