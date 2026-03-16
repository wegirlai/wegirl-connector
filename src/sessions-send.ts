// src/sessions-send.ts - 发送消息到 Agent

import Redis from 'ioredis';
import { getWeGirlRuntime } from "./runtime.js";

type ReplyPayload = {
  text?: string;
  mediaUrl?: string;
  mediaUrls?: string[];
  replyToId?: string;
  replyToTag?: boolean;
  replyToCurrent?: boolean;
  audioAsVoice?: boolean;
  isError?: boolean;
  channelData?: Record<string, unknown>;
};

type ReplyDispatchKind = "tool" | "block" | "final";

interface SessionsSendOptions {
  message: string;
  cfg: any;
  channel: string;
  accountId: string;
  from: string;
  chatId: string;
  chatType: string;
  log?: any;
  // 群聊多 agent 任务参数
  taskId?: string;        // 多 agent 任务标识
  agentCount?: number;    // 总 agent 数
  currentAgentId?: string; // 当前 agent 标识（用于结果区分）
}

// Redis 连接缓存
let redisClient: Redis | null = null;
let redisConnectPromise: Promise<Redis> | null = null;

async function getRedisPublisher(cfg: any): Promise<Redis> {
  if (redisClient && redisClient.status === 'ready') {
    return redisClient;
  }
  if (redisConnectPromise) {
    return redisConnectPromise;
  }
  redisConnectPromise = (async () => {
    const channelCfg = cfg?.channels?.['wegirl'] || {};
    const redisUrl = channelCfg?.redisUrl || process.env.REDIS_URL || `redis://${process.env.REDIS_HOST || 'localhost'}:${process.env.REDIS_PORT || '6379'}`;
    const password = channelCfg?.redisPassword || process.env.REDIS_PASSWORD;
    const db = channelCfg?.redisDb || 1;

    const client = new Redis(redisUrl, {
      password: password,
      db: db,
    });

    await new Promise<void>((resolve, reject) => {
      client.once('ready', resolve);
      client.once('error', reject);
      setTimeout(() => reject(new Error('Redis connect timeout')), 5000);
    });

    redisClient = client;
    return client;
  })();
  return redisConnectPromise;
}

/**
 * 发送消息到 Agent
 *
 * 流程:
 * 1. 获取 PluginRuntime
 * 2. 使用 resolveAgentRoute 查找 agent
 * 3. 构建 inbound context（设置 OriginatingChannel 用于回复路由）
 * 4. 调用 dispatchReplyFromConfig 发送消息给 Agent
 * 5. Gateway 自动处理 Agent 回复的路由
 */
export async function wegirlSessionsSend(options: SessionsSendOptions): Promise<void> {
  const { message, cfg, channel, accountId, from, chatId, chatType, log, taskId, agentCount, currentAgentId } = options;

  log?.info?.(`[WeGirl SessionsSend] Called: channel=${channel}, accountId=${accountId}, chatId=${chatId}, chatType=${chatType}${taskId ? `, taskId=${taskId}` : ''}`);

  // 获取 PluginRuntime
  const runtime = getWeGirlRuntime();
  if (!runtime) {
    log?.error?.('[WeGirl SessionsSend] No runtime available');
    return;
  }

  // 检查 runtime 结构完整性
  if (!runtime.channel) {
    log?.error?.('[WeGirl SessionsSend] Runtime has no channel');
    return;
  }
  if (!runtime.channel.routing) {
    log?.error?.('[WeGirl SessionsSend] Runtime has no channel.routing');
    return;
  }
  if (!runtime.channel.reply) {
    log?.error?.('[WeGirl SessionsSend] Runtime has no channel.reply');
    return;
  }
  if (typeof runtime.channel.reply.dispatchReplyFromConfig !== 'function') {
    log?.error?.('[WeGirl SessionsSend] Runtime has no dispatchReplyFromConfig method');
    return;
  }

  log?.debug?.('[WeGirl SessionsSend] Runtime check passed');

  try {
    // 1. 使用 resolveAgentRoute 查找 agent
    const route = runtime.channel.routing.resolveAgentRoute({
      cfg,
      channel,
      accountId,
      peer: {
        kind: chatType as any,
        id: chatId,
      },
    });

    // 检查 route 是否为空
    if (!route || !route.agentId) {
      log?.error?.(`[WeGirl SessionsSend] Failed to resolve agent route: channel=${channel}, accountId=${accountId}, chatId=${chatId}`);
      return;
    }

    const sessionKey = route.sessionKey;
    const agentId = route.agentId;
    log?.info?.(`[WeGirl SessionsSend] Route resolved: agentId=${agentId}, sessionKey=${sessionKey}, matchedBy=${route.matchedBy}`);

    // 生成追踪ID和时间戳
    const routingId = `routing_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;
    const messageId = `wegirl-${Date.now()}`;
    const createdAt = Date.now();

    // 2. 发送 Redis 消息（包含 sessionKey 和 agentId，用于监控）
    try {
      const redis = await getRedisPublisher(cfg);
      const forwardMsg = {
        type: 'forward',
        routingId,
        messageId,
        message,
        channel,
        accountId,
        from,
        chatId,
        chatType,
        agentId,
        sessionKey,
        status: 'pending',
        source: 'wegirl-connector',
        priority: 'normal',
        createdAt,
        expiresAt: createdAt + 3600000, // 1小时后过期
        metadata: {
          matchedBy: route.matchedBy,
          originalChannel: channel,
        },
        workflowId: undefined, // 预留：用于工作流编排
        error: undefined, // 预留：处理失败时填充
        timestamp: Date.now()
      };
      await redis.publish('wegirl:forward', JSON.stringify(forwardMsg));
      log?.info?.(`[WeGirl SessionsSend] Message forwarded via Redis: agentId=${agentId}, sessionKey=${sessionKey}, routingId=${routingId}`);
    } catch (err: any) {
      log?.error?.('[WeGirl SessionsSend] Redis forward failed:', err.message);
    }

    // 3. 构建 envelope
    const body = runtime.channel.reply.formatAgentEnvelope({
      channel: '微妞AI',
      from: from,
      timestamp: new Date(),
      body: message,
    });

    // 构建 inbound context
    // Provider/Surface: wegirl（当前渠道）
    // OriginatingChannel/OriginatingTo: 目标渠道，Gateway 会自动路由回复到该渠道
    const inboundCtx = runtime.channel.reply.finalizeInboundContext({
      Body: body,
      BodyForAgent: message,
      RawBody: message,
      CommandBody: message,
      From: from,
      To: chatId,
      SessionKey: sessionKey,
      AccountId: accountId,
      Provider: 'wegirl',
      Surface: 'wegirl',
      ChatType: chatType,
      GroupSubject: chatType === 'group' ? chatId : undefined,
      SenderId: from,
      SenderName: from,
      MessageSid: messageId,
      Timestamp: Date.now(),
      WasMentioned: true,
      CommandAuthorized: true,
      OriginatingChannel: channel,
      OriginatingTo: chatId,
    });

    log?.info?.(`[WeGirl SessionsSend] dispatching to agent (session=${sessionKey}, replyTo=${channel}:${accountId})`);

    // 创建 dispatcher，处理 Agent 回复
    // 当 channel="wegirl" 时，通过 outbound 发送；其他情况交由 Gateway 自动路由
    const { dispatcher, replyOptions, markDispatchIdle } = runtime.channel.reply.createReplyDispatcherWithTyping({
      deliver: async (payload: ReplyPayload, info: { kind: ReplyDispatchKind }) => {
        const text = payload.text ?? '';
        log?.debug?.(`[WeGirl SessionsSend] agent reply: kind=${info?.kind}, channel=${channel}, text=${text.substring(0, 50)}`);

        // 只处理最终回复
        if (info?.kind !== 'final' || !text.trim()) {
          return;
        }

        // ========== 群聊多 agent 聚合处理 ==========
        if (chatType === 'group' && taskId && agentCount && agentCount > 1) {
          const effectiveAgentId = currentAgentId || agentId;
          log?.info?.(`[WeGirl SessionsSend] Group multi-agent task: taskId=${taskId}, agent=${effectiveAgentId}, progress=?/${agentCount}`);
          
          try {
            const redis = await getRedisPublisher(cfg);
            if (!redis) {
              log?.error?.(`[WeGirl SessionsSend] Redis not available for group aggregation`);
              return;
            }

            // 1. 记录此 agent 的结果
            await redis.hset(`wegirl:task:${taskId}:results`, effectiveAgentId, text);
            await redis.hset(`wegirl:task:${taskId}:status`, effectiveAgentId, 'completed');
            await redis.expire(`wegirl:task:${taskId}:results`, 3600); // 1小时过期
            await redis.expire(`wegirl:task:${taskId}:status`, 3600);

            // 2. 检查是否全部完成
            const results = await redis.hgetall(`wegirl:task:${taskId}:results`);
            const completedCount = Object.keys(results).length;
            log?.info?.(`[WeGirl SessionsSend] Task progress: ${completedCount}/${agentCount} completed`);

            if (completedCount === agentCount) {
              // 3. 全部完成，聚合并统一回复
              log?.info?.(`[WeGirl SessionsSend] All agents completed, aggregating results for task ${taskId}`);
              
              const aggregated = aggregateGroupResults(results, taskId);
              
              // 4. 发送聚合结果到群
              const replyMessage = {
                id: `wegirl-reply-${Date.now()}`,
                type: 'message',
                routingId: routingId,
                inReplyTo: messageId,
                content: aggregated,
                to: chatId,
                from: 'agent',
                agentId: 'coordinator',
                sessionId: sessionKey,
                accountId: accountId,
                status: 'completed',
                isFinal: true,
                replyType: 'text',
                processedAt: Date.now(),
                duration: Date.now() - createdAt,
                taskId: taskId,
                agentResults: results, // 包含各 agent 的原始结果
                workflowId: undefined,
                error: undefined,
                timestamp: Date.now(),
              };
              await redis.publish('wegirl:replies', JSON.stringify(replyMessage));
              log?.info?.(`[WeGirl SessionsSend] Aggregated reply published to wegirl:replies for task ${taskId}`);

              // 5. 清理任务数据
              await redis.del(`wegirl:task:${taskId}:results`, `wegirl:task:${taskId}:status`);
            }
            // 否则：等待其他 agent 完成，不回复
            return;
          } catch (err: any) {
            log?.error?.(`[WeGirl SessionsSend] Group aggregation failed:`, err.message);
          }
          return;
        }

        // ========== 单 agent 回复（原有逻辑）==========
        // 只有 channel="wegirl" 时才通过 outbound 发送
        // 其他 channel（如 feishu）由 Gateway 自动路由，不处理
        if (channel !== 'wegirl') {
          log?.debug?.(`[WeGirl SessionsSend] channel=${channel} !== 'wegirl', skip outbound delivery (Gateway will handle)`);
          return;
        }

        log?.info?.(`[WeGirl SessionsSend] channel='wegirl', sending reply via outbound: ${text.substring(0, 50)}...`);
        try {
          const pub = await getRedisPublisher(cfg);
          if (!pub) {
            log?.error?.(`[WeGirl SessionsSend] Redis publisher not connected`);
            return;
          }
          const replyId = `wegirl-reply-${Date.now()}`;
          const replyMessage = {
            id: replyId,
            type: 'message',
            routingId: routingId, // 关联请求
            inReplyTo: messageId, // 回复哪条消息
            content: text,
            to: chatId,
            from: 'agent',
            agentId: agentId,
            sessionId: sessionKey,
            accountId: accountId,
            status: 'completed',
            isFinal: true,
            replyType: 'text',
            processedAt: Date.now(),
            duration: Date.now() - createdAt,
            workflowId: undefined, // 预留：工作流编排
            error: undefined, // 预留：错误信息
            timestamp: Date.now(),
          };
          await pub.publish('wegirl:replies', JSON.stringify(replyMessage));
          log?.info?.(`[WeGirl SessionsSend] Reply published to wegirl:replies`);
        } catch (err: any) {
          // 发送失败，发布错误回复
          try {
            const pub = await getRedisPublisher(cfg);
            if (pub) {
              const errorReply = {
                id: `wegirl-reply-error-${Date.now()}`,
                type: 'message',
                routingId: routingId,
                inReplyTo: messageId,
                content: '',
                to: chatId,
                from: 'agent',
                agentId: agentId,
                sessionId: sessionKey,
                accountId: accountId,
                status: 'failed',
                isFinal: true,
                replyType: 'error',
                processedAt: Date.now(),
                duration: Date.now() - createdAt,
                workflowId: undefined,
                error: err.message,
                errorCode: 'REPLY_PUBLISH_FAILED',
                timestamp: Date.now(),
              };
              await pub.publish('wegirl:replies', JSON.stringify(errorReply));
            }
          } catch {}
          log?.error?.(`[WeGirl SessionsSend] Failed to publish reply: ${err.message}`);
        }
      },
      onError: (error: unknown, info: { kind: ReplyDispatchKind }) => {
        log?.error?.(`[WeGirl SessionsSend] deliver error: ${error}`);
      },
    });

    // 调用 dispatchReplyFromConfig 发送消息给 Agent
    const result = await runtime.channel.reply.dispatchReplyFromConfig({
      ctx: inboundCtx,
      cfg,
      dispatcher,
      replyOptions,
    });

    markDispatchIdle();
    log?.info?.(`[WeGirl SessionsSend] dispatch complete (queuedFinal=${result.queuedFinal}, replies=${result.counts?.final ?? 0})`);

  } catch (err: any) {
    log?.error?.(`[WeGirl SessionsSend] Failed: ${err.message}`);
    throw err;
  }
}

/**
 * 聚合群聊多 agent 结果
 * @param results - 各 agent 的结果 {agentId: result}
 * @param taskId - 任务标识
 * @returns 聚合后的消息
 */
function aggregateGroupResults(results: Record<string, string>, taskId: string): string {
  const agentIds = Object.keys(results);
  
  if (agentIds.length === 1) {
    return results[agentIds[0]];
  }
  
  // 多 agent 结果聚合
  const sections: string[] = [];
  sections.push(`【多 Agent 协作结果】任务: ${taskId}`);
  sections.push('');
  
  for (const [agentId, result] of Object.entries(results)) {
    sections.push(`【${agentId}】`);
    sections.push(result);
    sections.push('');
  }
  
  return sections.join('\n');
}
