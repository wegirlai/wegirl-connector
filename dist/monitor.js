// src/monitor.ts - WeGirl Provider Monitor（每个 agent 独立监听自己的 stream）
import Redis from 'ioredis';
import { getWeGirlPluginConfig } from './config.js';
import { wegirlSessionsSend } from './core/sessions-send.js';
/**
 * 监控 WeGirl Redis Stream（每个 agent 独立）
 * 监听 wegirl:stream:${instanceId}:${accountId}
 */
export async function monitorWeGirlProvider(params) {
    const { accountId, instanceId, cfg, abortSignal, log } = params;
    // 每个 agent 独立的 stream key 和消费者组
    const streamKey = `wegirl:stream:${instanceId}:${accountId}`;
    const consumerGroup = `wegirl-consumers-${instanceId}-${accountId}`; // 每个 agent 独立的消费者组
    const consumerName = `${accountId}-${Date.now()}`;
    log?.info?.(`[WeGirl:${accountId}] Starting monitor for stream: ${streamKey}`);
    // 1. 创建 Redis 连接
    const pluginCfg = getWeGirlPluginConfig();
    const redis = new Redis({
        host: pluginCfg?.redisHost || '10.8.0.1',
        port: pluginCfg?.redisPort || 6379,
        password: pluginCfg?.redisPassword,
        db: pluginCfg?.redisDb ?? 1,
        maxRetriesPerRequest: null,
        connectTimeout: 10000,
        lazyConnect: true,
    });
    // 2. 显式连接 Redis（因为 lazyConnect: true）
    try {
        await redis.connect();
        log?.info?.(`[WeGirl:${accountId}] Redis connected`);
    }
    catch (err) {
        log?.error?.(`[WeGirl:${accountId}] Redis connect failed:`, err.message);
        throw err;
    }
    // 2. 创建消费者组（如果不存在）
    try {
        await redis.xgroup('CREATE', streamKey, consumerGroup, '$', 'MKSTREAM');
        log?.info?.(`[WeGirl:${accountId}] Created consumer group: ${consumerGroup}`);
    }
    catch (err) {
        if (!err.message?.includes('already exists')) {
            log?.error?.(`[WeGirl:${accountId}] Failed to create consumer group:`, err.message);
            throw err;
        }
        log?.debug?.(`[WeGirl:${accountId}] Consumer group already exists: ${consumerGroup}`);
    }
    // 3. 顺序消费消息循环
    log?.info?.(`[WeGirl:${accountId}] Entering consume loop...`);
    while (!abortSignal?.aborted) {
        try {
            // 读取消息（阻塞 5 秒，每次只读 1 条，保证顺序）
            const result = await redis.xreadgroup('GROUP', consumerGroup, consumerName, 'BLOCK', 5000, 'COUNT', 1, 'STREAMS', streamKey, '>');
            if (!result || !Array.isArray(result) || result.length === 0) {
                continue;
            }
            // 解析结果
            const streamData = result[0];
            if (!streamData || !Array.isArray(streamData) || streamData.length < 2) {
                continue;
            }
            const entries = streamData[1];
            if (!entries || !Array.isArray(entries) || entries.length === 0) {
                continue;
            }
            // 处理消息（顺序处理，一次一条）
            for (const entry of entries) {
                if (!Array.isArray(entry) || entry.length < 2)
                    continue;
                const id = entry[0];
                const fields = entry[1];
                try {
                    // 解析 data 字段
                    let messageData = '';
                    if (Array.isArray(fields)) {
                        for (let i = 0; i < fields.length; i += 2) {
                            if (fields[i] === 'data' && i + 1 < fields.length) {
                                messageData = fields[i + 1];
                                break;
                            }
                        }
                    }
                    if (!messageData) {
                        log?.warn?.(`[WeGirl:${accountId}] No data field in message ${id}`);
                        await redis.xack(streamKey, consumerGroup, id);
                        continue;
                    }
                    const msg = JSON.parse(messageData);
                    log?.info?.(`[WeGirl:${accountId}] Processing message ${id}: ${msg.flowType} from ${msg.source}`);
                    // 调用 wegirlSessionsSend（使用 dispatchReplyWithBufferedBlockDispatcher）
                    await wegirlSessionsSend({
                        message: msg.message,
                        source: msg.source,
                        target: msg.target,
                        chatType: msg.chatType || 'direct',
                        groupId: msg.groupId,
                        routingId: msg.routingId,
                        taskId: msg.taskId,
                        stepId: msg.stepId,
                        stepTotalAgents: msg.stepTotalAgents,
                        msgType: msg.msgType,
                        payload: msg.payload,
                        metadata: msg.metadata,
                        replyTo: msg.replyTo,
                        fromType: 'outer', // 标记为外部调用
                        cfg,
                        channel: 'wegirl',
                        log,
                    });
                    // 确认消息已处理
                    await redis.xack(streamKey, consumerGroup, id);
                    log?.info?.(`[WeGirl:${accountId}] Message ${id} processed`);
                }
                catch (err) {
                    log?.error?.(`[WeGirl:${accountId}] Failed to process message ${id}:`, err.message);
                    // 不确认消息，让它保留在 pending 列表中，稍后重试
                }
            }
        }
        catch (err) {
            log?.error?.(`[WeGirl:${accountId}] Consumer error:`, err.message);
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }
    // 4. 清理
    log?.info?.(`[WeGirl:${accountId}] Monitor stopped`);
    await redis.quit();
}
//# sourceMappingURL=monitor.js.map