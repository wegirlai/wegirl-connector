// src/channel.ts - Channel Plugin 定义（最小化版本）
import { getWeGirlPluginConfig } from './config.js';
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
                // 确保 allowFrom 始终是数组
                const wegirlCfg = cfg?.channels?.['wegirl'] || {};
                const allowFrom = wegirlCfg?.allowFrom || ['*'];
                return {
                    accountId,
                    redisUrl: pluginCfg?.redisUrl || 'redis://localhost:6379',
                    redisPassword: pluginCfg?.redisPassword,
                    redisDb: pluginCfg?.redisDb ?? 1,
                    channel: 'wegirl:messages',
                    enabled: true,
                    allowFrom: Array.isArray(allowFrom) ? allowFrom : ['*']
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
        // 无 outbound - 单一渠道
        // 无 gateway.startAccount - 消息处理在 register 中全局处理
    }
};
export { wegirlPlugin };
//# sourceMappingURL=channel.js.map