// src/core/sessions-send.ts - 发送消息到 Agent (V1 核心层)

import Redis from 'ioredis';
import { getWeGirlRuntime } from "../runtime.js";

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
  // 核心消息字段（与 wegirl_send 标准一致）
  /** 消息内容 */
  message: string;
  /** 来源 StaffId */
  source: string;
  /** 目标 StaffId（agent accountId） */
  target: string;
  /** 聊天类型 */
  chatType: string;
  /** 群聊ID（chatType='group' 时必填） */
  groupId?: string;
  /** 路由追踪ID */
  routingId?: string;
  /** 任务ID */
  taskId?: string;
  /** 步骤ID */
  stepId?: string;
  /** 步骤总 Agent 数 */
  stepTotalAgents?: number;
  /** 消息类型 */
  msgType?: string;
  /** 额外载荷 */
  payload?: Record<string, any>;
  /** 元数据 */
  metadata?: any;
  /** 回复目标 */
  replyTo?: string;
  /** 来源类型: inner (wegirlSend调用) / outer (startAccount调用) */
  fromType?: 'inner' | 'outer';

  // V1 内部字段
  cfg: any;
  channel: string;
  log?: any;
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
    // 统一从 openclaw.json 的 plugins.wegirl.config 读取
    const pluginCfg = cfg?.plugins?.entries?.wegirl?.config || {};
    const redisUrl = pluginCfg?.redisUrl || 'redis://localhost:6379';
    const password = pluginCfg?.redisPassword;
    const db = pluginCfg?.redisDb ?? 1;

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
  const { message, cfg, channel, target, source, groupId, chatType, log, taskId, stepTotalAgents, stepId, routingId: originalRoutingId, msgType, payload, metadata: originalMetadata, replyTo } = options;

  const chatId = groupId || target;
  const agentCount = stepTotalAgents;
  const currentAgentId = stepId;
  const routingId = originalRoutingId;
  const messageId = originalMetadata?.messageId;
  const originalMessageId = messageId;

  // 直接使用传入的 cfg，不重新构建
  log?.info?.(`[WeGirl SessionsSend] Called: channel=${channel}, source=${source}, target=${target}, chatId=${chatId}, chatType=${chatType}${taskId ? `, taskId=${taskId}` : ''}${originalRoutingId ? `, originalRoutingId=${originalRoutingId}` : ''}`);

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

  // 声明 logPrefix，在获取 sessionKey 后更新
  let logPrefix = '[WeGirl SessionsSend]';

  try {
    // 1. 使用 resolveAgentRoute 查找 agent
    const resolveParams: any = {
      cfg,
      channel,
      accountId: target,
    };
    const route = runtime.channel.routing.resolveAgentRoute(resolveParams);

    // 检查 route 是否为空
    if (!route || !route.agentId) {
      log?.error?.(`[WeGirl SessionsSend] Failed to resolve agent route: channel=${channel}, target=${target}, chatId=${chatId}`);
      return;
    }

    const sessionKey = route.sessionKey;
    const agentId = route.agentId;
    
    // 更新 logPrefix 包含 sessionKey
    logPrefix = `[WeGirl SessionsSend ${sessionKey}]`;
    
    log?.info?.(`${logPrefix} Route resolved: agentId=${agentId}, sessionKey=${sessionKey}, matchedBy=${route.matchedBy}`);

    // 使用原始消息的 routingId 和 messageId（如果提供），否则生成新的
    const routingId = originalRoutingId || `routing_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;
    const messageId = originalMessageId || `wegirl-${Date.now()}`;
    const createdAt = Date.now();

    // 辅助函数：从 Redis 查询 staff 类型
    async function getStaffType(redis: Redis, staffId: string): Promise<'human' | 'agent' | 'unknown'> {
      try {
        // 去掉 source: 前缀
        const cleanId = staffId.startsWith('source:') ? staffId.slice(7) : staffId;
        const data = await redis.hgetall(`wegirl:staff:${cleanId}`);
        return data.type as 'human' | 'agent' || 'unknown';
      } catch (err) {
        log?.warn?.(`${logPrefix} Failed to get staff type for ${staffId}:`, err);
        return 'unknown';
      }
    }

    // 辅助函数：根据 source 和 target 判断 flowType（从 Redis 查询）
    async function determineFlowType(redis: Redis, src: string, tgt: string): Promise<string> {
      const [sourceType, targetType] = await Promise.all([
        getStaffType(redis, src),
        getStaffType(redis, tgt)
      ]);
      
      log?.info?.(`${logPrefix} Staff types: source=${src}(${sourceType}), target=${tgt}(${targetType})`);
      
      if (sourceType === 'human' && targetType === 'agent') return 'H2A';
      if (sourceType === 'agent' && targetType === 'human') return 'A2H';
      if (sourceType === 'agent' && targetType === 'agent') return 'A2A';
      if (sourceType === 'human' && targetType === 'human') return 'H2H';
      
      // 如果查询失败，使用启发式规则
      const isHumanSource = src.startsWith('source:') || src.startsWith('ou_');
      const isHumanTarget = tgt.startsWith('source:') || tgt.startsWith('ou_') || !tgt.includes(':');
      
      if (isHumanSource && !isHumanTarget) return 'H2A';
      if (!isHumanSource && isHumanTarget) return 'A2H';
      if (!isHumanSource && !isHumanTarget) return 'A2A';
      return 'H2A';
    }

    // 辅助函数：对调 flowType（H2A <-> A2H，A2A 保持）
    function reverseFlowType(flowType: string): string {
      const map: Record<string, string> = {
        'H2A': 'A2H',
        'A2H': 'H2A',
        'A2A': 'A2A',
        'H2H': 'H2H'
      };
      return map[flowType] || flowType;
    }

    // 定义 forwardMsg 和 flowType 在更高作用域，以便后续回调函数访问
    let forwardMsg: any;
    let flowType: string = 'H2A'; // 默认值，后续会被覆盖

    // 2. 发送 Redis 消息（使用标准 V2 格式）
    try {
      const redis = await getRedisPublisher(cfg);
      flowType = await determineFlowType(redis, source, target);
      log?.info?.(`${logPrefix} Flow type determined: ${flowType} (source=${source}, target=${target})`);
      
      forwardMsg = {
        // 标准 V2 字段
        flowType: flowType,
        source: source,
        target: target,
        message,
        chatType,
        groupId: chatType === 'group' ? chatId : undefined,
        routingId,
        msgType: 'message',
        fromType: options.fromType || 'inner',  // 从参数获取，默认为 'inner'
        // 元数据
        metadata: {
          ...originalMetadata,
          matchedBy: route.matchedBy,
          originalChannel: channel,
          agentId,
          sessionKey,
          messageId,
          status: 'pending',
          createdAt,
          expiresAt: createdAt + 3600000,
        },
        timestamp: Date.now()
      };
      await redis.publish('wegirl:forward', JSON.stringify(forwardMsg));
      log?.info?.(`${logPrefix} forward] Message forwarded via Redis: agentId=${agentId}, sessionKey=${sessionKey}, routingId=${routingId}, flowType=${flowType}`);
    } catch (err: any) {
      log?.error?.(`${logPrefix} forward] Redis forward failed:`, err.message);
    }

    // 3. 构建 envelope
    const body = runtime.channel.reply.formatAgentEnvelope({
      channel: channel,
      from: source,
      timestamp: new Date(),
      body: message,
    });

    // 构建 inbound context
    // Provider/Surface: wegirl（当前渠道）
    // OriginatingChannel/OriginatingTo: 目标渠道，Gateway 会自动路由回复到该渠道
    // 使用 metadata 中的 originatingChannel/originatingTo 设置回复路由
    
    // 关键：在消息开头嵌入 routingId，让 agent 可以提取使用
    const messageWithRouting = `[ROUTING_ID:${routingId}]\n${message}`;
    
    const inboundCtx = runtime.channel.reply.finalizeInboundContext({
      Body: body,
      BodyForAgent: messageWithRouting,  // 包含 routingId 的消息
      RawBody: message,
      CommandBody: message,
      From: source,
      To: target,
      SessionKey: sessionKey,
      AccountId: target,
      Provider: 'wegirl',
      Surface: 'wegirl',
      ChatType: chatType,
      GroupSubject: chatType === 'group' ? chatId : undefined,
      SenderId: source,
      SenderName: source,
      MessageSid: messageId,
      Timestamp: Date.now(),
      WasMentioned: true,
      CommandAuthorized: true,
      // 关键：设置 OriginatingChannel 和 OriginatingTo，让回复能路由回发送者
      // 优先使用 replyTo 参数（从 V2 消息传入），其次使用 metadata 中的 originatingTo
      // 注意：OriginatingTo 必须是字符串，replyTo 是数组，取第一个元素
      OriginatingChannel: channel,
      OriginatingTo: (Array.isArray(replyTo) ? replyTo[0] : replyTo) || originalMetadata?.originatingTo || source,
      // 强制指定模型，避免使用默认的 anthropic
      Model: 'kimi-coding/k2p5',
    });

    log?.info?.(`${logPrefix} dispatching to agent (session=${sessionKey}, replyTo=${channel}:${target})`);

    // 等待 session 就绪，避免竞态条件
    // OpenClaw 的 session 是异步初始化的，第一次调用时可能尚未就绪
    // 策略：优先使用 ensureSessionLoaded API，否则使用指数退避重试
    let sessionReady = false;
    
    // 获取 session 管理器（如果存在）
    const sessionManager = (runtime.channel as any).session;
    
    // 尝试使用 ensureSessionLoaded API
    if (sessionManager?.ensureSessionLoaded) {
      try {
        log?.debug?.(`${logPrefix} Waiting for session via ensureSessionLoaded...`);
        await sessionManager.ensureSessionLoaded(sessionKey);
        sessionReady = true;
        log?.debug?.(`${logPrefix} Session is ready`);
      } catch (err: any) {
        log?.warn?.(`${logPrefix} ensureSessionLoaded failed: ${err.message}`);
      }
    }
    
    // 如果 ensureSessionLoaded 不可用或失败，尝试 getSessionState
    if (!sessionReady && sessionManager?.getSessionState) {
      let retries = 0;
      const maxRetries = 5;
      while (retries < maxRetries) {
        try {
          const sessionState = await sessionManager.getSessionState(sessionKey);
          if (sessionState && sessionState.ready !== false) {
            sessionReady = true;
            log?.debug?.(`${logPrefix} Session ready via getSessionState after ${retries} retries`);
            break;
          }
        } catch { /* ignore */ }
        
        retries++;
        if (retries < maxRetries) {
          const delay = Math.min(100 * Math.pow(2, retries), 1000);
          log?.debug?.(`${logPrefix} Session not ready, waiting ${delay}ms...`);
          await new Promise(r => setTimeout(r, delay));
        }
      }
    }
    
    // 兜底：如果没有可用的 session API，强制等待一小段时间
    if (!sessionReady) {
      log?.debug?.(`${logPrefix} No session API available, using fixed delay (150ms)`);
      await new Promise(r => setTimeout(r, 150));
    }

    // 创建 dispatcher，处理 Agent 回复
    // 当 channel="wegirl" 时，通过 outbound 发送；其他情况交由 Gateway 自动路由
    const { dispatcher, replyOptions: baseReplyOptions, markDispatchIdle } = runtime.channel.reply.createReplyDispatcherWithTyping({
      deliver: async (payload: ReplyPayload, info: { kind: ReplyDispatchKind }) => {
        const text = payload.text ?? '';
        
        // 记录详细的回复信息，包括错误
        if (payload.isError) {
          log?.error?.(`>=====${logPrefix} agent ERROR reply: kind=${info?.kind}, text=${text?.substring(0, 200)}, payload=${JSON.stringify(payload)}`);
        } else {
          log?.info?.(`>=====${logPrefix} agent reply: ${JSON.stringify(payload)}`);
        }

        // 只处理最终回复
        if (info?.kind !== 'final' || !text.trim()) {
          return;
        }

        // ========== 群聊多 agent 处理 ==========
        // 每个 agent 完成时立即回复（不等待聚合）
        if (chatType === 'group' && taskId && agentCount && agentCount > 1) {
          const effectiveAgentId = currentAgentId || agentId;
          log?.info?.(`${logPrefix} Group multi-agent reply: taskId=${taskId}, agent=${effectiveAgentId}`);

          try {
            const pub = await getRedisPublisher(cfg);
            if (!pub) {
              log?.error?.(`${logPrefix} Redis publisher not connected`);
              return;
            }

            // 分析回复内容确定状态
            let replyStatus: string;
            if (text.startsWith('NO_REPLY') || text.trim() === '') {
              replyStatus = 'no_reply';  // Agent 选择不回复
            } else if (text.startsWith('ERROR:') || text.includes('失败') || text.includes('错误')) {
              replyStatus = 'error';  // 明确错误
            } else if (text.includes('超时') || text.includes('timeout')) {
              replyStatus = 'timeout';  // 超时
            } else {
              replyStatus = 'completed';  // 正常完成
            }

            // 直接发送当前 agent 的回复（不聚合）- 使用标准 V2 格式
            // 使用 reverseFlowType 计算对调流向，避免重复查询 Redis
            const groupReplyFlowType = reverseFlowType(flowType);
            const replyMessage = {
              // 标准 V2 字段
              flowType: groupReplyFlowType,
              source: target,
              target: source, // 群聊时为目标群
              message: text,
              chatType: 'group',
              groupId: groupId,
              routingId,
              msgType: 'message',
              fromType: 'inner',  // 标记为内部工具调用
              // 元数据
              metadata: {
                replyStatus,
                sessionKey,
                taskId,
                isFinal: true,
                processedAt: Date.now(),
                duration: Date.now() - createdAt,
              },
              timestamp: Date.now(),
            };
            await pub.publish('wegirl:replies', JSON.stringify(replyMessage));
            log?.info?.(`${logPrefix} Group reply published to wegirl:replies from ${target}, flowType=${groupReplyFlowType}`);

            return; // 群聊多 agent 模式已处理，不执行后续单 agent 逻辑
          } catch (err: any) {
            log?.error?.(`${logPrefix} Group reply failed:`, err.message);
          }
          return;
        }

        // ========== 单 agent 回复（原有逻辑）==========
        // 只有 channel="wegirl" 或 originatingChannel="wegirl" 时才通过 outbound 发送
        // 其他 channel 由 Gateway 自动路由，不处理
        const effectiveChannel = originalMetadata?.originatingChannel || channel;
        if (effectiveChannel !== 'wegirl') {
          log?.debug?.(`${logPrefix} effectiveChannel=${effectiveChannel} !== 'wegirl', skip outbound delivery (Gateway will handle)`);
          return;
        }

        log?.info?.(`${logPrefix} replies] channel='wegirl', sending reply via outbound: ${text.substring(0, 50)}...`);
        try {
          const pub = await getRedisPublisher(cfg);
          if (!pub) {
            log?.error?.(`${logPrefix} replies] Redis publisher not connected`);
            return;
          }
          const replyId = `wegirl-reply-${Date.now()}`;
          // 使用 reverseFlowType 计算对调流向，避免重复查询 Redis
          const replyFlowType = reverseFlowType(flowType);
          const replyMessage = {
            // 标准 V2 字段
            flowType: replyFlowType,
            source: target,
            target: source,
            message: text,
            chatType,
            groupId: chatType === 'group' ? chatId : undefined,
            routingId,
            msgType: 'message',
            fromType: 'inner',  // 标记为内部工具调用
            // 元数据
            metadata: {
              inReplyTo: messageId,
              agentId: target,
              sessionKey,
              status: 'completed',
              isFinal: true,
              processedAt: Date.now(),
              duration: Date.now() - createdAt,
            },
            timestamp: Date.now(),
          };
          //log?.info?.(`${logPrefix} replyMessage params:`, JSON.stringify(replyMessage, null, 2));

          // 使用 console.log 输出到 stderr（Gateway 日志会捕获）
          console.log(`${logPrefix} replies]`, JSON.stringify(replyMessage, null, 2));

          await pub.publish('wegirl:replies', JSON.stringify(replyMessage));
          log?.info?.(`${logPrefix} replies] Reply published to wegirl:replies, flowType=${replyFlowType}`);
        } catch (err: any) {
          // 发送失败，发布错误回复
          try {
            const pub = await getRedisPublisher(cfg);
            if (pub) {
              const errorReply = {
                // 标准 V2 字段
                flowType: 'A2H',
                source: target,
                target: chatId,
                message: '',
                chatType,
                groupId: chatType === 'group' ? chatId : undefined,
                routingId,
                msgType: 'error',
                // 元数据
                metadata: {
                  inReplyTo: messageId,
                  agentId: target,
                  sessionKey,
                  status: 'failed',
                  isFinal: true,
                  processedAt: Date.now(),
                  duration: Date.now() - createdAt,
                  error: err.message,
                  errorCode: 'REPLY_PUBLISH_FAILED',
                },
                timestamp: Date.now(),
              };
              await pub.publish('wegirl:replies', JSON.stringify(errorReply));
            }
          } catch { }
          log?.error?.(`${logPrefix} replies] Failed to publish reply: ${err.message}`);
        }
      },
      onError: (error: unknown, info: { kind: ReplyDispatchKind }) => {
        const errorDetail = error instanceof Error 
          ? `${error.message}\n${error.stack}` 
          : JSON.stringify(error);
        log?.error?.(`${logPrefix} deliver error [kind=${info.kind}]: ${errorDetail}`);
      },
    });

    // 合并 replyOptions，添加模型设置
    const replyOptions = {
      ...baseReplyOptions,
      Model: 'kimi-coding/k2p5',
    };

    // 调用 dispatchReplyFromConfig 发送消息给 Agent
    const result = await runtime.channel.reply.dispatchReplyFromConfig({
      ctx: inboundCtx,
      cfg: cfg,
      dispatcher,
      replyOptions,
    });

    markDispatchIdle();
    log?.info?.(`${logPrefix} dispatch complete (queuedFinal=${result.queuedFinal}, replies=${result.counts?.final ?? 0})`);

  } catch (err: any) {
    log?.error?.(`${logPrefix} Failed: ${err.message}`);
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
