// src/channel.ts - Channel Plugin 定义
import Redis from 'ioredis';
import { setWeGirlPublisher, getWeGirlPublisher } from './runtime.js';
import { wegirlSessionsSend } from './sessions-send.js';
const KEY_PREFIX = 'wegirl:';
export const wegirlPlugin = {
    plugin: {
        id: "wegirl",
        meta: {
            label: '微妞AI',
            selectionLabel: '微妞AI',
            docsPath: '/channels/wegirl',
            blurb: '微妞AI机器人，可连接飞书。',
        },
        capabilities: {
            chatTypes: ['direct'],
            threads: false,
            polls: false,
            ephemeral: true
        },
        config: {
            listAccountIds: (cfg) => {
                const channelCfg = cfg?.channels?.['wegirl'] || {};
                if (channelCfg?.accounts) {
                    return Object.keys(channelCfg.accounts);
                }
                return ['default'];
            },
            resolveAccount: (cfg, id) => {
                const accountId = id || 'default';
                const channelCfg = cfg?.channels?.['wegirl'] || {};
                const accountCfg = channelCfg?.accounts?.[accountId] || {};
                return {
                    accountId,
                    redisUrl: accountCfg?.redisUrl || channelCfg?.redisUrl || cfg?.redisUrl || process.env.REDIS_URL || `redis://${process.env.REDIS_HOST || 'localhost'}:${process.env.REDIS_PORT || '6379'}`,
                    redisPassword: accountCfg?.redisPassword || channelCfg?.redisPassword || cfg?.redisPassword || process.env.REDIS_PASSWORD,
                    redisDb: accountCfg?.redisDb !== undefined ? accountCfg.redisDb : channelCfg?.redisDb !== undefined ? channelCfg.redisDb : cfg?.redisDb !== undefined ? cfg.redisDb : 1,
                    channel: accountCfg?.channel || channelCfg?.channel || 'wegirl:messages',
                    enabled: accountCfg?.enabled !== false
                };
            },
            defaultAccountId: () => 'default',
            isEnabled: (account) => account?.enabled !== false,
            isConfigured: (account) => !!account?.accountId,
            describeAccount: (e) => ({
                accountId: e.accountId,
                enabled: e?.enabled !== false,
                configured: !!e?.accountId,
                linked: true,
            })
        },
        outbound: {
            deliveryMode: 'direct',
            sendText: async ({ text, to, from, accountId, sessionId }, log) => {
                log?.info?.(`[WeGirl outbound] text="${text?.substring(0, 50)}", to=${to}`);
                const pub = getWeGirlPublisher();
                if (!pub || pub.status !== 'ready') {
                    return { ok: false, error: 'Redis publisher not connected' };
                }
                try {
                    await pub.publish('wegirl:replies', JSON.stringify({
                        id: `wegirl-${Date.now()}`,
                        type: 'message',
                        content: text,
                        to, from: from || 'agent', sessionId, accountId,
                        timestamp: Date.now(),
                    }));
                    return { ok: true };
                }
                catch (err) {
                    return { ok: false, error: err.message };
                }
            }
        },
        gateway: {
            startAccount: async (ctx) => {
                const { cfg, accountId, account, abortSignal, log, setStatus } = ctx;
                const id = accountId || 'default';
                const instanceId = cfg?.plugins?.entries?.wegirl?.config?.instanceId
                    || process.env.OPENCLAW_INSTANCE_ID
                    || 'instance-local';
                log.info(`[WeGirl Channel] Starting: ${id} (instance: ${instanceId})`);
                const redisUrl = account?.redisUrl || 'redis://localhost:6379';
                // 优先从 plugin config 读取密码，其次从 account，最后环境变量
                const password = cfg?.plugins?.entries?.wegirl?.config?.redisPassword
                    || account?.redisPassword
                    || process.env.REDIS_PASSWORD;
                const db = account?.redisDb || cfg?.plugins?.entries?.wegirl?.config?.redisDb || 1;
                const streamKey = `${KEY_PREFIX}stream:instance:${instanceId}`;
                const consumerGroup = 'wegirl-consumers';
                // 使用 accountId + instanceId 作为唯一 consumer 名称，避免多个 account 互相覆盖
                const consumerName = `${id}:${instanceId}`;
                const redisOptions = { db };
                if (password)
                    redisOptions.password = password;
                // 两个连接：一个用于 Stream 消费，一个用于发布
                const streamClient = new Redis(redisUrl, redisOptions);
                const publisher = new Redis(redisUrl, redisOptions);
                streamClient.on('error', (err) => log.error('[WeGirl] stream error:', err.message));
                publisher.on('error', (err) => log.error('[WeGirl] publisher error:', err.message));
                // 等待连接就绪
                await Promise.all([
                    new Promise((resolve, reject) => {
                        streamClient.once('ready', resolve);
                        streamClient.once('error', reject);
                        setTimeout(() => reject(new Error('streamClient connect timeout')), 10000);
                    }),
                    new Promise((resolve, reject) => {
                        publisher.once('ready', resolve);
                        publisher.once('error', reject);
                        setTimeout(() => reject(new Error('publisher connect timeout')), 10000);
                    })
                ]);
                log.info('[WeGirl Channel] Redis connections ready');
                setWeGirlPublisher(publisher);
                // 创建消费者组（如果不存在）
                try {
                    await streamClient.xgroup('CREATE', streamKey, consumerGroup, '$', 'MKSTREAM');
                    log.info(`[WeGirl Channel] Created consumer group: ${consumerGroup}`);
                }
                catch (err) {
                    // 组已存在会报错，忽略
                    if (!err.message?.includes('already exists')) {
                        log.error('[WeGirl Channel] Failed to create consumer group:', err.message);
                    }
                    else {
                        log.info(`[WeGirl Channel] Consumer group exists: ${consumerGroup}`);
                    }
                }
                // 消息处理函数
                const handleMessage = async (data) => {
                    try {
                        await wegirlSessionsSend({
                            message: data.message, cfg,
                            channel: data.channel, accountId: data.accountId,
                            from: data.from, chatId: data.chatId, chatType: data.chatType, log,
                            // 传递原始 routingId 和 messageId，用于回复关联
                            routingId: data.routingId,
                            messageId: data.messageId,
                            // 传递原始 metadata（包含 feishuOpenId 等）
                            metadata: data.metadata,
                            // 群聊多 agent 参数
                            taskId: data.taskId,
                            agentCount: data.agentCount,
                            currentAgentId: data.currentAgentId,
                        });
                        log.info(`[WeGirl Channel] Message delivered from stream: ${data.routingId || 'unknown'}`);
                    }
                    catch (err) {
                        log.error('[WeGirl Channel] Failed to dispatch:', err.message);
                    }
                };
                // Stream 消费循环 - 增强鲁棒性版本
                let running = true;
                let consecutiveErrors = 0;
                const MAX_CONSECUTIVE_ERRORS = 10;
                const ERROR_RESET_INTERVAL = 60000; // 60秒后重置错误计数
                // 定时重置错误计数
                const errorResetTimer = setInterval(() => {
                    if (consecutiveErrors > 0) {
                        consecutiveErrors = 0;
                        log.info('[WeGirl Channel] Error counter reset');
                    }
                }, ERROR_RESET_INTERVAL);
                const consumeStream = async () => {
                    while (running && !abortSignal.aborted) {
                        try {
                            // XREADGROUP: 从消费者组读取消息
                            const results = await streamClient.xreadgroup('GROUP', consumerGroup, consumerName, 'COUNT', 1, 'BLOCK', 5000, // 阻塞5秒
                            'STREAMS', streamKey, '>' // 只读取新消息（未分配给任何消费者的消息）
                            );
                            // 成功读取，重置错误计数
                            consecutiveErrors = 0;
                            if (!results || results.length === 0) {
                                // 没有消息时静默处理，不输出日志
                                continue;
                            }
                            // 解析结果: [[streamKey, [[id, [field, value, ...]], ...]]]
                            for (const [, messages] of results) {
                                for (const [messageId, fields] of messages) {
                                    try {
                                        // fields 是 [key, value, key, value...] 格式
                                        const fieldMap = {};
                                        for (let i = 0; i < fields.length; i += 2) {
                                            fieldMap[fields[i]] = fields[i + 1];
                                        }
                                        if (fieldMap.data) {
                                            const data = JSON.parse(fieldMap.data);
                                            // 添加超时控制，防止处理卡住
                                            await Promise.race([
                                                handleMessage(data),
                                                new Promise((_, reject) => setTimeout(() => reject(new Error('Message handling timeout')), 60000))
                                            ]);
                                        }
                                        // ACK 消息（确认已处理）
                                        await streamClient.xack(streamKey, consumerGroup, messageId);
                                        log.debug(`[WeGirl Channel] Message ACKed: ${messageId}`);
                                    }
                                    catch (err) {
                                        log.error(`[WeGirl Channel] Failed to process message ${messageId}:`, err.message);
                                        // 处理失败也要 ACK，避免消息无限重试
                                        try {
                                            await streamClient.xack(streamKey, consumerGroup, messageId);
                                            log.debug(`[WeGirl Channel] Message ACKed after error: ${messageId}`);
                                        }
                                        catch (ackErr) {
                                            log.error(`[WeGirl Channel] Failed to ACK message ${messageId}:`, ackErr.message);
                                        }
                                    }
                                }
                            }
                        }
                        catch (err) {
                            consecutiveErrors++;
                            if (err.message?.includes('Connection') || err.message?.includes('ECONNREFUSED')) {
                                log.error(`[WeGirl Channel] Redis connection error (${consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS}), retrying in ${Math.min(consecutiveErrors * 2, 30)}s...`);
                                await sleep(Math.min(consecutiveErrors * 2000, 30000));
                            }
                            else if (err.message?.includes('NOGROUP') || err.message?.includes('consumer group')) {
                                log.error('[WeGirl Channel] Consumer group error, attempting to recreate...');
                                try {
                                    await streamClient.xgroup('CREATE', streamKey, consumerGroup, '$', 'MKSTREAM');
                                    log.info('[WeGirl Channel] Consumer group recreated');
                                    consecutiveErrors = 0;
                                }
                                catch (createErr) {
                                    log.error('[WeGirl Channel] Failed to recreate consumer group:', createErr.message);
                                    await sleep(5000);
                                }
                            }
                            else if (!running || abortSignal.aborted) {
                                log.info('[WeGirl Channel] Stopping consumer loop');
                                break;
                            }
                            else {
                                log.error(`[WeGirl Channel] Stream read error (${consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS}):`, err.message);
                                await sleep(Math.min(consecutiveErrors * 1000, 10000));
                            }
                            // 连续错误过多，主动退出让 Gateway 重启
                            if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
                                log.error(`[WeGirl Channel] Too many consecutive errors (${consecutiveErrors}), stopping consumer`);
                                running = false;
                                break;
                            }
                        }
                    }
                };
                // 启动消费 - 带错误隔离
                let consumeError = null;
                const consumePromise = consumeStream().catch(err => {
                    consumeError = err;
                    log.error('[WeGirl Channel] Consumer promise rejected:', err.message);
                });
                log.info(`[WeGirl Channel] Stream consumer started: ${streamKey}`);
                setStatus({ running: true });
                // 健康检查定时器
                const healthCheckTimer = setInterval(async () => {
                    try {
                        await publisher.ping();
                        // 检查 consumer 是否还在运行
                        if (!running || consumeError) {
                            log.error('[WeGirl Channel] Consumer not healthy, triggering restart');
                            clearInterval(healthCheckTimer);
                        }
                    }
                    catch (err) {
                        log.error('[WeGirl Channel] Health check failed:', err.message);
                    }
                }, 30000);
                // 等待终止信号
                await new Promise((resolve) => {
                    const onAbort = () => {
                        log.info('[WeGirl Channel] Abort signal received, stopping...');
                        resolve();
                    };
                    if (abortSignal.aborted) {
                        onAbort();
                    }
                    else {
                        abortSignal.addEventListener('abort', onAbort, { once: true });
                    }
                });
                // 清理
                running = false;
                clearInterval(errorResetTimer);
                clearInterval(healthCheckTimer);
                setWeGirlPublisher(null);
                try {
                    await streamClient.quit();
                }
                catch { /* ignore */ }
                try {
                    await publisher.quit();
                }
                catch { /* ignore */ }
                setStatus({ running: false });
                log.info('[WeGirl Channel] Stopped');
            }
        }
    }
};
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
//# sourceMappingURL=channel.js.map