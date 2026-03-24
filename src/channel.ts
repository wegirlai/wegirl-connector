// src/channel.ts - Channel Plugin 定义（最小化版本，无 outbound/startAccount）

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
      chatTypes: ['direct' as const],
      threads: false,
      polls: false,
      ephemeral: true
    },
    config: {
      listAccountIds: (cfg: any) => {
        const channelCfg = cfg?.channels?.['wegirl'] || {};
        if (channelCfg?.accounts) {
          return Object.keys(channelCfg.accounts);
        }
        return ['default'];
      },

      resolveAccount: (cfg: any, id: string | null) => {
        const accountId = id || 'default';
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
      isEnabled: (account: any) => account?.enabled !== false,
      isConfigured: (account: any) => !!account?.accountId,

      describeAccount: (e: any) => ({
        accountId: e.accountId,
        enabled: e?.enabled !== false,
        configured: !!e?.accountId,
        linked: true,
      })
    },

    // 无 outbound - 单一渠道，不发送消息到其他渠道
    // 无 gateway.startAccount - 消息处理在 register 中全局处理
  }
};

export { wegirlPlugin };
