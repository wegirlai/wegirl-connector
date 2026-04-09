// src/event-handlers.ts - OpenClaw 事件处理器注册
// 事件通过 Pub/Sub 发布到 wegirl:events，不持久化存储

import type { PluginContext, PluginConfig } from './types.js';
import type Redis from 'ioredis';
import type { Registry } from './registry.js';
import { randomUUID } from 'crypto';

interface EventHandlerContext {
  context: PluginContext;
  logger: any;
  pluginConfig?: PluginConfig;
  getRedisClient: () => Redis | null;
  getRegistry: () => Registry | null;
  instanceId: string;
}

// 全局标记，防止重复注册事件处理器
let handlersRegistered = false;

/**
 * 重置事件处理器注册状态（用于插件热重载后重新注册）
 */
export function resetEventHandlers(): void {
  handlersRegistered = false;
}

/**
 * 注册所有 OpenClaw 事件处理器
 */
export function registerEventHandlers(ctx: EventHandlerContext, force: boolean = false): void {
  const { context, logger, pluginConfig, getRedisClient, getRegistry, instanceId } = ctx;

  // 防止重复注册（除非强制重新注册）
  if (handlersRegistered && !force) {
    logger.debug('[WeGirl] Event handlers already registered, skipping');
    return;
  }
  handlersRegistered = true;
  
  const keyPrefix = pluginConfig?.keyPrefix || 'openclaw:events:';

  // Agent 启动时自动注册到 wegirl
  context.on('before_agent_start', async (event: any) => {
    const agentId = event?.agentId;
    const registry = getRegistry();
    
    if (agentId && registry) {
      try {
        await registry.registerAgent(
          {
            agentId,
            name: agentId,
            capabilities: event.capabilities || ['general'],
            maxConcurrent: 3
          },
          {
            instanceId,
            version: '1.0'
          }
        );
        logger.info(`[WeGirl:${instanceId}] Agent auto-registered: ${agentId}`);
      } catch (err: any) {
        logger.error(`[WeGirl:${instanceId}] Agent registration failed:`, err.message);
      }
    }
    
    await persistEvent('before_agent_start', event, ctx);
  });

  // Agent 结束时注销
  context.on('agent_end', async (event: any) => {
    const agentId = event?.agentId;
    const registry = getRegistry();
    
    if (agentId && registry) {
      await registry.unregisterAgent(agentId);
      logger.info(`[WeGirl:${instanceId}] Agent unregistered: ${agentId}`);
    }
    
    await persistEvent('agent_end', event, ctx);
  });

  // 子 Agent 启动中
  context.on('subagent_spawning', (event: any) => {
    persistEvent('subagent_spawning', event, ctx);
  });

  // Agent 错误
  context.on('agent_error', (event: any) => {
    logger.error(`[WeGirl:${instanceId}] Event: agent_error`);
    persistEvent('agent_error', event, ctx);
  });

  // 收到消息
  context.on('message_received', (event: any) => {
    const content = event?.content || '';
    const preview = typeof content === 'string' 
      ? content.substring(0, 100) 
      : JSON.stringify(content).substring(0, 100);
    logger.info(`[WeGirl:${instanceId}] Event: message_received, content=${preview}${content.length > 100 ? '...' : ''}`);
    persistEvent('message_received', event, ctx);
  });

  // 发送消息
  context.on('message_sent', (event: any) => {
    logger.info(`[WeGirl:${instanceId}] Event: message_sent`);
    persistEvent('message_sent', event, ctx);
  });

  // 会话创建
  context.on('session_created', (event: any) => {
    logger.info(`[WeGirl:${instanceId}] Event: session_created`);
    persistEvent('session_created', event, ctx);
  });

  // 会话结束
  context.on('session_ended', (event: any) => {
    logger.info(`[WeGirl:${instanceId}] Event: session_ended`);
    persistEvent('session_ended', event, ctx);
  });

  // Tool 调用前 (兼容 2026.2.23)
  context.on('before_tool_call', (event: any) => {
    // 2026.2.23: event.tool, event.args
    // 2026.3.23: event.toolName, event.params
    const toolName = event?.toolName || event?.tool || 'unknown';
    const params = event?.params || event?.args || {};
    const target = extractTarget(toolName, params);

    logger.info(`[WeGirl Event:${instanceId}] before_tool_call - ${toolName} (${target})`);
    persistEvent('before_tool_call', event, ctx);
  });

  // Tool 调用后 (兼容 2026.2.23)
  context.on('after_tool_call', (event: any) => {
    // 2026.2.23: event.tool, event.args, event.duration
    // 2026.3.23: event.toolName, event.params, event.durationMs
    const toolName = event?.toolName || event?.tool || 'unknown';
    const params = event?.params || event?.args || {};
    const duration = event?.durationMs || event?.duration || 'unknown';
    const target = extractTarget(toolName, params);

    logger.info(`[WeGirl Event:${instanceId}] after_tool_call - ${toolName} (${target}) ${duration}ms`);
    persistEvent('after_tool_call', event, ctx);
  });

  logger.info(`[WeGirl:${instanceId}] Event handlers registered (10 events)`);
}

/**
 * 从工具参数中提取目标（文件路径或命令）
 * 支持多种可能的字段名
 */
function extractTarget(toolName: string, params: any): string {
  if (!params || typeof params !== 'object') return 'N/A';
  
  if (toolName === 'read' || toolName === 'edit' || toolName === 'write') {
    // read/write/edit 工具：提取文件路径
    const path = params?.file_path || params?.path || params?.filePath || 
                 params?.file_path || params?.filePath || params?.filepath ||
                 params?.target || params?.source;
    return path || `params:[${Object.keys(params).join(',')}]`;
  }
  
  // 其他工具：提取关键标识
  if (params?.command) return `${params.command}`;
  if (params?.url) return `url:${params.url.substring(0, 30)}`;
  if (params?.query) return `query:${params.query.substring(0, 30)}`;
  
  // 显示所有参数键
  const keys = Object.keys(params);
  if (keys.length === 0) return 'empty';
  if (keys.length <= 3) return `{${keys.join(',')}}`;
  return `{${keys.slice(0, 3).join(',')}...}`;
}

/**
 * 事件发布到 Redis Pub/Sub (不存储)
 */
async function persistEvent(
  eventType: string,
  payload: any,
  ctx: EventHandlerContext
): Promise<void> {
  const redisClient = ctx.getRedisClient();
  if (!redisClient || redisClient.status !== 'ready') return;

  const timestamp = Date.now();
  const eventId = randomUUID();

  // 在 payload 中添加 instanceId，方便识别来源
  const payloadWithInstance = {
    ...payload,
    _instanceId: ctx.instanceId,
    _wegirlInstance: true,
  };

  const eventData = {
    id: eventId,
    type: eventType,
    timestamp: timestamp.toString(),
    payload: JSON.stringify(payloadWithInstance),
    sessionId: payload?.sessionId || 'global',
    userId: payload?.userId || 'system',
    instanceId: ctx.instanceId,
  };

  // 发布到 Pub/Sub，不存储
  await redisClient.publish('wegirl:events', JSON.stringify(eventData));
}
