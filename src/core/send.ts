// src/core/send.ts - V2 发送层：参数适配 + 跨实例路由
// 本地投递统一调用 V1 (sessions-send.ts)

import Redis from 'ioredis';
import { readFileSync } from 'fs';
import { join } from 'path';
import { wegirlSessionsSend } from './sessions-send.js';
import type { 
  WeGirlSendOptions, 
  SendResult, 
  StaffInfo,
  SessionContext 
} from './types.js';
import { 
  validateOptions, 
  createSessionContext,
  isNoReply,
  generateId
} from './utils.js';

const KEY_PREFIX = 'wegirl:';
const STREAM_PREFIX = `${KEY_PREFIX}stream:instance:`;

/**
 * StaffId 标准化规则：
 * - 普通 ID 转小写： "HR" → "hr"
 * - source: 前缀保留：未注册用户的临时标识
 */
function normalizeStaffId(id: string | undefined): string | undefined {
  if (!id) return id;
  // 如果包含 source: 或 source：前缀，保持原样（未注册用户临时标识）
  if (id.startsWith('source:') || id.startsWith('source：')) {
    return id;
  }
  // 普通 staffId 转小写
  return id.toLowerCase();
}

// 缓存 openclaw.json 配置
let openclawConfig: any = null;

/**
 * 从 openclaw.json 加载配置
 */
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

// 全局 Redis 连接缓存
let redisClient: Redis | null = null;
let redisConnectPromise: Promise<Redis> | null = null;

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
    // 统一从 openclaw.json 的 plugins.wegirl.config 读取
    const cfg = loadOpenClawConfig();
    const pluginCfg = cfg?.plugins?.entries?.wegirl?.config || {};
    const redisUrl = pluginCfg?.redisUrl || 'redis://localhost:6379';
    const password = pluginCfg?.redisPassword;
    const db = pluginCfg?.redisDb ?? 1;
    
    const client = new Redis(redisUrl, {
      password,
      db,
      retryStrategy: (times) => Math.min(times * 50, 2000),
    });
    
    await new Promise<void>((resolve, reject) => {
      client.once('connect', resolve);
      client.once('error', reject);
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
  
  let capabilities: string[] | undefined;
  if (data.capabilities) {
    try {
      capabilities = JSON.parse(data.capabilities);
    } catch {
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
 * 查找相似的 Staff
 * 简单的模糊匹配：包含查询词或查询词包含 staffId
 */
async function findSimilarStaff(redis: Redis, query: string): Promise<any[]> {
  const keys = await redis.keys(`${KEY_PREFIX}staff:*`);
  const results: any[] = [];
  const lowerQuery = query.toLowerCase();

  for (const key of keys) {
    const staffId = key.split(':').pop()!;
    const data = await redis.hgetall(key);

    // 简单匹配：staffId 包含查询词，或查询词包含 staffId，或 name 包含查询词
    if (
      staffId.includes(lowerQuery) ||
      lowerQuery.includes(staffId) ||
      data.name?.toLowerCase().includes(lowerQuery)
    ) {
      let capabilities: string[] = [];
      if (data.capabilities) {
        try {
          capabilities = JSON.parse(data.capabilities);
        } catch {
          capabilities = String(data.capabilities).split(',').map((s: string) => s.trim()).filter(Boolean);
        }
      }

      results.push({
        id: staffId,
        type: data.type,
        name: data.name,
        capabilities: capabilities,
        status: data.status,
      });
    }
  }

  return results.slice(0, 5); // 最多返回 5 个
}
function getCurrentInstanceId(): string {
  const cfg = loadOpenClawConfig();
  return cfg?.plugins?.entries?.wegirl?.config?.instanceId ||
    'instance-local';
}

/**
 * 写入 Redis Stream（跨实例投递）
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
  
  if (payload) {
    streamData.payload = JSON.stringify(payload);
  }
  
  const entries = Object.entries(streamData).flat();
  await redis.xadd(streamKey, '*', ...entries);
}

/**
 * V2 核心发送函数
 * 
 * 职责：
 * 1. 参数标准化验证
 * 2. 查询目标 Staff 信息
 * 3. A2H 直接发布到 replies
 * 4. 跨实例 → 写入 Redis Stream
 * 5. 本地 → 调用 V1 wegirlSessionsSend
 */
export async function wegirlSend(
  options: WeGirlSendOptions,
  logger?: any
): Promise<SendResult> {
  const routingId = options.routingId || generateId();
  
  // 标准化 source 和 target
  const normalizedOptions = {
    ...options,
    source: normalizeStaffId(options.source) || '',
    target: normalizeStaffId(options.target) || '',
    replyTo: typeof options.replyTo === 'string' 
      ? normalizeStaffId(options.replyTo) 
      : options.replyTo,
  };
  
  // 添加详细日志
  logger?.info?.(`=====>[WeGirlSend] Options: ${JSON.stringify(normalizedOptions)}`);
  
  try {
    // 1. 验证选项
    validateOptions(normalizedOptions);
    
    // 2. 创建 Session 上下文
    const ctx = createSessionContext(normalizedOptions, routingId);
    
    logger?.info?.(`[WeGirlSend] ${ctx.flowType}: ${ctx.source} -> ${ctx.target}`);
    
    // 3. 获取 Redis 连接
    const redis = await getRedisClient();
    
    // 4. 查询目标 Staff 信息
    const targetInfo = await getStaffInfo(redis, ctx.target);
    
    if (!targetInfo) {
      // 查询建议
      const suggestions = await findSimilarStaff(redis, ctx.target);
      throw new Error(
        `Target "${ctx.target}" 不存在！\n\n` +
        `建议操作：\n` +
        `1. 调用 wegirl_query({ by: "id", query: "${ctx.target}" }) 查询可用 Staff\n` +
        `2. 从返回结果中选择正确的 target\n\n` +
        `相似匹配：${suggestions.map((s: any) => s.id).join(', ') || '无'}\n\n` +
        `常用 Staff：hr, scout, harvester, analyst, quartermaster`
      );
    }
    
    // 5. A2H：直接发布到 replies
    if (targetInfo.type === 'human') {
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
        msgType: options.msgType || 'message',
        fromType: 'inner',  // 标记为内部工具调用
        payload: options.payload,
        taskId: ctx.taskId,
        stepId: ctx.stepId,
        replyTo: ctx.replyTo,
        routingId: ctx.routingId,
        timestamp: Date.now(),
      };
      
      await redis.publish(`${KEY_PREFIX}replies`, JSON.stringify(replyMessage));
      logger?.info?.(`[WeGirlSend] A2H published to replies`);
      
      return { success: true, routingId, local: true };
    }
    
    // 6. 判断本地/跨实例
    const currentInstanceId = getCurrentInstanceId();
    const targetInstanceId = targetInfo.instanceId || currentInstanceId;
    const isLocal = targetInstanceId === currentInstanceId;
    
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
    
    // 8. 本地：调用 V1 统一投递
    logger?.info?.(`[WeGirlSend] Local delivery to ${ctx.target} via V1`);
    
    // 加载完整配置
    const fullCfg = loadOpenClawConfig() || {};
    
    // 构建 V1 参数
    const chatId = ctx.chatType === 'group' 
      ? (ctx.groupId || ctx.source)
      : ctx.source;
    
    const metadata: any = {
      originatingChannel: 'wegirl',
      originatingTo: ctx.source,
      originatingAccountId: ctx.target,
      replyTo: ctx.replyTo,
    };
    
    if (ctx.taskId) metadata.taskId = ctx.taskId;
    if (ctx.stepId) metadata.stepId = ctx.stepId;
    
    // 调用 V1 - 使用统一参数名
    await wegirlSessionsSend({
      message: options.message,
      source: ctx.source,
      target: ctx.target,
      chatType: ctx.chatType,
      groupId: chatId,
      routingId: ctx.routingId,
      taskId: ctx.taskId,
      stepId: ctx.stepId,
      stepTotalAgents: ctx.stepTotalAgents,
      msgType: options.msgType,
      payload: options.payload,
      metadata,
      fromType: 'inner',  // wegirlSend 调用标记为 inner
      // V1 内部字段
      cfg: fullCfg,
      channel: 'wegirl',
      log: logger,
    });
    
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

// 兼容旧接口导出
export { wegirlSend as wegirlSessionsSend };
