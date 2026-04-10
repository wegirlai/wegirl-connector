// src/channel.ts - Channel Plugin 定义（支持 health-monitor，每个 agent 独立监听 stream）
import { getWeGirlPluginConfig } from './config.js';
import { monitorWeGirlProvider } from './monitor.js';
// 全局状态跟踪
const channelStates = new Map();
/**
 * 获取或初始化 channel 状态
 */
function getChannelState(accountId) {
    if (!channelStates.has(accountId)) {
        channelStates.set(accountId, {
            running: false,
            connected: false,
            startedAt: 0,
        });
    }
    return channelStates.get(accountId);
}
/**
 * 启动 channel（设置 running 状态）
 * 简化版本：不测试实际 Redis 连接，只设置状态
 */
async function startChannel(accountId, log) {
    const state = getChannelState(accountId);
    if (state.running) {
        log?.debug?.(`[WeGirl:${accountId}] Channel already running`);
        return;
    }
    // 简化：直接设置状态，不测试实际连接
    // 因为 wegirl-connector 的消息处理在 register 中全局处理
    state.running = true;
    state.connected = true;
    state.startedAt = Date.now();
    log?.info?.(`[WeGirl:${accountId}] Channel started (ephemeral)`);
}
/**
 * 停止 channel
 */
async function stopChannel(accountId, log) {
    const state = getChannelState(accountId);
    state.running = false;
    state.connected = false;
    log?.info?.(`[WeGirl:${accountId}] Channel stopped`);
}
const wegirlPlugin = {
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
                const accounts = channelCfg?.accounts || {};
                const accountIds = Object.keys(accounts);
                return accountIds.length > 0 ? accountIds : ['default'];
            },
            resolveAccount: (cfg, id) => {
                const accountId = id || 'default';
                const pluginCfg = getWeGirlPluginConfig();
                const wegirlCfg = cfg?.channels?.['wegirl'] || {};
                const allowFrom = wegirlCfg?.allowFrom || ['*'];
                return {
                    accountId,
                    redisUrl: pluginCfg?.redisUrl || 'redis://localhost:6379',
                    redisPassword: pluginCfg?.redisPassword,
                    redisDb: pluginCfg?.redisDb ?? 1,
                    redisHost: pluginCfg?.redisHost || 'localhost',
                    redisPort: pluginCfg?.redisPort || 6379,
                    channel: 'wegirl:messages',
                    enabled: true,
                    allowFrom: Array.isArray(allowFrom) ? allowFrom : ['*']
                };
            },
            defaultAccountId: () => 'default',
            isEnabled: (account) => account?.enabled !== false,
            isConfigured: (account) => !!account?.accountId,
            describeAccount: (e) => {
                const state = getChannelState(e.accountId);
                return {
                    accountId: e.accountId,
                    enabled: e?.enabled !== false,
                    configured: !!e?.accountId,
                    linked: state.running,
                    running: state.running,
                    connected: state.connected,
                    startedAt: state.startedAt,
                };
            }
        },
        // Gateway 集成 - 启动/停止 channel
        gateway: {
            /**
             * 启动 channel account（OpenClaw 调用）
             * 每个 agent 独立监听自己的 Redis Stream
             *
             * ⚠️ 设计：此函数只启动 Stream 消费者（monitorWeGirlProvider）
             * 收到消息后调用 wegirlSessionsSend，由它内部完成 act（Agent 处理）
             * 这样实现接收和处理的解耦
             */
            async startAccount(ctx) {
                const accountId = ctx?.account?.accountId || 'default';
                const log = ctx?.log;
                const abortSignal = ctx?.abortSignal;
                log?.info?.(`[WeGirl:${accountId}] Gateway starting monitor...`);
                const pluginCfg = getWeGirlPluginConfig();
                const instanceId = pluginCfg?.instanceId || 'instance-local';
                // 启动 monitor（每个 agent 独立监听自己的 stream）
                return monitorWeGirlProvider({
                    accountId,
                    instanceId,
                    cfg: ctx.cfg,
                    abortSignal,
                    log
                });
            },
            /**
             * 停止 channel account（OpenClaw 调用）
             * 签名: (ctx: AccountContext) => Promise<void>
             */
            async stopAccount(ctx) {
                const accountId = ctx?.account?.accountId || 'default';
                const log = ctx?.log;
                log?.info?.(`[WeGirl:${accountId}] Gateway stopping channel...`);
                await stopChannel(accountId, log);
            }
        },
        // Outbound 投递器 - 处理 Agent 回复的消息
        outbound: {
            // 投递模式：direct = 同步投递，queued = 异步队列
            deliveryMode: 'direct',
            /**
             * 发送文本消息
             * 对于 wegirl channel，消息通过 Redis Stream 内部流转
             */
            async sendText(params) {
                const { text, to, accountId } = params;
                // wegirl 是内部 channel，消息通过 Redis Stream 处理
                // 这里只需要返回成功，实际的投递在 session-send.ts 中完成
                return {
                    ok: true,
                    messageId: `wegirl-${Date.now()}`,
                };
            },
            /**
             * 发送卡片消息（可选）
             */
            async sendCard(params) {
                return {
                    ok: true,
                    messageId: `wegirl-card-${Date.now()}`,
                };
            },
            /**
             * 更新消息（可选）
             */
            async updateMessage(params) {
                return {
                    ok: true,
                };
            }
        },
    }
};
export { wegirlPlugin, channelStates, startChannel, stopChannel };
//# sourceMappingURL=channel.js.map