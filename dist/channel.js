// src/channel.ts - Channel Plugin 定义
import Redis from 'ioredis';
import { readFileSync } from 'fs';
import { join } from 'path';
import { setWeGirlPublisher, getWeGirlPublisher } from './runtime.js';
import { wegirlSessionsSend } from './core/sessions-send.js';
const KEY_PREFIX = 'wegirl:';
// 缓存 openclaw.json 配置
let openclawConfig = null;
/**
 * 从 openclaw.json 加载配置
 */
function loadOpenClawConfig() {
    if (openclawConfig)
        return openclawConfig;
    try {
        const configPath = join(process.env.HOME || '/root', '.openclaw', 'openclaw.json');
        const content = readFileSync(configPath, 'utf-8');
        openclawConfig = JSON.parse(content);
        return openclawConfig;
    }
    catch (err) {
        return null;
    }
}
export const wegirlPlugin = {
    plugin: {
        id: "wegirl",
        meta: {
            label: '微妞AI',
            selectionLabel: '微妞AI',
            docsPath: '/channels/wegirl',
            blurb: '微妞AI机器人，Agent 协作中枢。',
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
                // 统一从 openclaw.json 的 plugins.wegirl.config 读取
                const fullCfg = loadOpenClawConfig() || {};
                const pluginCfg = fullCfg?.plugins?.entries?.wegirl?.config || {};
                return {
                    accountId,
                    redisUrl: pluginCfg?.redisUrl || 'redis://localhost:6379',
                    redisPassword: pluginCfg?.redisPassword,
                    redisDb: pluginCfg?.redisDb ?? 1,
                    channel: 'wegirl:messages',
                    enabled: true
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
                    // 使用标准 V2 格式
                    await pub.publish('wegirl:replies', JSON.stringify({
                        flowType: 'A2H',
                        source: accountId || from || 'agent',
                        target: to,
                        message: text,
                        chatType: 'direct',
                        routingId: `wegirl-${Date.now()}`,
                        msgType: 'message',
                        metadata: {
                            sessionId,
                            originalFrom: from,
                        },
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
                const { accountId, abortSignal, log, setStatus } = ctx;
                const id = accountId || 'default';
                // 直接读取 openclaw.json 配置
                const fullCfg = loadOpenClawConfig() || {};
                const pluginCfg = fullCfg?.plugins?.entries?.wegirl?.config || {};
                const instanceId = pluginCfg?.instanceId || 'instance-local';
                log.info(`[WeGirl Channel]<${id}> Starting (instance: ${instanceId})`);
                // 统一从 openclaw.json 的 plugins.wegirl.config 读取 Redis 配置
                const redisUrl = pluginCfg?.redisUrl || 'redis://localhost:6379';
                const password = pluginCfg?.redisPassword;
                const db = pluginCfg?.redisDb ?? 1;
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
                // 异步等待连接就绪（不阻塞 CLI 命令）
                let connectionsReady = false;
                const connectPromise = Promise.all([
                    new Promise((resolve, reject) => {
                        streamClient.once('ready', resolve);
                        streamClient.once('error', (err) => reject(new Error(`streamClient: ${err.message}`)));
                        setTimeout(() => reject(new Error('streamClient connect timeout')), 10000);
                    }),
                    new Promise((resolve, reject) => {
                        publisher.once('ready', resolve);
                        publisher.once('error', (err) => reject(new Error(`publisher: ${err.message}`)));
                        setTimeout(() => reject(new Error('publisher connect timeout')), 10000);
                    })
                ]).then(() => {
                    connectionsReady = true;
                    log.info('[WeGirl Channel] Redis connections ready');
                    setWeGirlPublisher(publisher);
                }).catch((err) => {
                    log.error('[WeGirl Channel] Redis connection failed:', err.message);
                    // 不抛出错误，让 consumer 循环处理重连
                });
                // 创建消费者组（如果不存在）- 在连接就绪后执行
                const setupConsumerGroup = async () => {
                    await connectPromise;
                    if (!connectionsReady) {
                        log.warn(`[WeGirl Channel]<${id}> Skipping consumer group setup - Redis not connected`);
                        return;
                    }
                    try {
                        await streamClient.xgroup('CREATE', streamKey, consumerGroup, '$', 'MKSTREAM');
                        log.info(`[WeGirl Channel]<${id}> Created consumer group:,${consumerGroup}`);
                    }
                    catch (err) {
                        // 组已存在会报错，忽略
                        if (!err.message?.includes('already exists')) {
                            log.error(`[WeGirl Channel]<${id}> Failed to create consumer group: ${err.message}`);
                        }
                        else {
                            log.info(`[WeGirl Channel]<${id}> Consumer group exists: ${consumerGroup}`);
                        }
                    }
                };
                // 消息处理函数
                const handleMessage = async (data) => {
                    try {
                        // 只支持 V2 格式（flowType/source/target）
                        const flowType = data.flowType;
                        const source = data.source;
                        const target = data.target;
                        const message = data.message;
                        const chatType = data.chatType || 'direct';
                        const groupId = data.groupId;
                        const replyTo = data.replyTo;
                        const routingId = data.routingId;
                        // 验证必要字段
                        if (!flowType || !source || !target) {
                            log.warn(`[WeGirl Channel]<${id}> Invalid message format: missing flowType/source/target`, { keys: Object.keys(data) });
                            return;
                        }
                        log.info(`[WeGirl Channel]<${id}> Processing message: ${flowType} ${source} -> ${target}`);
                        // 直接调用 V1 核心层 wegirlSessionsSend，跳过 V2 转换
                        // 参数名与 wegirl_send 标准保持一致
                        try {
                            // 获取配置
                            const msgCfg = loadOpenClawConfig() || {};
                            await wegirlSessionsSend({
                                message,
                                source, // V2 source
                                target, // V2 target
                                chatType: chatType === 'group' ? 'group' : 'direct',
                                groupId: data.groupId || data.chatId,
                                routingId: routingId || `wegirl-${Date.now()}`,
                                taskId: data.taskId,
                                stepId: data.stepId,
                                stepTotalAgents: data.stepTotalAgents,
                                msgType: data.msgType,
                                payload: data.payload,
                                metadata: data.metadata,
                                // V1 内部字段
                                cfg: msgCfg,
                                channel: 'wegirl',
                                log,
                            });
                            log.info(`[WeGirl Channel]<${id}> Message delivered via wegirlSessionsSend: target=${target}`);
                        }
                        catch (sendErr) {
                            log.error(`[WeGirl Channel]<${id}> wegirlSessionsSend failed:`, sendErr.message);
                            throw sendErr; // 向上抛出，触发 ACK 和错误处理
                        }
                    }
                    catch (err) {
                        log.error(`[WeGirl Channel]<${id}> Failed to dispatch: ${err.message}`);
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
                    // 先等待连接就绪
                    await connectPromise;
                    if (!connectionsReady) {
                        log.error(`[WeGirl Channel]<${id}> Cannot start consumer - Redis connection failed`);
                        return;
                    }
                    // 确保消费者组已创建
                    await setupConsumerGroup();
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
                                        log.debug(`[WeGirl Channel]<${id}> Message ACKed: ${messageId}`);
                                    }
                                    catch (err) {
                                        log.error(`[WeGirl Channel]<${id}> Failed to process message ${messageId}:`, err.message);
                                        // 处理失败也要 ACK，避免消息无限重试
                                        try {
                                            await streamClient.xack(streamKey, consumerGroup, messageId);
                                            log.debug(`[WeGirl Channel]<${id}> Message ACKed after error: ${messageId}`);
                                        }
                                        catch (ackErr) {
                                            log.error(`[WeGirl Channel]<${id}> Failed to ACK message ${messageId}:`, ackErr.message);
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