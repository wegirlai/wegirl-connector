// src/tools.ts - wegirl_send 工具实现

import Redis from 'ioredis';
import { randomUUID } from 'crypto';
import { wegirlSessionsSend } from './sessions-send.js';
import { getWeGirlRuntime } from './runtime.js';
import { readFileSync } from 'fs';
import { join } from 'path';

const KEY_PREFIX = 'wegirl:';

// 缓存 openclaw.json 配置
let openclawConfig: any = null;

function loadOpenClawConfig(): any {
  if (openclawConfig) return openclawConfig;
  try {
    const configPath = join(process.env.HOME || '/root', '.openclaw', 'openclaw.json');
    const content = readFileSync(configPath, 'utf-8');
    openclawConfig = JSON.parse(content);
    return openclawConfig;
  } catch (err: any) {
    return null;
  }
}
interface RoutingTarget {
  mode: 'agent' | 'human' | 'capability' | 'workflow' | 'broadcast';
  agentId?: string;
  userId?: string;
  capability?: string;
  strategy?: string;
  workflowId?: string;
  step?: number;
}

interface MessageMetadata {
  msgId: string;
  routingId: string;
  timestamp: number;
  priority: string;
  ttl: number;
}

interface MessageAddress {
  type: string;
  agentId?: string;
  userId?: string;
  capability?: string;
}

interface MessagePayload {
  format: string;
  content: string;
}

interface MessageEnvelope {
  metadata: MessageMetadata;
  from: { type: string; agentId: string; instanceId: string };
  to: MessageAddress;
  type: string;
  payload: MessagePayload;
}

interface WeGirlSendParams {
  target: string;
  message: string;
  channel?: string;
  accountId?: string;
  chatId?: string;
  chatType?: string;
  from?: string;
  // 回复路由信息 - 让接收者知道应该往哪里回复
  replyChannel?: string;
  replyAccountId?: string;
  replyTo?: string;
}

export class WeGirlTools {
  private redis: Redis;
  private logger: any;
  private instanceId: string;

  constructor(redis: Redis, instanceId: string, logger: any) {
    this.redis = redis;
    this.instanceId = instanceId;
    this.logger = logger;
  }

  // 解析 target 字符串
  private parseTarget(target: string): RoutingTarget {
    if (target.startsWith('agent:')) {
      return { mode: 'agent', agentId: target.slice(6) };
    }
    if (target.startsWith('human:')) {
      return { mode: 'human', userId: target.slice(6) };
    }
    if (target.startsWith('capability:')) {
      const parts = target.split(':');
      return { mode: 'capability', capability: parts[1], strategy: (parts[2] as any) || 'least-load' };
    }
    if (target.startsWith('workflow:')) {
      const parts = target.split(':');
      return { mode: 'workflow', workflowId: parts[1], step: parts[2] ? parseInt(parts[2]) : undefined };
    }
    if (target === 'broadcast') {
      return { mode: 'broadcast' };
    }
    // 人类用户ID (ou_ 开头)
    if (target.startsWith('ou_')) {
      return { mode: 'human', userId: target };
    }
    // 无前缀，默认当作 agent 处理 (如 hr-notifier, default)
    return { mode: 'agent', agentId: target };
  }

  // wegirl_send 工具主入口
  async send(params: WeGirlSendParams): Promise<any> {
    const { target, message } = params;
    const routingId = randomUUID();
    const startTime = Date.now();

    this.logger.info(`[WeGirlTools] [${routingId}] Sending message to ${target}`);

    // 发布转交开始事件
    await this.publishRoutingEvent(routingId, 'started', {
      target,
      messageLength: message.length,
      from: params.from || 'unknown',
      instanceId: this.instanceId
    });

    const routingTarget = this.parseTarget(target);

    // 发布路由解析事件
    await this.publishRoutingEvent(routingId, 'parsed', {
      mode: routingTarget.mode,
      agentId: routingTarget.agentId,
      userId: routingTarget.userId,
      capability: routingTarget.capability
    });

    const envelope: MessageEnvelope = {
      metadata: {
        msgId: randomUUID(),
        routingId,
        timestamp: Date.now(),
        priority: 'normal',
        ttl: 3600
      },
      from: {
        type: 'agent',
        agentId: params.from || 'unknown',
        instanceId: this.instanceId
      },
      to: this.buildAddress(routingTarget),
      type: 'event',
      payload: { format: 'text', content: message }
    };

    try {
      let result: any;
      switch (routingTarget.mode) {
        case 'agent':
          result = await this.deliverToAgent(routingTarget.agentId!, envelope, params, routingId);
          break;
        case 'human':
          result = await this.deliverToHuman(routingTarget.userId!, envelope, params, routingId);
          break;
        case 'capability':
          result = await this.deliverToCapability(routingTarget.capability!, routingTarget.strategy!, envelope, params, routingId);
          break;
        case 'broadcast':
          result = await this.broadcast(envelope, params, routingId);
          break;
        default:
          throw new Error(`Unsupported routing mode: ${routingTarget.mode}`);
      }

      // 发布成功事件
      await this.publishRoutingEvent(routingId, 'completed', {
        duration: Date.now() - startTime,
        result
      });

      // 返回 OpenClaw 期望的格式
      const resultText = result.success 
        ? `消息已发送给 ${target}: ${result.target || target}`
        : `发送失败: ${result.error || '未知错误'}`;
      
      return {
        content: [{ type: "text" as const, text: resultText }],
        details: {
          success: result.success,
          target: result.target,
          routingId,
          ...result
        }
      };
    } catch (error: any) {
      // 发布失败事件
      await this.publishRoutingEvent(routingId, 'failed', {
        error: error.message,
        duration: Date.now() - startTime
      });
      throw error;
    }
  }

  // 发布转交过程事件到 Redis
  private async publishRoutingEvent(
    routingId: string, 
    stage: string, 
    data: any
  ): Promise<void> {
    const event = {
      type: 'routing_event',
      routingId,
      stage,
      timestamp: Date.now(),
      instanceId: this.instanceId,
      data
    };

    try {
      await this.redis.publish(`${KEY_PREFIX}routing`, JSON.stringify(event));
      this.logger.debug(`[WeGirlTools] [${routingId}] Routing event published: ${stage}`);
    } catch (err: any) {
      this.logger.warn(`[WeGirlTools] Failed to publish routing event: ${err.message}`);
    }
  }

  // wegirl_register 工具
  async register(params: any): Promise<any> {
    const { agentId, name, capabilities, maxConcurrent } = params;
    
    const agentData = {
      agentId,
      name: name || agentId,
      instanceId: this.instanceId,
      status: 'online',
      capabilities: Array.isArray(capabilities) ? capabilities.join(',') : capabilities,
      maxConcurrent: maxConcurrent || 3,
      lastHeartbeat: Date.now()
    };

    await this.redis.hset(`${KEY_PREFIX}agents:${agentId}`, agentData);
    
    if (capabilities) {
      const caps = Array.isArray(capabilities) ? capabilities : capabilities.split(',');
      for (const cap of caps) {
        if (cap.trim()) {
          await this.redis.sadd(`${KEY_PREFIX}capability:${cap}`, agentId);
        }
      }
    }

    this.logger.info(`[WeGirlTools] Agent registered: ${agentId}`);
    return { success: true, agentId, instanceId: this.instanceId };
  }

  // wegirl_query 工具
  async query(params: any): Promise<any> {
    const { type, capability, agentId } = params;
    
    if (type === 'agents') {
      const keys = await this.redis.keys(`${KEY_PREFIX}agents:*`);
      const agents = await Promise.all(
        keys.map(async (key) => {
          const data = await this.redis.hgetall(key);
          return {
            agentId: data.agentId,
            name: data.name,
            status: data.status,
            capabilities: data.capabilities?.split(',') || []
          };
        })
      );
      return { agents: agents.filter(a => a.agentId) };
    }
    
    if (type === 'capability' && capability) {
      const agentIds = await this.redis.smembers(`${KEY_PREFIX}capability:${capability}`);
      return { capability, agents: agentIds };
    }
    
    if (type === 'agent' && agentId) {
      const data = await this.redis.hgetall(`${KEY_PREFIX}agents:${agentId}`);
      return { 
        agent: data.agentId ? {
          ...data,
          capabilities: data.capabilities?.split(',') || []
        } : null
      };
    }
    
    return { error: 'Unknown query type' };
  }

  private buildAddress(target: RoutingTarget): MessageAddress {
    switch (target.mode) {
      case 'agent':
        return { type: 'agent', agentId: target.agentId! };
      case 'human':
        return { type: 'human', userId: target.userId! };
      case 'capability':
        return { type: 'capability', capability: target.capability! };
      default:
        return { type: 'broadcast' };
    }
  }

  private async deliverToAgent(agentId: string, envelope: MessageEnvelope, params: WeGirlSendParams, routingId: string): Promise<any> {
    // 发布查询 agent 事件
    await this.publishRoutingEvent(routingId, 'agent_lookup', { agentId });

    // 使用 staff 而不是 agents
    const agentData = await this.redis.hgetall(`${KEY_PREFIX}staff:${agentId}`);

    if (!agentData.staffId) {
      await this.publishRoutingEvent(routingId, 'agent_not_found', { agentId });
      throw new Error(`Agent not found: ${agentId}`);
    }

    const targetInstanceId = agentData.instanceId;
    const isLocal = targetInstanceId === this.instanceId;

    await this.publishRoutingEvent(routingId, 'agent_found', {
      agentId,
      targetInstanceId,
      local: isLocal
    });

    // 本实例直接调用 sessionsSend，跨实例走 Redis
    if (isLocal) {
      await this.publishRoutingEvent(routingId, 'local_delivery', { agentId });

      try {
        // 获取发送者信息（从 envelope.from 或 params 中获取）
        const senderId = envelope.from.agentId || params.from || 'unknown';
        const senderChannel = params.channel || 'wegirl';
        const senderAccountId = params.accountId || 'default';
        
        // 关键：确定回复路由
        // 1. 如果 params 中指定了 replyChannel/replyAccountId，使用它们
        // 2. 否则，使用发送者的 channel/accountId
        const replyChannel = params.replyChannel || senderChannel;
        const replyAccountId = params.replyAccountId || senderAccountId;
        const replyTo = params.replyTo || senderId;
        
        this.logger.info(`[WeGirlTools] Sending message: sender=${senderId}, target=${agentId}, replyTo=${replyTo}`);
        
        // 使用 wegirlSessionsSend 发送消息给 agent
        // 关键：设置 OriginatingChannel 和 OriginatingTo，让回复能路由回发送者
        // 关键：chatId 设为空，避免 peer 影响路由判断
        // 关键：accountId 应该是目标 agentId（如 scout），用于匹配 binding
        // 关键：加载完整配置，包含 bindings
        const fullCfg = loadOpenClawConfig() || {
          channels: {
            wegirl: {
              accounts: {
                [replyAccountId]: {
                  enabled: true,
                  redisUrl: process.env.REDIS_URL || `redis://${process.env.REDIS_HOST || 'localhost'}:${process.env.REDIS_PORT || '6379'}`
                }
              }
            }
          }
        };
        
        // 关键：私聊调用其他 agent 时，清空 chatId 触发广播模式
        // 群聊时保留 chatId，让回复回到群里
        const isGroupChat = params.chatType === 'group';
        const effectiveChatId = isGroupChat ? (params.chatId || '') : '';
        
        wegirlSessionsSend({
          message: params.message,
          cfg: fullCfg,  // 使用完整配置
          channel: 'wegirl',  // 关键：强制使用 'wegirl' 确保回复能正确路由
          accountId: agentId,  // 关键：使用目标 agentId（scout），不是 senderAccountId
          from: senderId,
          chatId: effectiveChatId,  // 群聊保留，私聊清空触发广播
          chatType: params.chatType || 'direct',  // 使用 direct 避免 group 路由
          // 关键：设置 metadata，让回复能路由回发送者
          metadata: {
            originatingChannel: replyChannel,  // 实际回复目标 channel
            originatingTo: replyTo,
            originatingAccountId: replyAccountId,
            replyTo: replyTo,
          },
          log: this.logger
        }).catch((err: any) => {
          this.logger.error(`[WeGirlTools] wegirlSessionsSend failed:`, err.message);
        });

        await this.publishRoutingEvent(routingId, 'local_delivered', { agentId });

        return {
          success: true,
          target: `agent:${agentId}`,
          targetInstanceId,
          local: true,
          messageLength: params.message.length,
          routingId
        };
      } catch (err: any) {
        await this.publishRoutingEvent(routingId, 'local_failed', { error: err.message });
        throw err;
      }
    }

    // 跨实例：通过 Redis Stream 发布（持久化）
    // 关键：私聊调用其他 agent 时，清空 chatId 触发广播模式
    const isGroupChatRemote = params.chatType === 'group';
    const effectiveChatIdRemote = isGroupChatRemote ? (params.chatId || '') : '';
    
    const streamKey = `${KEY_PREFIX}stream:instance:${targetInstanceId}`;
    const deliveryParams = {
      routingId,
      message: params.message,
      channel: params.channel || 'wegirl',
      accountId: params.accountId || 'default',
      chatId: effectiveChatIdRemote,  // 群聊保留，私聊清空触发广播
      chatType: params.chatType || 'direct',
      from: envelope.from.agentId,
      targetType: 'agent',
      targetId: agentId
    };

    // XADD 自动创建 stream，消息持久化，保留最近 5000 条
    const messageId = await this.redis.xadd(
      streamKey, 
      'MAXLEN', '~', 5000,
      '*', 
      'data', JSON.stringify(deliveryParams)
    );

    await this.publishRoutingEvent(routingId, 'stream_added', {
      streamKey,
      messageId,
      targetInstanceId
    });

    return {
      success: true,
      target: `agent:${agentId}`,
      targetInstanceId,
      local: false,
      messageLength: params.message.length,
      routingId,
      messageId
    };
  }

  private async deliverToHuman(userId: string, envelope: MessageEnvelope, params: WeGirlSendParams, routingId: string): Promise<any> {
    await this.publishRoutingEvent(routingId, 'human_delivery', { userId });
    
    const taskId = `task_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const now = Date.now();
    
    const pipeline = this.redis.pipeline();
    
    pipeline.hset(`${KEY_PREFIX}task:${taskId}`, {
      taskId, userId, status: 'pending', type: 'notification',
      title: params.message.substring(0, 50),
      description: params.message,
      metadata: JSON.stringify({ from: envelope.from.agentId, routingId }),
      priority: '2', retryCount: '0',
      createdAt: now.toString(), updatedAt: now.toString()
    });
    
    pipeline.zadd(`${KEY_PREFIX}tasks:${userId}:by_status`, now, `pending:${taskId}`);
    
    await pipeline.exec();
    
    await this.publishRoutingEvent(routingId, 'task_created', { taskId, userId });
    
    return { success: true, target: `human:${userId}`, taskId, messageLength: params.message.length, routingId };
  }

  private async deliverToCapability(capability: string, strategy: string, envelope: MessageEnvelope, params: WeGirlSendParams, routingId: string): Promise<any> {
    await this.publishRoutingEvent(routingId, 'capability_lookup', { capability, strategy });
    
    const agentIds = await this.redis.smembers(`${KEY_PREFIX}capability:${capability}`);
    
    if (agentIds.length === 0) {
      await this.publishRoutingEvent(routingId, 'capability_empty', { capability });
      throw new Error(`No agents found with capability: ${capability}`);
    }

    await this.publishRoutingEvent(routingId, 'capability_agents_found', { capability, agentCount: agentIds.length, agents: agentIds });

    // 简单策略：随机选择一个
    const selectedAgentId = agentIds[Math.floor(Math.random() * agentIds.length)];
    
    await this.publishRoutingEvent(routingId, 'agent_selected', { capability, selectedAgentId, strategy });

    return this.deliverToAgent(selectedAgentId, envelope, params, routingId);
  }

  private async broadcast(envelope: MessageEnvelope, params: WeGirlSendParams, routingId: string): Promise<any> {
    await this.publishRoutingEvent(routingId, 'broadcast_started', {});
    
    const keys = await this.redis.keys(`${KEY_PREFIX}agents:*`);
    const results = [];
    
    await this.publishRoutingEvent(routingId, 'broadcast_agents_found', { agentCount: keys.length });

    for (const key of keys) {
      const agentId = key.split(':').pop();
      if (agentId) {
        try {
          await this.deliverToAgent(agentId, envelope, params, `${routingId}:${agentId}`);
          results.push({ agentId, success: true });
        } catch (err: any) {
          results.push({ agentId, success: false, error: err.message });
        }
      }
    }
    
    await this.publishRoutingEvent(routingId, 'broadcast_completed', { targetCount: keys.length, successCount: results.filter(r => r.success).length });
    
    return { success: true, broadcast: true, targets: results.length, results, routingId };
  }
}
