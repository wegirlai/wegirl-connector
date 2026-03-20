// src/core/send.ts - 核心发送实现

import Redis from 'ioredis';
import { getWeGirlConfig, getWeGirlRuntime } from '../runtime.js';
import type { 
  WeGirlSendOptions, 
  SendResult, 
  StaffInfo,
  SessionContext 
} from './types.js';
import { 
  validateOptions, 
  createSessionContext,
  createSessionKey,
  inferEntityType,
  isNoReply,
  generateId
} from './utils.js';

const KEY_PREFIX = 'wegirl:';
const STREAM_PREFIX = `${KEY_PREFIX}stream:instance:`;

// 全局 Redis 连接缓存
let redisClient: Redis | null = null;
let redisConnectPromise: Promise<Redis> | null = null;

/**
 * 从 openclaw.json 配置获取 Redis URL
 */
function getRedisUrlFromConfig(): string {
  const cfg = getWeGirlConfig();
  if (cfg?.redisUrl) {
    console.log(`[WeGirlSend] Using Redis URL from openclaw.json: ${cfg.redisUrl}`);
    return cfg.redisUrl;
  }
  
  // 降级到环境变量
  const envUrl = process.env.REDIS_URL || 
    `redis://${process.env.REDIS_HOST || 'localhost'}:${process.env.REDIS_PORT || '6379'}`;
  console.log(`[WeGirlSend] Using Redis URL from env: ${envUrl}`);
  return envUrl;
}

/**
 * 从 openclaw.json 配置获取 Redis 密码
 */
function getRedisPasswordFromConfig(): string | undefined {
  const cfg = getWeGirlConfig();
  if (cfg?.redisPassword) {
    return cfg.redisPassword;
  }
  return process.env.REDIS_PASSWORD;
}

/**
 * 从 openclaw.json 配置获取 Redis DB
 */
function getRedisDbFromConfig(): number {
  const cfg = getWeGirlConfig();
  if (cfg?.redisDb !== undefined) {
    return cfg.redisDb;
  }
  return parseInt(process.env.REDIS_DB || '1');
}

/**
 * 获取 Redis 连接
 */
async function getRedisClient(): Promise<Redis> {
  if (redisClient && redisClient.status === 'ready') {
    return redisClient;
  }
  if (redisConnectPromise) {
    return redisConnectPromise;
  }
  
  redisConnectPromise = (async () => {
    const redisUrl = getRedisUrlFromConfig();
    const password = getRedisPasswordFromConfig();
    const db = getRedisDbFromConfig();
    
    const client = new Redis(redisUrl, {
      password,
      db,
      retryStrategy: (times) => Math.min(times * 50, 2000),
    });
    
    await new Promise<void>((resolve, reject) => {
      client.once('connect', () => {
        console.log('[WeGirlSend] Redis connected');
        resolve();
      });
      client.once('error', (err) => {
        console.error('[WeGirlSend] Redis connection error:', err.message);
        reject(err);
      });
    });
    
    redisClient = client;
    return client;
  })();
  
  return redisConnectPromise;
}

/**
 * 查询 Staff 信息
 */
async function getStaffInfo(
  redis: Redis, 
  staffId: string
): Promise<StaffInfo | null> {
  const data = await redis.hgetall(`${KEY_PREFIX}staff:${staffId}`);
  
  if (!data || Object.keys(data).length === 0) {
    return null;
  }
  
  // 解析 capabilities - 支持 JSON 数组或逗号分隔字符串
  let capabilities: string[] | undefined;
  if (data.capabilities) {
    try {
      capabilities = JSON.parse(data.capabilities);
    } catch {
      // 如果不是 JSON，尝试按逗号分隔解析
      capabilities = String(data.capabilities).split(',').map(s => s.trim()).filter(Boolean);
    }
  }
  
  return {
    staffId,
    type: data.type as 'agent' | 'human',
    name: data.name,
    instanceId: data.instanceId,
    capabilities,
    status: data.status,
  };
}

/**
 * 获取当前实例 ID
 */
function getCurrentInstanceId(): string {
  // 优先从 openclaw.json 配置读取
  const cfg = getWeGirlConfig();
  if (cfg?.instanceId) {
    return cfg.instanceId;
  }
  // 降级到环境变量
  return process.env.WEGIRL_INSTANCE_ID || 
    process.env.OPENCLAW_INSTANCE_ID || 
    'instance-local';
}

/**
 * 写入 Redis Stream（跨实例）
 */
async function writeToStream(
  redis: Redis,
  targetInstanceId: string,
  ctx: SessionContext,
  message: string,
  msgType?: string,
  payload?: Record<string, any>
): Promise<void> {
  const streamKey = `${STREAM_PREFIX}${targetInstanceId}`;
  
  const streamData: Record<string, string> = {
    routingId: ctx.routingId,
    flowType: ctx.flowType,
    source: ctx.source,
    target: ctx.target,
    message,
    chatType: ctx.chatType,
    groupId: ctx.groupId || '',
    msgType: msgType || 'message',
    replyTo: JSON.stringify(ctx.replyTo),
    taskId: ctx.taskId || '',
    stepId: ctx.stepId || '',
    stepTotalAgents: ctx.stepTotalAgents?.toString() || '0',
    timestamp: Date.now().toString(),
  };
  
  // 如果存在 payload，序列化为 JSON
  if (payload) {
    streamData.payload = JSON.stringify(payload);
  }
  
  const entries = Object.entries(streamData).flat();
  await redis.xadd(streamKey, '*', ...entries);
}

/**
 * 更新步骤进度
 */
async function updateStepProgress(
  redis: Redis,
  ctx: SessionContext,
  agentId: string,
  status: 'completed' | 'processing'
): Promise<void> {
  if (!ctx.taskId || !ctx.stepId) return;
  
  const key = `${KEY_PREFIX}task:${ctx.taskId}:step:${ctx.stepId}:progress`;
  
  // 更新 agent 状态
  await redis.hset(key, `agent:${agentId}`, status);
  
  // 获取所有状态
  const allStatus = await redis.hgetall(key);
  
  // 统计已完成数
  const completedCount = Object.entries(allStatus).filter(
    ([k, v]) => k.startsWith('agent:') && v === 'completed'
  ).length;
  
  const totalAgents = ctx.stepTotalAgents || Object.keys(allStatus).filter(k => k.startsWith('agent:')).length || 1;
  
  // 更新进度
  await redis.hmset(key, {
    totalAgents: totalAgents.toString(),
    completedAgents: completedCount.toString(),
    status: completedCount >= totalAgents ? 'completed' : 'processing',
    updatedAt: Date.now().toString(),
  });
  
  // 如果步骤完成，触发通知
  if (completedCount >= totalAgents) {
    console.log(`[WeGirl] Step ${ctx.stepId} completed (${completedCount}/${totalAgents})`);
  }
}

/**
 * 投递消息给本地 Agent
 */
async function deliverToLocalAgent(
  sessionKey: string,
  ctx: SessionContext,
  message: string,
  logger?: any
): Promise<void> {
  const runtime = getWeGirlRuntime();
  
  if (!runtime) {
    throw new Error('WeGirl runtime not initialized');
  }
  
  // 创建 messageId
  const messageId = `wegirl-${Date.now()}-${Math.random().toString(36).substring(2, 10)}`;
  const createdAt = Date.now();
  
  // 根据 chatType 确定 chatId
  const chatId = ctx.chatType === 'group' 
    ? (ctx.groupId || ctx.source)
    : ctx.source;
  
  // 构建 envelope
  const body = runtime.channel.reply.formatAgentEnvelope({
    channel: '微妞AI',
    from: ctx.source,
    timestamp: new Date(),
    body: message,
  });

  // 构建 inbound context
  const inboundCtx = runtime.channel.reply.finalizeInboundContext({
    Body: body,
    BodyForAgent: message,
    RawBody: message,
    CommandBody: message,
    From: ctx.source,
    To: chatId,
    SessionKey: sessionKey,
    AccountId: ctx.target,
    Provider: 'wegirl',
    Surface: 'wegirl',
    ChatType: ctx.chatType,
    GroupSubject: ctx.chatType === 'group' ? ctx.groupId : undefined,
    SenderId: ctx.source,
    SenderName: ctx.source,
    MessageSid: messageId,
    Timestamp: Date.now(),
    WasMentioned: true,
    CommandAuthorized: true,
    OriginatingChannel: 'wegirl',
    OriginatingTo: ctx.source,
    Model: 'kimi-coding/k2p5',
  });
  
  // 构建 cfg
  const cfg = {
    channels: {
      wegirl: {
        accountId: ctx.target,
      }
    }
  };
  
  // 创建 dispatcher
  const { dispatcher, replyOptions: baseReplyOptions, markDispatchIdle } = 
    runtime.channel.reply.createReplyDispatcherWithTyping({
      deliver: async (payload: any, info: { kind: string }) => {
        const text = payload.text ?? '';
        
        if (info?.kind !== 'final' || !text.trim()) {
          return;
        }
        
        // 检查是否 NO_REPLY
        if (isNoReply(ctx.replyTo)) {
          logger?.debug?.(`[WeGirlSend] NO_REPLY set, skipping reply`);
          return;
        }
        
        // 发布回复到 wegirl:replies
        try {
          const redis = await getRedisClient();
          
          const replyMessage: any = {
            id: `wegirl-reply-${Date.now()}`,
            type: 'message',
            routingId: ctx.routingId,
            inReplyTo: messageId,
            content: text,
            source: ctx.target,      // agent 回复
            target: ctx.replyTo[0],  // 第一个回复目标
            replyTo: ctx.replyTo,    // 所有回复目标
            from: 'agent',
            agentId: ctx.target,
            sessionId: sessionKey,
            status: 'completed',
            isFinal: true,
            replyType: 'text',
            processedAt: Date.now(),
            duration: Date.now() - createdAt,
            timestamp: Date.now(),
          };
          
          // 添加 taskId/stepId 如果有
          if (ctx.taskId) replyMessage.taskId = ctx.taskId;
          if (ctx.stepId) replyMessage.stepId = ctx.stepId;
          
          await redis.publish(`${KEY_PREFIX}replies`, JSON.stringify(replyMessage));
          logger?.info?.(`[WeGirlSend] Reply published to wegirl:replies`);
          
          // 更新步骤进度
          if (ctx.taskId && ctx.stepId) {
            await updateStepProgress(redis, ctx, ctx.target, 'completed');
          }
        } catch (err: any) {
          logger?.error?.(`[WeGirlSend] Failed to publish reply:`, err.message);
        }
      },
      onError: (error: any) => {
        logger?.error?.(`[WeGirlSend] deliver error:`, error);
      },
    });
  
  // 调用 dispatchReplyFromConfig
  const replyOptions = {
    ...baseReplyOptions,
    model: 'kimi-coding/k2p5',
  };
  
  const result = await runtime.channel.reply.dispatchReplyFromConfig({
    ctx: inboundCtx,
    cfg,
    dispatcher,
    replyOptions,
  });
  
  markDispatchIdle();
  logger?.info?.(`[WeGirlSend] dispatch complete (queuedFinal=${result.queuedFinal})`);
}

/**
 * 核心发送函数
 */
export async function wegirlSend(
  options: WeGirlSendOptions,
  logger?: any
): Promise<SendResult> {
  const routingId = options.routingId || generateId();
  
  try {
    // 1. 验证选项
    validateOptions(options);
    
    // 2. 创建 Session 上下文
    const ctx = createSessionContext(options, routingId);
    
    logger?.info?.(`[WeGirlSend] ${ctx.flowType}: ${ctx.source} -> ${ctx.target}`);
    
    // 3. 获取 Redis 连接
    const redis = await getRedisClient();
    
    // 4. 查询目标 Staff 信息
    const targetInfo = await getStaffInfo(redis, ctx.target);
    
    if (!targetInfo) {
      throw new Error(`Target not found: ${ctx.target}`);
    }
    
    // 5. 根据目标类型处理
    if (targetInfo.type === 'human') {
      // A2H: 直接发布到 replies
      if (isNoReply(ctx.replyTo)) {
        logger?.debug?.(`[WeGirlSend] A2H with NO_REPLY, skipping`);
        return { success: true, routingId, local: true };
      }
      
      const replyMessage = {
        flowType: 'A2H',
        source: ctx.source,
        target: ctx.target,
        message: options.message,
        chatType: ctx.chatType,
        groupId: ctx.groupId,
        msgType: options.msgType || 'message',  // 默认普通消息
        payload: options.payload,  // 可选 payload
        taskId: ctx.taskId,
        stepId: ctx.stepId,
        replyTo: ctx.replyTo,
        routingId: ctx.routingId,
        timestamp: Date.now(),
      };
      
      await redis.publish(`${KEY_PREFIX}replies`, JSON.stringify(replyMessage));
      logger?.info?.(`[WeGirlSend] A2H published to replies (msgType=${options.msgType || 'message'})`);
      
      return { success: true, routingId, local: true };
    }
    
    // 6. 目标是 agent，判断本地/跨实例
    const currentInstanceId = getCurrentInstanceId();
    const targetInstanceId = targetInfo.instanceId || currentInstanceId;
    const isLocal = targetInstanceId === currentInstanceId;
    
    logger?.debug?.(`[WeGirlSend] Target instance: ${targetInstanceId}, local: ${isLocal}`);
    
    // 7. 跨实例：写入 Stream
    if (!isLocal) {
      await writeToStream(redis, targetInstanceId, ctx, options.message, options.msgType, options.payload);
      logger?.info?.(`[WeGirlSend] Cross-instance delivery to ${targetInstanceId}`);
      
      return { 
        success: true, 
        routingId, 
        local: false, 
        targetInstanceId 
      };
    }
    
    // 8. 本地处理
    logger?.info?.(`[WeGirlSend] Local delivery to ${ctx.target}`);
    
    const sessionKey = createSessionKey(ctx.target, ctx.chatType, ctx.groupId);
    
    // 初始化步骤进度
    if (ctx.taskId && ctx.stepId) {
      await updateStepProgress(redis, ctx, ctx.target, 'processing');
    }
    
    // 投递给 agent
    await deliverToLocalAgent(sessionKey, ctx, options.message, logger);
    
    return { success: true, routingId, local: true };
    
  } catch (err: any) {
    logger?.error?.(`[WeGirlSend] Failed: ${err.message}`);
    return { 
      success: false, 
      routingId, 
      local: false, 
      error: err.message 
    };
  }
}

// 导出兼容旧接口
export { wegirlSend as wegirlSessionsSend };
