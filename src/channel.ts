// src/channel.ts - Channel Plugin 定义（保留心跳，无 outbound）

import Redis from 'ioredis';
import { getWeGirlPluginConfig } from './config.js';
import { Registry } from './registry.js';

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

    gateway: {
      startAccount: async (ctx: any) => {
        const { cfg, accountId, abortSignal, log, setStatus } = ctx;
        const id = accountId || 'default';
        
        // 直接使用传入的 cfg
        const pluginCfg = cfg?.plugins?.entries?.wegirl?.config || {};
        const instanceId = pluginCfg?.instanceId || 'instance-local';

        log.info(`[WeGirl Channel]<${id}> Starting (instance: ${instanceId})`);

        // 统一从 openclaw.json 的 plugins.wegirl.config 读取 Redis 配置
        const redisUrl = pluginCfg?.redisUrl || 'redis://localhost:6379';
        const password = pluginCfg?.redisPassword;
        const db = pluginCfg?.redisDb ?? 1;

        const redisOptions: any = { db };
        if (password) redisOptions.password = password;

        // 创建 Redis 连接（用于心跳）
        const redis = new Redis(redisUrl, redisOptions);
        redis.on('error', (err: Error) => log.error('[WeGirl] Redis error:', err.message));

        // 等待连接就绪
        await new Promise<void>((resolve, reject) => {
          redis.once('ready', resolve);
          redis.once('error', (err) => reject(new Error(`Redis: ${err.message}`)));
          setTimeout(() => reject(new Error('Redis connect timeout')), 10000);
        });

        log.info('[WeGirl Channel] Redis connected');

        setStatus({ running: true });

        // 注册 Agent 心跳（每个 agent 独立）
        const registry = new Registry(redis, instanceId, log);
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
          } catch (err: any) {
            log.error(`[WeGirl Channel]<${id}> Heartbeat error:`, err.message);
          }
        }, 30000);

        // 等待终止信号
        await new Promise<void>((resolve) => {
          const onAbort = () => {
            log.info(`[WeGirl Channel]<${id}> Abort signal received, stopping...`);
            resolve();
          };
          if (abortSignal.aborted) {
            onAbort();
          } else {
            abortSignal.addEventListener('abort', onAbort, { once: true });
          }
        });

        // 清理
        clearInterval(heartbeatInterval);
        await registry.unregisterAgent(id);
        try {
          await redis.quit();
        } catch { /* ignore */ }
        setStatus({ running: false });
        log.info(`[WeGirl Channel]<${id}> Stopped`);
      }
    }
  }
};

export { wegirlPlugin };
