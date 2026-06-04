// src/monitor.ts - WeGirl Provider Monitor（每个 agent 独立监听自己的 stream）
import Redis from 'ioredis';
import { readFileSync } from 'fs';
import { stat, unlink } from 'fs/promises';
import { getWeGirlPluginConfig, getAccountBatchConsumers, getAgentSessionsDir } from './config.js';
import { wegirlSessionsSend } from './core/sessions-send.js';
// 全局：每个 instance 只起一个 cleanup worker
const activeCleanupWorkers = new Set();
const MIN_CLEANUP_AGE_MS = 10 * 60 * 1000; // 10分钟
/**
 * 启动 Cleanup Worker（按 instanceId 隔离，每个 instance 只起一个）
 * 扫描 Redis ZSet 中到期的 task session，删除 .jsonl 文件
 */
async function startCleanupWorker(params) {
    const { instanceId, cfg, abortSignal, log } = params;
    const queueKey = `wegirl:cleanup:sessions:${instanceId}`;
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
    try {
        await redis.connect();
    }
    catch (err) {
        log?.error?.(`[WeGirl Cleanup:${instanceId}] Redis connect failed:`, err.message);
        await redis.disconnect();
        return;
    }
    log?.info?.(`[WeGirl Cleanup:${instanceId}] Worker started, queue=${queueKey}`);
    while (!abortSignal?.aborted) {
        try {
            const now = Date.now();
            const items = await redis.zrangebyscore(queueKey, 0, now);
            for (const item of items) {
                const [sessionKey, agentId] = item.split('|');
                if (!sessionKey || !agentId) {
                    await redis.zrem(queueKey, item);
                    continue;
                }
                try {
                    // 1. 从 sessions.json 反查 sessionId
                    const sessionsDir = getAgentSessionsDir(cfg, agentId);
                    const sessionsJsonPath = `${sessionsDir}/sessions.json`;
                    let sessionId = null;
                    try {
                        const content = readFileSync(sessionsJsonPath, 'utf-8');
                        const map = JSON.parse(content);
                        sessionId = map[sessionKey]?.sessionId || null;
                    }
                    catch (err) {
                        log?.warn?.(`[WeGirl Cleanup:${instanceId}] Cannot read sessions.json for ${agentId}: ${err.message}`);
                    }
                    if (!sessionId) {
                        // OpenClaw 已自行清理或 session 不存在
                        await redis.zrem(queueKey, item);
                        continue;
                    }
                    // 2. 检查文件新鲜度（至少10分钟）
                    const jsonlFile = `${sessionsDir}/${sessionId}.jsonl`;
                    try {
                        const fileStat = await stat(jsonlFile);
                        const age = now - fileStat.mtimeMs;
                        if (age < MIN_CLEANUP_AGE_MS) {
                            log?.debug?.(`[WeGirl Cleanup:${instanceId}] ${sessionId}.jsonl too young (${Math.round(age / 1000)}s), skip`);
                            continue; // 保留在队列，等下一轮
                        }
                        // 3. 删除文件
                        await unlink(jsonlFile);
                        log?.info?.(`[WeGirl Cleanup:${instanceId}] Deleted ${sessionId}.jsonl (age: ${Math.round(age / 1000)}s)`);
                        await redis.zrem(queueKey, item);
                    }
                    catch (err) {
                        if (err.code === 'ENOENT') {
                            await redis.zrem(queueKey, item);
                        }
                        else {
                            log?.error?.(`[WeGirl Cleanup:${instanceId}] Failed to delete ${jsonlFile}:`, err.message);
                        }
                    }
                }
                catch (err) {
                    log?.error?.(`[WeGirl Cleanup:${instanceId}] Error processing ${item}:`, err.message);
                }
            }
        }
        catch (err) {
            log?.error?.(`[WeGirl Cleanup:${instanceId}] Worker scan error:`, err.message);
        }
        await new Promise(resolve => setTimeout(resolve, 30000));
    }
    log?.info?.(`[WeGirl Cleanup:${instanceId}] Worker stopped`);
    await redis.quit();
}
/**
 * 启动单个 Stream Consumer
 */
async function startSingleConsumer(params) {
    const { accountId, cfg, abortSignal, log, consumerName, streamKey, consumerGroup } = params;
    // 创建独立的 Redis 连接（XREADGROUP BLOCK 需要独立连接）
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
    // 1. 显式连接 Redis
    try {
        await redis.connect();
        log?.info?.(`[WeGirl:${accountId}] Consumer ${consumerName} Redis connected`);
    }
    catch (err) {
        log?.error?.(`[WeGirl:${accountId}] Consumer ${consumerName} Redis connect failed:`, err.message);
        await redis.disconnect();
        throw err;
    }
    // 2. 创建消费者组（幂等，已存在则忽略）
    try {
        await redis.xgroup('CREATE', streamKey, consumerGroup, '$', 'MKSTREAM');
        log?.info?.(`[WeGirl:${accountId}] Consumer ${consumerName} created group: ${consumerGroup}`);
    }
    catch (err) {
        if (!err.message?.includes('already exists')) {
            log?.error?.(`[WeGirl:${accountId}] Consumer ${consumerName} failed to create group:`, err.message);
            await redis.quit();
            throw err;
        }
        log?.debug?.(`[WeGirl:${accountId}] Consumer ${consumerName} group already exists: ${consumerGroup}`);
    }
    // 3. 消息接收循环
    log?.info?.(`[WeGirl:${accountId}] Consumer ${consumerName} entering consume loop...`);
    while (!abortSignal?.aborted) {
        try {
            // 读取消息（阻塞 5 秒，每次只读 1 条）
            const result = await redis.xreadgroup('GROUP', consumerGroup, consumerName, 'BLOCK', 5000, 'COUNT', 1, 'STREAMS', streamKey, '>');
            if (!result || !Array.isArray(result) || result.length === 0) {
                continue;
            }
            const streamData = result[0];
            if (!streamData || !Array.isArray(streamData) || streamData.length < 2) {
                continue;
            }
            const entries = streamData[1];
            if (!entries || !Array.isArray(entries) || entries.length === 0) {
                continue;
            }
            // 处理消息
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
                    log?.info?.(`[WeGirl:${accountId}] Consumer ${consumerName} received message ${id}`);
                    // ⚠️ 关键：调用 wegirlSessionsSend，由它内部完成 act
                    // 使用 await 确保处理完成后再 ACK，实现 at-least-once 语义
                    try {
                        await wegirlSessionsSend({
                            message: msg.message,
                            source: msg.source,
                            target: msg.target,
                            chatType: msg.chatType || 'direct',
                            groupId: msg.groupId,
                            routingId: msg.routingId,
                            messageId: msg.messageId,
                            taskId: msg.taskId,
                            stepId: msg.stepId,
                            stepTotalAgents: msg.stepTotalAgents,
                            msgType: msg.msgType,
                            payload: msg.payload,
                            metadata: msg.metadata,
                            replyTo: msg.replyTo,
                            flowType: msg.flowType,
                            replyContentType: msg.replyContentType || 'md',
                            fromType: 'outer',
                            cfg,
                            channel: 'wegirl',
                            log,
                        });
                        log?.info?.(`[WeGirl:${accountId}] Consumer ${consumerName} message ${id} processed`);
                        // ⚠️ 关键：处理成功后再 ACK
                        // 这样如果处理失败，消息会保留在 pending 列表中，可被重新消费
                        await redis.xack(streamKey, consumerGroup, id);
                        log?.debug?.(`[WeGirl:${accountId}] Consumer ${consumerName} message ${id} acknowledged`);
                    }
                    catch (err) {
                        log?.error?.(`[WeGirl:${accountId}] Consumer ${consumerName} message ${id} processing failed:`, err.message);
                        // 处理失败，不 ACK，消息会保留在 pending 列表中等待重试
                        // 注意：如果失败次数过多，可能需要人工介入清理
                    }
                }
                catch (err) {
                    log?.error?.(`[WeGirl:${accountId}] Consumer ${consumerName} failed to parse/ack message ${id}:`, err.message);
                }
            }
        }
        catch (err) {
            log?.error?.(`[WeGirl:${accountId}] Consumer ${consumerName} error:`, err.message);
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }
    // 4. 清理
    log?.info?.(`[WeGirl:${accountId}] Consumer ${consumerName} stopped`);
    await redis.quit();
}
/**
 * 监控 WeGirl Redis Stream（每个 agent 独立）
 * 支持 batchConsumers 配置启动多个并行 consumer
 *
 * ⚠️ 设计原则：
 * 1. 此函数从 Stream 接收消息
 * 2. 调用 wegirlSessionsSend 完成实际的 act（Agent 处理）
 * 3. 处理成功后才 ACK 消息（at-least-once 语义）
 * 4. 如果处理失败，消息保留在 pending 列表中，可被重新消费
 * 5. 多 consumer 时每个 consumer 有独立 Redis 连接，共享同一个 consumer group
 */
export async function monitorWeGirlProvider(params) {
    const { accountId, instanceId, cfg, abortSignal, log } = params;
    // 每个 agent 独立的 stream key 和消费者组
    const streamKey = `wegirl:stream:${instanceId}:${accountId}`;
    const consumerGroup = `wegirl-consumers-${instanceId}-${accountId}`;
    // 读取 batchConsumers 配置（默认 1）
    const consumerCount = getAccountBatchConsumers(cfg, accountId);
    log?.info?.(`[WeGirl:${accountId}] Starting ${consumerCount} consumer(s) for stream: ${streamKey}`);
    // 启动 cleanup worker（每个 instance 只起一个）
    if (!activeCleanupWorkers.has(instanceId)) {
        activeCleanupWorkers.add(instanceId);
        startCleanupWorker({ instanceId, cfg, abortSignal, log }).catch((err) => {
            log?.error?.(`[WeGirl Cleanup:${instanceId}] Worker crashed:`, err.message);
            activeCleanupWorkers.delete(instanceId);
        });
    }
    // 启动多个 consumer 并行运行
    const promises = [];
    for (let i = 0; i < consumerCount; i++) {
        const consumerName = `${accountId}-${i}-${Date.now()}`;
        promises.push(startSingleConsumer({
            ...params,
            consumerName,
            streamKey,
            consumerGroup,
        }));
    }
    await Promise.all(promises);
    log?.info?.(`[WeGirl:${accountId}] All ${consumerCount} consumer(s) stopped`);
}
//# sourceMappingURL=monitor.js.map