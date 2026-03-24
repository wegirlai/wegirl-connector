// src/channel.ts - Channel Plugin 定义
import Redis from 'ioredis';
import { setWeGirlPublisher, getWeGirlPublisher } from './runtime.js';
import { getGlobalConfig, getWeGirlPluginConfig, setGlobalConfig } from './config.js';
import { registerAgentReady, unregisterAgentReady } from './index.js';
const KEY_PREFIX = 'wegirl:';
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
                // 使用全局配置
                const pluginCfg = getWeGirlPluginConfig();
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
                const { cfg: ctxCfg, accountId, abortSignal, log, setStatus, runtime } = ctx;
                const id = accountId || 'default';
                // 如果 OpenClaw 传入了 cfg，直接设置到全局变量
                if (ctxCfg) {
                    setGlobalConfig(ctxCfg);
                    log.info(`[WeGirl Channel]<${id}> Global config set from startAccount ctx.cfg`);
                }
                // 使用全局配置
                const fullCfg = getGlobalConfig() || {};
                const pluginCfg = fullCfg?.plugins?.entries?.wegirl?.config || {};
                const instanceId = pluginCfg?.instanceId || 'instance-local';
                log.info(`[WeGirl Channel]<${id}> Starting (instance: ${instanceId})`);
                // 统一从 openclaw.json 的 plugins.wegirl.config 读取 Redis 配置
                const redisUrl = pluginCfg?.redisUrl || 'redis://localhost:6379';
                const password = pluginCfg?.redisPassword;
                const db = pluginCfg?.redisDb ?? 1;
                const redisOptions = { db };
                if (password)
                    redisOptions.password = password;
                // 创建发布者连接（用于 outbound）
                const publisher = new Redis(redisUrl, redisOptions);
                publisher.on('error', (err) => log.error('[WeGirl] publisher error:', err.message));
                // 等待连接就绪
                await new Promise((resolve, reject) => {
                    publisher.once('ready', resolve);
                    publisher.once('error', (err) => reject(new Error(`publisher: ${err.message}`)));
                    setTimeout(() => reject(new Error('publisher connect timeout')), 10000);
                });
                log.info('[WeGirl Channel] Redis publisher ready');
                setWeGirlPublisher(publisher);
                // 注册 agent 就绪状态到全局映射
                // 从 runtime 获取当前 sessionKey
                const sessionKey = runtime?.sessionKey || id;
                registerAgentReady(id, sessionKey, log);
                // 将 sessionKey 也写入 Redis，供全局消费者查找
                const KEY_PREFIX = 'wegirl:';
                await publisher.setex(`${KEY_PREFIX}agent:${id}:session`, 3600, sessionKey);
                log.info(`[WeGirl Channel]<${id}> Agent registered with session ${sessionKey}`);
                setStatus({ running: true });
                // 启动全局 Stream 消费者（每个 agent 独立消费组，只处理 target 匹配自己的消息）
                const globalStreamKey = `${KEY_PREFIX}stream:global`;
                const agentConsumerGroup = `wegirl-consumer-${id}`; // 每个 agent 独立的消费者组
                const agentConsumerName = `${id}-${instanceId}`;
                // 创建独立的消费者组（每个 agent 一个组）
                try {
                    await publisher.xgroup('CREATE', globalStreamKey, agentConsumerGroup, '$', 'MKSTREAM');
                    log.info(`[WeGirl Channel]<${id}> Created consumer group: ${agentConsumerGroup}`);
                }
                catch (err) {
                    if (!err.message?.includes('already exists')) {
                        log.error(`[WeGirl Channel]<${id}> Failed to create consumer group:`, err.message);
                    }
                }
                // Agent 消费循环 - 从全局 Stream 读取，过滤 target
                let agentRunning = true;
                const consumeAgentStream = async () => {
                    while (agentRunning && !abortSignal.aborted) {
                        try {
                            const results = await publisher.xreadgroup('GROUP', agentConsumerGroup, agentConsumerName, 'COUNT', 1, 'BLOCK', 5000, 'STREAMS', globalStreamKey, '>');
                            if (!results || results.length === 0)
                                continue;
                            for (const [, messages] of results) {
                                for (const [messageId, fields] of messages) {
                                    try {
                                        const fieldMap = {};
                                        for (let i = 0; i < fields.length; i += 2) {
                                            fieldMap[fields[i]] = fields[i + 1];
                                        }
                                        if (fieldMap.data) {
                                            const data = JSON.parse(fieldMap.data);
                                            // 只处理 target 匹配当前 agent 的消息
                                            const target = data.target;
                                            if (target !== id && target !== `${id}:notifier`) {
                                                log.debug(`[WeGirl Channel]<${id}> Skipping message for ${target}`);
                                                await publisher.xack(globalStreamKey, agentConsumerGroup, messageId);
                                                continue;
                                            }
                                            log.info(`[WeGirl Channel]<${id}> Processing message for self:`, data.flowType);
                                            // 使用 runtime 处理消息
                                            if (runtime?.processMessage) {
                                                await runtime.processMessage({
                                                    content: data.message,
                                                    metadata: {
                                                        source: data.source,
                                                        routingId: data.routingId,
                                                        flowType: data.flowType,
                                                        ...data.metadata
                                                    }
                                                });
                                            }
                                        }
                                        await publisher.xack(globalStreamKey, agentConsumerGroup, messageId);
                                    }
                                    catch (err) {
                                        log.error(`[WeGirl Channel]<${id}> Failed to process message:`, err.message);
                                        await publisher.xack(globalStreamKey, agentConsumerGroup, messageId);
                                    }
                                }
                            }
                        }
                        catch (err) {
                            log.error(`[WeGirl Channel]<${id}> Stream error:`, err.message);
                            await new Promise(r => setTimeout(r, 5000));
                        }
                    }
                };
                // 启动消费
                consumeAgentStream().catch(err => {
                    log.error(`[WeGirl Channel]<${id}> Agent consumer crashed:`, err.message);
                });
                log.info(`[WeGirl Channel]<${id}> Agent stream consumer started: ${globalStreamKey}`);
                // 等待终止信号
                await new Promise((resolve) => {
                    const onAbort = () => {
                        log.info(`[WeGirl Channel]<${id}> Abort signal received, stopping...`);
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
                agentRunning = false; // 停止 agent stream 消费者
                unregisterAgentReady(id, log);
                try {
                    await publisher.del(`${KEY_PREFIX}agent:${id}:session`);
                    await publisher.quit();
                }
                catch { /* ignore */ }
                setWeGirlPublisher(null);
                setStatus({ running: false });
                log.info(`[WeGirl Channel]<${id}> Stopped`);
            }
        }
    }
};
//# sourceMappingURL=channel.js.map