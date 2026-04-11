// src/core/send.ts - V2 发送层：参数适配 + 跨实例路由
// 本地投递统一调用 V1 (sessions-send.ts)

import Redis from 'ioredis';
import { wegirlSessionsSend } from './sessions-send.js';
import { getGlobalConfig, getWeGirlPluginConfig, getRedisConfig } from '../config.js';
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
  generateId,
  buildMessage,
  type MessageBuilderOptions
} from './utils.js';

const KEY_PREFIX = 'wegirl:';
// 统一使用 wegirl:stream:${instanceId}:${target} 格式
const getStreamKey = (instanceId: string, target: string) => `${KEY_PREFIX}stream:${instanceId}:${target}`;

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
    // 使用全局配置
    const { url, password, db } = getRedisConfig();

    const client = new Redis(url, {
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
    feishuUserId: data.feishuUserId || data.openId,  // 添加飞书用户ID
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
  return getWeGirlPluginConfig()?.instanceId || 'instance-local';
}

/**
 * 同步等待响应
 * 使用 Redis brpop 阻塞等待，超时返回 timeout 状态
 */
async function waitForResponse(
  redis: Redis,
  routingId: string,
  timeoutMs: number,
  logger?: any
): Promise<{
  success: boolean;
  status: 'ok' | 'timeout' | 'error';
  response?: { message: string; payload?: Record<string, any> };
  duration: number;
}> {
  const startTime = Date.now();
  const responseKey = `${KEY_PREFIX}response:${routingId}`;

  logger?.info?.(`[WeGirlSend] Waiting for response: ${routingId}, timeout=${timeoutMs}ms`);

  try {
    // 使用 brpop 阻塞等待，超时时间为 timeoutMs 毫秒
    // brpop 返回 [key, value] 或 null（超时）
    const result = await redis.brpop(responseKey, timeoutMs / 1000);

    const duration = Date.now() - startTime;

    if (!result) {
      // 超时
      logger?.warn?.(`[WeGirlSend] Response timeout: ${routingId}, waited ${duration}ms`);
      // 清理等待标记
      await redis.del(`${KEY_PREFIX}await:${routingId}`);
      return {
        success: false,
        status: 'timeout',
        duration
      };
    }

    // 解析响应
    const [key, value] = result;
    const response = JSON.parse(value);

    logger?.info?.(`[WeGirlSend] Response received: ${routingId}, duration=${duration}ms`);

    // 清理等待标记
    await redis.del(`${KEY_PREFIX}await:${routingId}`);

    return {
      success: true,
      status: 'ok',
      response: {
        message: response.message || '',
        payload: response.payload
      },
      duration
    };

  } catch (err: any) {
    const duration = Date.now() - startTime;
    logger?.error?.(`[WeGirlSend] Wait failed: ${err.message}`);

    // 清理等待标记
    await redis.del(`${KEY_PREFIX}await:${routingId}`);

    return {
      success: false,
      status: 'error',
      duration
    };
  }
}

/**
 * 写入响应（由接收方 Agent 调用）
 */
export async function writeResponse(
  redis: Redis,
  routingId: string,
  message: string,
  payload?: Record<string, any>,
  logger?: any
): Promise<void> {
  const responseKey = `${KEY_PREFIX}response:${routingId}`;

  const response = {
    message,
    payload,
    timestamp: Date.now()
  };

  await redis.lpush(responseKey, JSON.stringify(response));
  await redis.expire(responseKey, 60); // 60秒后自动清理

  logger?.debug?.(`[WeGirlSend] Response written: ${routingId}`);
}

/**
 * 获取当前 session 的 routingId
 * 方案 B：routingId 必须显式传入，不再自动生成
 */
async function getRoutingId(
  options: WeGirlSendOptions,
  redis: Redis,
  logger?: any
): Promise<string> {
  // routingId 必须显式提供
  if (!options.routingId) {
    throw new Error(
      `Missing required parameter: routingId\n\n` +
      `Usage: await wegirl_send({\n` +
      `  flowType: 'A2A',\n` +
      `  source: 'scout',\n` +
      `  target: 'hr',\n` +
      `  message: '...',\n` +
      `  replyTo: 'tiger',\n` +
      `  routingId: message.routingId  // 从当前消息中提取\n` +
      `});\n\n` +
      `Note: routingId must be extracted from the current message context to maintain trace consistency.`
    );
  }

  return options.routingId;
}

/**
 * 保存 routingId 到 session，供后续调用使用
 */
async function saveSessionRoutingId(
  source: string,
  routingId: string,
  redis: Redis,
  ttl: number = 3600
): Promise<void> {
  const sessionRoutingKey = `${KEY_PREFIX}session:${source}:routingId`;
  await redis.setex(sessionRoutingKey, ttl, routingId);
}

/**
 * V2 核心发送函数
 * 
 * 职责：
 * 1. 参数标准化验证
 * 2. 查询目标 Staff 信息
 * 3. A2H 直接发布到 replies
 * 4. 统一写入 Redis Stream（不分本地/远程）
 * 5. 同步模式 → 阻塞等待响应（timeoutSeconds > 0）
 */
export async function wegirlSend(
  options: WeGirlSendOptions,
  logger?: any
): Promise<SendResult> {
  // 先获取 Redis 连接以查询/保存 routingId
  const redis = await getRedisClient();

  // 获取 routingId（保持调用链一致）
  const routingId = await getRoutingId(options, redis, logger);

  // 标准化 source 和 target
  const normalizedOptions = {
    ...options,
    source: normalizeStaffId(options.source) || '',
    target: normalizeStaffId(options.target) || '',
    replyTo: typeof options.replyTo === 'string'
      ? normalizeStaffId(options.replyTo)
      : options.replyTo,
  };

  // 处理 timeoutSeconds
  const timeoutSeconds = Math.min(Math.max(0, options.timeoutSeconds || 0), 300);
  const isSyncMode = timeoutSeconds > 0;

  // 添加详细日志
  logger?.info?.(`=====>[WeGirlSend] Options: ${JSON.stringify(normalizedOptions)}, sync=${isSyncMode}, timeout=${timeoutSeconds}s`);

  // 同步模式：创建响应队列
  if (isSyncMode) {
    await redis.setex(`${KEY_PREFIX}await:${routingId}`, timeoutSeconds + 30, JSON.stringify({
      source: normalizedOptions.source,
      target: normalizedOptions.target,
      timeout: timeoutSeconds,
      createdAt: Date.now()
    }));
    logger?.debug?.(`[WeGirlSend] Created await key for sync mode: ${routingId}`);
  }

  try {
    // 1. 验证选项
    validateOptions(normalizedOptions);

    // 2. 创建 Session 上下文
    const ctx = createSessionContext(normalizedOptions, routingId);

    logger?.info?.(`[WeGirlSend] ${ctx.flowType}: ${ctx.source} -> ${ctx.target}`);

    // 4. 查询目标 Staff 信息
    const targetInfo = await getStaffInfo(redis, ctx.target);
    if (!targetInfo) return {
      routingId,
      success: false,
      error: `${ctx.target} 不存在`
    }
    // 保存 routingId 到当前 session（供后续调用保持一致）
    await saveSessionRoutingId(ctx.source, routingId, redis);
    logger?.debug?.(`[WeGirlSend] Saved routingId ${routingId} for session ${ctx.source}`);

    // 同步模式：清理等待标记
    if (isSyncMode) {
      await redis.del(`${KEY_PREFIX}await:${routingId}`);
    }

    /* // 查询建议
    const suggestions = await findSimilarStaff(redis, ctx.target);
    throw new Error(
      `Target "${ctx.target}" 不存在！\n\n` +
      `建议操作：\n` +
      `1. 调用 wegirl_query({ by: "id", query: "${ctx.target}" }) 查询可用 Staff\n` +
      `2. 从返回结果中选择正确的 target\n\n` +
      `相似匹配：${suggestions.map((s: any) => s.id).join(', ') || '无'}\n\n` +
      `常用 Staff：hr, scout, harvester, analyst, quartermaster`
    ); */

    // 5. A2H：直接发布到 replies
    if (targetInfo.type === 'human') {
      if (isNoReply(ctx.replyTo)) {
        logger?.debug?.(`[WeGirlSend] A2H with NO_REPLY, skipping`);
        return { success: true, routingId, local: true };
      }

      // A2H 消息保持原始 target（如 "tiger"）
      // wegirl-service 会通过 target 查找 feishu_userid 并发送消息
      const replyMessage = buildMessage({
        flowType: 'A2H',
        source: ctx.source,
        target: ctx.target,  // 保持原始 target（如 "tiger"）
        message: options.message,
        chatType: ctx.chatType,
        groupId: ctx.groupId,
        routingId: ctx.routingId,
        msgType: options.msgType || 'message',
        fromType: 'inner',
        timeoutSeconds,
        metadata: {
          payload: options.payload,
          taskId: ctx.taskId,
          stepId: ctx.stepId,
          replyTo: ctx.replyTo,
        }
      });

      await redis.publish(`${KEY_PREFIX}replies`, JSON.stringify(replyMessage));
      logger?.info?.(`[WeGirlSend] A2H published to replies: target=${ctx.target}`);

      return { success: true, routingId, local: true };
    }

    // 6. 统一写入 Redis Stream（不分本地/远程）
    const targetInstanceId = targetInfo.instanceId || getCurrentInstanceId();

    // 构建完整的消息数据对象
    const messageData: any = {
      flowType: ctx.flowType,
      source: ctx.source,
      target: ctx.target,
      message: options.message,
      chatType: ctx.chatType,
      groupId: ctx.groupId,
      routingId: ctx.routingId,
      msgType: options.msgType || 'message',
      replyTo: ctx.replyTo,
      taskId: ctx.taskId,
      stepId: ctx.stepId,
      stepTotalAgents: ctx.stepTotalAgents,
      timestamp: Date.now(),
    };

    // 同步模式：传递 timeout 信息
    if (isSyncMode) {
      messageData.timeoutSeconds = timeoutSeconds;
      messageData.awaitResponse = true;
    }

    if (options.payload) {
      messageData.payload = options.payload;
    }

    // 把整个消息作为 JSON 字符串放入 data 字段
    const streamEntries = ['data', JSON.stringify(messageData)];
    await redis.xadd(
      getStreamKey(targetInstanceId, ctx.target),
      'MAXLEN', '~', 5000,
      '*',
      ...streamEntries
    );

    logger?.info?.(`[WeGirlSend] Message written to stream: ${getStreamKey(targetInstanceId, ctx.target)}`);

    // 同步模式：阻塞等待响应
    if (isSyncMode) {
      const response = await waitForResponse(redis, routingId, timeoutSeconds * 1000, logger);
      return {
        ...response,
        routingId,
        local: true,
        targetInstanceId
      };
    }

    return {
      success: true,
      routingId,
      local: true,
      targetInstanceId
    };

  } catch (err: any) {
    // 同步模式：清理等待标记
    if (isSyncMode) {
      await redis.del(`${KEY_PREFIX}await:${routingId}`);
    }

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
