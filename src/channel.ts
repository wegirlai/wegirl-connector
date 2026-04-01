// src/channel.ts - Channel Plugin 定义（支持 health-monitor，每个 agent 独立监听 stream）

import { getWeGirlPluginConfig } from './config.js';
import { monitorWeGirlProvider } from './monitor.js';

// 全局状态跟踪
const channelStates = new Map<string, {
  running: boolean;
  connected: boolean;
  startedAt: number;
}>();

/**
 * 获取或初始化 channel 状态
 */
function getChannelState(accountId: string) {
  if (!channelStates.has(accountId)) {
    channelStates.set(accountId, {
      running: false,
      connected: false,
      startedAt: 0,
    });
  }
  return channelStates.get(accountId)!;
}

/**
 * 启动 channel（设置 running 状态）
 * 简化版本：不测试实际 Redis 连接，只设置状态
 */
async function startChannel(accountId: string, log?: any): Promise<void> {
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
async function stopChannel(accountId: string, log?: any): Promise<void> {
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
      chatTypes: ['direct' as const],
      threads: false,
      polls: false,
      ephemeral: true
    },
    config: {
      listAccountIds: (cfg: any) => {
        const channelCfg = cfg?.channels?.['wegirl'] || {};
        const accounts = channelCfg?.accounts || {};
        const accountIds = Object.keys(accounts);
        return accountIds.length > 0 ? accountIds : ['default'];
      },

      resolveAccount: (cfg: any, id: string | null) => {
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
      isEnabled: (account: any) => account?.enabled !== false,
      isConfigured: (account: any) => !!account?.accountId,

      describeAccount: (e: any) => {
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
       */
      async startAccount(ctx: any) {
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
      async stopAccount(ctx: any) {
        const accountId = ctx?.account?.accountId || 'default';
        const log = ctx?.log;
        
        log?.info?.(`[WeGirl:${accountId}] Gateway stopping channel...`);
        await stopChannel(accountId, log);
      }
    },
  }
};

export { wegirlPlugin, channelStates, startChannel, stopChannel };
