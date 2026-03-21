// src/core/send.ts - V2 发送层：参数适配 + 跨实例路由
// 本地投递统一调用 V1 (sessions-send.ts)
import Redis from 'ioredis';
import { getWeGirlConfig } from '../runtime.js';
import { wegirlSessionsSend } from './sessions-send.js';
import { validateOptions, createSessionContext, isNoReply, generateId } from './utils.js';
const KEY_PREFIX = 'wegirl:';
const STREAM_PREFIX = `${KEY_PREFIX}stream:instance:`;
// 全局 Redis 连接缓存
let redisClient = null;
let redisConnectPromise = null;
/**
 * 获取 Redis 连接
 */
async function getRedisClient() {
    if (redisClient && redisClient.status === 'ready') {
        return redisClient;
    }
    if (redisConnectPromise) {
        return redisConnectPromise;
    }
    redisConnectPromise = (async () => {
        const cfg = getWeGirlConfig();
        const redisUrl = cfg?.redisUrl || process.env.REDIS_URL ||
            `redis://${process.env.REDIS_HOST || 'localhost'}:${process.env.REDIS_PORT || '6379'}`;
        const password = cfg?.redisPassword || process.env.REDIS_PASSWORD;
        const db = cfg?.redisDb ?? parseInt(process.env.REDIS_DB || '1');
        const client = new Redis(redisUrl, {
            password,
            db,
            retryStrategy: (times) => Math.min(times * 50, 2000),
        });
        await new Promise((resolve, reject) => {
            client.once('connect', resolve);
            client.once('error', reject);
        });
        redisClient = client;
        return client;
    })();
    return redisConnectPromise;
}
/**
 * 查询 Staff 信息
 */
async function getStaffInfo(redis, staffId) {
    const data = await redis.hgetall(`${KEY_PREFIX}staff:${staffId}`);
    if (!data || Object.keys(data).length === 0) {
        return null;
    }
    let capabilities;
    if (data.capabilities) {
        try {
            capabilities = JSON.parse(data.capabilities);
        }
        catch {
            capabilities = String(data.capabilities).split(',').map(s => s.trim()).filter(Boolean);
        }
    }
    return {
        staffId,
        type: data.type,
        name: data.name,
        instanceId: data.instanceId,
        capabilities,
        status: data.status,
    };
}
/**
 * 获取当前实例 ID
 */
function getCurrentInstanceId() {
    const cfg = getWeGirlConfig();
    return cfg?.instanceId ||
        process.env.WEGIRL_INSTANCE_ID ||
        process.env.OPENCLAW_INSTANCE_ID ||
        'instance-local';
}
/**
 * 写入 Redis Stream（跨实例投递）
 */
async function writeToStream(redis, targetInstanceId, ctx, message, msgType, payload) {
    const streamKey = `${STREAM_PREFIX}${targetInstanceId}`;
    const streamData = {
        routingId: ctx.routingId,
        flowType: ctx.flowType,
        source: ctx.source,
        target: ctx.target,
        message,
        chatType: ctx.chatType,
        groupId: ctx.groupId || '',
        msgType: msgType || 'message',
        replyTo: JSON.stringify(ctx.replyTo),
        taskId: ctx.taskId || '',
        stepId: ctx.stepId || '',
        stepTotalAgents: ctx.stepTotalAgents?.toString() || '0',
        timestamp: Date.now().toString(),
    };
    if (payload) {
        streamData.payload = JSON.stringify(payload);
    }
    const entries = Object.entries(streamData).flat();
    await redis.xadd(streamKey, '*', ...entries);
}
/**
 * V2 核心发送函数
 *
 * 职责：
 * 1. 参数标准化验证
 * 2. 查询目标 Staff 信息
 * 3. A2H 直接发布到 replies
 * 4. 跨实例 → 写入 Redis Stream
 * 5. 本地 → 调用 V1 wegirlSessionsSend
 */
export async function wegirlSend(options, logger) {
    const routingId = options.routingId || generateId();
    try {
        // 1. 验证选项
        validateOptions(options);
        // 2. 创建 Session 上下文
        const ctx = createSessionContext(options, routingId);
        logger?.info?.(`[WeGirlSend] ${ctx.flowType}: ${ctx.source} -> ${ctx.target}`);
        // 3. 获取 Redis 连接
        const redis = await getRedisClient();
        // 4. 查询目标 Staff 信息
        const targetInfo = await getStaffInfo(redis, ctx.target);
        if (!targetInfo) {
            throw new Error(`Target not found: ${ctx.target}`);
        }
        // 5. A2H：直接发布到 replies
        if (targetInfo.type === 'human') {
            if (isNoReply(ctx.replyTo)) {
                logger?.debug?.(`[WeGirlSend] A2H with NO_REPLY, skipping`);
                return { success: true, routingId, local: true };
            }
            const replyMessage = {
                flowType: 'A2H',
                source: ctx.source,
                target: ctx.target,
                message: options.message,
                chatType: ctx.chatType,
                groupId: ctx.groupId,
                msgType: options.msgType || 'message',
                payload: options.payload,
                taskId: ctx.taskId,
                stepId: ctx.stepId,
                replyTo: ctx.replyTo,
                routingId: ctx.routingId,
                timestamp: Date.now(),
            };
            await redis.publish(`${KEY_PREFIX}replies`, JSON.stringify(replyMessage));
            logger?.info?.(`[WeGirlSend] A2H published to replies`);
            return { success: true, routingId, local: true };
        }
        // 6. 判断本地/跨实例
        const currentInstanceId = getCurrentInstanceId();
        const targetInstanceId = targetInfo.instanceId || currentInstanceId;
        const isLocal = targetInstanceId === currentInstanceId;
        // 7. 跨实例：写入 Stream
        if (!isLocal) {
            await writeToStream(redis, targetInstanceId, ctx, options.message, options.msgType, options.payload);
            logger?.info?.(`[WeGirlSend] Cross-instance delivery to ${targetInstanceId}`);
            return {
                success: true,
                routingId,
                local: false,
                targetInstanceId
            };
        }
        // 8. 本地：调用 V1 统一投递
        logger?.info?.(`[WeGirlSend] Local delivery to ${ctx.target} via V1`);
        // 构建 V1 参数
        const chatId = ctx.chatType === 'group'
            ? (ctx.groupId || ctx.source)
            : ctx.source;
        const cfg = {
            channels: {
                wegirl: {
                    accountId: ctx.target,
                }
            },
            models: {
                mode: 'merge',
                provider: 'kimi-coding',
                modelId: 'k2p5',
            },
        };
        const metadata = {
            originatingChannel: 'wegirl',
            originatingTo: ctx.source,
            originatingAccountId: ctx.target,
            replyTo: ctx.replyTo,
        };
        if (ctx.taskId)
            metadata.taskId = ctx.taskId;
        if (ctx.stepId)
            metadata.stepId = ctx.stepId;
        // 调用 V1
        await wegirlSessionsSend({
            message: options.message,
            cfg,
            channel: 'wegirl',
            accountId: ctx.target,
            from: ctx.source,
            chatId,
            chatType: ctx.chatType,
            routingId: ctx.routingId,
            metadata,
            log: logger,
        });
        return { success: true, routingId, local: true };
    }
    catch (err) {
        logger?.error?.(`[WeGirlSend] Failed: ${err.message}`);
        return {
            success: false,
            routingId,
            local: false,
            error: err.message
        };
    }
}
// 兼容旧接口导出
export { wegirlSend as wegirlSessionsSend };
//# sourceMappingURL=send.js.map