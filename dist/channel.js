// src/channel.ts - Channel Plugin 定义
import Redis from 'ioredis';
import { setWeGirlPublisher, getWeGirlPublisher } from './runtime.js';
import { getWeGirlPluginConfig } from './config.js';
import { Registry } from './registry.js';
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
                const { cfg, accountId, abortSignal, log, setStatus, runtime } = ctx;
                const id = accountId || 'default';
                // 直接使用传入的 cfg
                const pluginCfg = cfg?.plugins?.entries?.wegirl?.config || {};
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
                setStatus({ running: true });
                // 注册 Agent 心跳（每个 agent 独立）
                const registry = new Registry(publisher, instanceId, log);
                await registry.register({
                    staffId: id,
                    type: 'agent',
                    name: id,
                    capabilities: [],
                    maxConcurrent: 3,
                });
                log.info(`[WeGirl Channel]<${id}> Agent heartbeat registered`);
                // 启动心跳定时器
                const heartbeatInterval = setInterval(async () => {
                    try {
                        await registry.heartbeat(id);
                    }
                    catch (err) {
                        log.error(`[WeGirl Channel]<${id}> Heartbeat error:`, err.message);
                    }
                }, 30000);
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
                clearInterval(heartbeatInterval);
                await registry.unregisterAgent(id);
                try {
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