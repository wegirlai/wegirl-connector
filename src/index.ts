import Redis from 'ioredis';
import { randomUUID } from 'crypto';
import { wegirlPlugin } from './channel.js';
import { setWeGirlRuntime, setWeGirlConfig } from './runtime.js';
import { Registry } from './registry.js';
import { PendingQueue } from './queue.js';
import { MessageRouter } from './router.js';
import { WeGirlTools } from './tools.js';
import { registerEventHandlers, resetEventHandlers } from './event-handlers.js';
import { executeCreateAgent } from './hr-manage-core.js';
import { checkIsAgent, handleMentionMessage, handlePrivateMessage } from './hr-message-handler.js';
import { wegirlSend } from './core/index.js';
import { wegirlSessionsSend } from './core/sessions-send.js';
import { initGlobalConfig, getGlobalConfig, getWeGirlPluginConfig, setGlobalConfig, loadOpenClawConfig } from './config.js';
import type { MessageEnvelope } from './protocol.js';
import type {
  PluginConfig,
  EventPayload,
  PluginContext,
  ServiceConfig,
} from './types.js';

let accountsCache: Map<string, any> = new Map();

/**
 * 从 Redis 加载所有 agents 和 humans 到 accounts
 */
async function loadAccountsFromRedis(redis: Redis, logger?: any): Promise<Map<string, any>> {
  const KEY_PREFIX = 'wegirl:';
  const accounts = new Map<string, any>();

  try {
    // 获取所有 staff keys
    const keys = await redis.keys(`${KEY_PREFIX}staff:*`);
    logger?.info?.(`[WeGirl register] Loading accounts from Redis: found ${keys.length} staff keys`);

    for (const key of keys) {
      const staffId = key.toString().replace(`${KEY_PREFIX}staff:`, '');
      // 跳过特殊 keys
      if (staffId.includes(':') && !staffId.startsWith('source:')) continue;

      const data = await redis.hgetall(key);
      if (!data || Object.keys(data).length === 0) continue;

      // 将 Buffer 转换为字符串
      const getString = (val: any): string | undefined => {
        if (!val) return undefined;
        if (Buffer.isBuffer(val)) return val.toString('utf-8');
        return String(val);
      };

      const type = getString(data.type);
      const name = getString(data.name);
      const status = getString(data.status);

      // 只添加 online 状态的 agent 和 valid 的 human
      if (type === 'agent' && status === 'online') {
        accounts.set(staffId, {
          id: staffId,
          name: name || staffId,
          type: 'agent',
          status: 'online',
          capabilities: getString(data.capabilities)?.split(',') || []
        });
      } else if (type === 'human' || staffId.startsWith('source:')) {
        accounts.set(staffId, {
          id: staffId,
          name: name || staffId,
          type: 'human',
          status: status || 'active'
        });
      }
    }

    logger?.info?.(`[WeGirl register] Loaded ${accounts.size} accounts into cache`);
  } catch (err: any) {
    logger?.error?.(`[WeGirl register] Failed to load accounts from Redis:`, err.message);
  }

  return accounts;
}

/**
 * 获取 account 信息
 */
function getAccount(staffId: string): any | undefined {
  return accountsCache.get(staffId);
}

/**
 * 检查 account 是否存在
 */
function hasAccount(staffId: string): boolean {
  return accountsCache.has(staffId);
}

// 模块实例
let redisClient: Redis | null = null;
let redisConnectPromise: Promise<void> | null = null;
let hasSyncedAgents = false;  // 确保 syncAgentsFromLocal 只执行一次
let registry: Registry | null = null;
let pendingQueue: PendingQueue | null = null;
let messageRouter: MessageRouter | null = null;
let wegirlTools: WeGirlTools | null = null;

// 全局单例控制 - 确保只有一个 Stream 消费者
let globalConsumerStarted = false;
let globalStreamClient: Redis | null = null;
let globalPublisher: Redis | null = null;

const plugin = {
  id: 'wegirl',
  name: 'WeGirl',
  description: 'WeGirl Redis connector for OpenClaw - Multi-Agent orchestration hub',

  register(context: PluginContext): void {
    const logger = context.logger;

    // 从 context 获取配置（如果 OpenClaw 传入）
    const ctxCfg = (context as any).cfg || (context as any).config;
    if (ctxCfg) {
      setGlobalConfig(ctxCfg);
      logger.info('[WeGirl register] Global config set from context.cfg');
    }

    // 初始化全局配置（从文件加载，如果上面没有设置）
    initGlobalConfig();

    // 使用全局配置
    const fullConfig = getGlobalConfig();
    const pluginConfig = getWeGirlPluginConfig();

    // 实例ID（从配置读取）
    const INSTANCE_ID = pluginConfig?.instanceId || 'instance-local';

    logger.info(`[WeGirl register] Plugin registering... (Instance: ${INSTANCE_ID})`);

    // 保存 PluginRuntime
    if (context.runtime) {
      setWeGirlRuntime(context.runtime);
      logger.info('[WeGirl register] Runtime saved to global');
    } else {
      logger.error('[WeGirl register] No runtime in context!');
    }

    // 保存 PluginConfig（用于兼容性）
    setWeGirlConfig(pluginConfig);
    logger.info('[WeGirl register] PluginConfig saved to global');
    logger.info(`[WeGirl register] Redis config from openclaw.json: ${pluginConfig.redisUrl || 'not set'}`);

    // 初始化 Redis 连接
    async function initRedis(): Promise<void> {
      if (redisConnectPromise) {
        logger.debug('[initRedis] Already initializing or initialized, skipping');
        return redisConnectPromise;
      }

      logger.info('[initRedis] Starting initialization...');
      redisConnectPromise = (async () => {
        // 统一从 pluginConfig (openclaw.json 的 plugins.wegirl.config) 读取
        const config = pluginConfig || {};
        const db = config.redisDb ?? 1;
        const password = config.redisPassword;
        const url = config.redisUrl || 'redis://localhost:6379';

        logger.info(`[WeGirl register] Redis URL: ${url.replace(/:\/\/.*@/, '://***@')}, db: ${db}`);

        const redisOptions: any = {
          db,
          retryStrategy: (times: number) => {
            if (times > 10) {
              logger.error(`[WeGirl register] Redis 重试次数(${times})超过限制`);
              return null; // 停止重连
            }
            const delay = Math.min(Math.pow(2, times) * 50, 3000);
            logger.warn(`[WeGirl register] Redis 第 ${times} 次重连，${delay}ms 后尝试`);
            return delay;
          },
          connectTimeout: 10000,
          maxRetriesPerRequest: 3,
        };

        if (password) {
          redisOptions.password = password;
        }

        redisClient = new Redis(url, redisOptions);

        // 等待连接就绪
        await new Promise<void>((resolve, reject) => {
          redisClient!.once('ready', () => {
            logger.info('[WeGirl register] Redis 连接成功');
            resolve();
          });
          redisClient!.once('error', (err) => {
            logger.error('[WeGirl register] Redis 连接失败:', err.message);
            reject(err);
          });
          // 超时处理
          setTimeout(() => reject(new Error('Redis connect timeout')), 10000);
        });

        // 加载所有 agents 和 humans 到 accounts cache
        accountsCache = await loadAccountsFromRedis(redisClient!, logger);

        // 初始化队列和路由器
        if (redisClient) {
          pendingQueue = new PendingQueue(redisClient);
          messageRouter = new MessageRouter(redisClient, INSTANCE_ID, logger, url, password);
          wegirlTools = new WeGirlTools(redisClient, INSTANCE_ID, logger);

          // 启动跨实例消息监听
          await messageRouter.startListening();
          logger.info('[WeGirl register] Cross-instance message listener started');

          // 同步 agents：清理 Redis 中不存在于本地的僵尸 agent（只执行一次）
          if (!hasSyncedAgents) {
            try {
              const syncResult = await syncAgentsFromLocal(
                INSTANCE_ID,
                redisClient,
                logger
              );
              hasSyncedAgents = true;
              logger.info(`[WeGirl register] Agent sync completed: ${syncResult.kept} kept, ${syncResult.removed} zombies removed`);

              // 注册到 Registry（只做初始注册，不启动定时心跳）
              registry = new Registry(redisClient, INSTANCE_ID, logger);
              
              // 一次性注册所有本地 agent（不启动定时心跳）
              const localAgents = await getLocalAgents(logger);
              for (const agent of localAgents) {
                if (agent?.id) {
                  await registry!.register({
                    staffId: agent.id,
                    name: agent.name || agent.id,
                    type: 'agent',
                    instanceId: INSTANCE_ID
                  });
                }
              }
              logger.info(`[WeGirl register] Agents registered: ${localAgents.length}`);
              
              // 发送插件注册成功事件到 wegirl:events
              if (redisClient && redisClient.status === 'ready') {
                const eventData = {
                  id: randomUUID(),
                  type: 'plugin_registered',
                  timestamp: Date.now().toString(),
                  payload: JSON.stringify({
                    instanceId: INSTANCE_ID,
                    agentsRegistered: localAgents.length,
                    redisStatus: redisClient.status,
                    timestamp: new Date().toISOString()
                  }),
                  sessionId: 'global',
                  userId: 'system',
                  instanceId: INSTANCE_ID,
                };
                await redisClient.publish('wegirl:events', JSON.stringify(eventData));
                logger.info('[WeGirl register] Plugin registration event sent to wegirl:events');
              }
            } catch (syncErr: any) {
              logger.error('[WeGirl register] Agent sync failed:', syncErr.message);
            }
          } else {
            logger.debug('[WeGirl register] Agent sync already done, skipping');
          }
        }

      })();

      return redisConnectPromise;
    }

    // 启动初始化（异步，不阻塞注册）
    initRedis().catch((err: Error) => {
      logger.error('[WeGirl register] Redis initialization failed:', err.message);
    });

    // 启动全局 Stream 消费者（单例模式）
    // 注意：已弃用，统一使用 wegirl:stream:${instanceId}:${accountId} 格式
    // startGlobalStreamConsumer(context, pluginConfig, INSTANCE_ID).catch((err: Error) => {
    //   logger.error('[WeGirl register] Global stream consumer failed:', err.message);
    // });

    // 注册 Channel（同步）
    if (typeof context.registerChannel === 'function') {
      context.registerChannel(wegirlPlugin);
      logger.info('[WeGirl register] Channel registered');
    }

    // 注册 Tools（异步初始化后可用）
    if (typeof context.registerTool === 'function') {
      // WeGirl Send - 统一接口
      context.registerTool({
        name: 'wegirl_send',
        description: 'WeGirl 统一消息发送接口：支持 H2A/A2A/A2H 流向，多实例路由，任务和步骤追踪。所有 ID 使用 StaffId。',
        parameters: {
          type: 'object',
          properties: {
            flowType: {
              type: 'string',
              enum: ['H2A', 'A2A', 'A2H'],
              description: '消息流向类型: H2A(human->agent), A2A(agent->agent), A2H(agent->human)'
            },
            source: {
              type: 'string',
              description: '来源 StaffId（必填）。普通 staffId 使用小写（如 "hr", "scout"）；未入职用户使用 source: 前缀（如 "source:temp_xxx"）'
            },
            target: {
              type: 'string',
              description: '目标 StaffId（必填）。普通 staffId 使用小写；未入职用户使用 source: 前缀'
            },
            message: {
              type: 'string',
              description: '消息内容（必填）'
            },
            chatType: {
              type: 'string',
              enum: ['direct', 'group'],
              description: '聊天类型: direct(单聊默认), group(群聊)',
              default: 'direct'
            },
            groupId: {
              type: 'string',
              description: '群聊ID（chatType=group 时必填）'
            },
            replyTo: {
              oneOf: [
                { type: 'string' },
                { type: 'array', items: { type: 'string' } }
              ],
              description: '回复目标 StaffId（必填）。指定谁应该收到回复。单聊时通常是原始发送者，群聊时可以是多个目标。使用 "system:no_reply" 表示不回复'
            },
            taskId: {
              type: 'string',
              description: '任务ID（可选，如有则全程携带）'
            },
            stepId: {
              type: 'string',
              description: '步骤ID（可选，需配合 taskId）'
            },
            stepTotalAgents: {
              type: 'number',
              description: '步骤总 Agent 数（stepId 存在时）'
            },
            routingId: {
              type: 'string',
              description: '路由追踪ID（必填）。从当前消息上下文中提取（如 message.routingId 或 context.RoutingId），用于保持调用链一致。整个 workflow 中必须传递相同的 routingId。'
            },
            timeoutSeconds: {
              type: 'number',
              minimum: 0,
              maximum: 300,
              description: '超时秒数（可选，默认 0）。0=异步发送立即返回；>0=同步等待响应，最大 300 秒（5分钟）',
              default: 0
            }
          },
          required: ['flowType', 'source', 'target', 'message', 'replyTo', 'routingId']
        },
        execute: async (_toolCallId: string, params: any) => {
          logger.info(`[wegirl_send] 调用: ${JSON.stringify(params)}`);

          try {
            const result = await wegirlSend(params, logger);
            const resultText = result.success
              ? `消息已发送给 ${params.target}`
              : `发送失败: ${result.error || '未知错误'}`;
            return {
              content: [{ type: "text" as const, text: resultText }],
              details: {
                success: result.success,
                routingId: result.routingId,
                local: result.local,
                targetInstanceId: result.targetInstanceId,
                error: result.error
              }
            };
          } catch (err: any) {
            logger.error(`[wegirl_send] 失败:`, err.message);
            return {
              content: [{ type: "text" as const, text: `发送失败: ${err.message}` }],
              details: {
                success: false,
                error: err.message
              }
            };
          }
        }
      } as any);

      // HR Manage Tool - 仅限 HR Agent 使用
      context.registerTool({
        name: 'hr',
        description: 'HR Agent 专用：处理新成员入职、查看团队花名册、查询员工信息、管理Agent性格和能力、创建新Agent。使用场景：1) 处理新员工入职使用 create_staff；2) 查看所有员工使用 list_staffs；3) 查询特定员工信息使用 get_staff；4) 更新Agent性格和能力使用 update_agent_profile；5) 获取Agent详细档案使用 get_agent_profile；6) 创建新 Agent 使用 create_agent（示例：创建 agent：cncplanner，CNC独立站的策划师）。\n\n**重要提示**：当需要将结果发送给特定用户时，必须传递 replyTo 参数（例如：replyTo: "human:tiger" 或 replyTo: "tiger"）。如果不传递 replyTo，结果将只返回给当前会话。',
        parameters: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['list_staffs', 'get_staff', 'send_command', 'create_staff', 'create_agent', 'update_agent_profile', 'get_agent_profile'],
              description: '操作类型'
            },
            // 用于 create_agent
            agentName: {
              type: 'string',
              description: 'Agent 名称（create_agent 时使用，如：cncplanner）'
            },
            description: {
              type: 'string',
              description: 'Agent 职责描述（create_agent 时使用，如：CNC独立站的策划师）'
            },
            // 用于 get_staff, get_agent_profile, update_agent_profile
            accountId: {
              type: 'string',
              description: 'Agent ID（get_staff/get_agent_profile/update_agent_profile 时使用）'
            },
            // 用于 update_agent_profile
            profile: {
              type: 'object',
              description: 'Agent 档案（update_agent_profile 时使用）',
              properties: {
                name: { type: 'string', description: '显示名称' },
                description: { type: 'string', description: '职责描述' },
                personality: {
                  type: 'object',
                  description: '性格配置',
                  properties: {
                    vibe: { type: 'string', description: '整体风格' },
                    traits: { type: 'array', items: { type: 'string' }, description: '性格特质' },
                    emoji: { type: 'string', description: '代表表情' },
                    voice: { type: 'string', description: '语音风格' },
                    style: { type: 'string', description: '沟通风格' }
                  }
                },
                capabilities: { type: 'array', items: { type: 'string' }, description: '能力标签' },
                workspace: { type: 'string', description: '工作空间路径' }
              }
            },
            payload: {
              type: 'object',
              description: '命令参数（send_command 时使用）'
            },
            message: {
              type: 'string',
              description: '用户发送的完整消息内容'
            },
            senderName: {
              type: 'string',
              description: '用户显示名称（可选，如：张三）'
            },
            groupId: {
              type: 'string',
              description: '群聊ID（chatType=group 时必填）'
            },
            source: {
              type: 'string',
              description: '来源用户的 StaffId（工号），从 session context 的 From 字段获取'
            },
            target: {
              type: 'string',
              description: '目标接收者的 StaffId（工号），固定为 "hr"（消息接收者）',
              default: 'hr'
            },
            chatType: {
              type: 'string',
              enum: ['direct', 'group'],
              description: '聊天类型：direct=私聊，group=群聊',
              default: 'direct'
            },
            routingId: {
              type: 'string',
              description: '路由追踪ID（可选）'
            },
            replyTo: {
              type: 'string',
              description: '回复目标 StaffId（重要！）。当需要将结果发送给指定用户时，必须传递此参数。例如："human:tiger" 或 "tiger"'
            }
          },
          required: ['action']
        },
        execute: async (_toolCallId: string, params: any) => {
          console.log(`[hr] 被调用, params=${JSON.stringify(params)}`);

          await initRedis();
          if (!redisClient) throw new Error('Redis not initialized');

          const { action } = params;
          const INSTANCE_ID = pluginConfig?.instanceId || 'instance-local';

          // 获取消息上下文信息（用于主动回复）
          const routingId = params.routingId;
          // replyTo 可能是 string 或 string[]，统一处理为 string
          // 优先使用传入的 replyTo，如果没有则尝试从消息上下文中获取
          const rawReplyTo = params.replyTo || params.source;
          const replyTo = Array.isArray(rawReplyTo) ? rawReplyTo[0] : rawReplyTo;
          
          logger?.info?.(`[hr] 处理 action=${action}, replyTo=${replyTo}, routingId=${routingId}`);
          const isSyncMode = params.timeoutSeconds > 0;

          let result: any;
          switch (action) {
            case 'create_staff': {
              const { message, chatType, source, target, senderName, groupId } = params;

              console.log(`[hr_manage:create_staff] 收到参数:`, JSON.stringify({ message, chatType, source, target, senderName, groupId, routingId }));

              // 构建标准化的消息对象（与 SessionsSendOptions 对齐）
              // source 保持原样传入，包含 "source:" 或 "source：" 前缀
              const normalizedMessage = {
                chatType: chatType || 'direct',
                source: source,
                message: message,
                target: target,
                groupId: groupId,
                routingId: routingId
              };

              console.log(`[hr_manage:create_staff] 构建消息对象:`, JSON.stringify(normalizedMessage));

              result = await handleProcessMessage(
                normalizedMessage,
                redisClient,
                logger,
                INSTANCE_ID
              );

              console.log(`[hr_manage:create_staff] handleProcessMessage 返回:`, JSON.stringify(result));

              // 返回 null，deliver 不会发送任何消息
              return null;
            }
            case 'list_staffs':
              result = await handleListAgents(redisClient, logger);
              break;
            case 'get_staff':
              result = await handleGetAgent(params, redisClient, logger);
              break;
            case 'get_agent_profile':
              result = await handleGetAgentProfile(params, redisClient, logger);
              break;
            case 'update_agent_profile':
              result = await handleUpdateAgentProfile(params, redisClient, logger);
              break;
            case 'send_command': {
              const { command, payload: cmdPayload } = params;
              if (!command) {
                throw new Error('缺少必填参数: command');
              }
              result = await handleSendCommand(
                { command, payload: cmdPayload || {} },
                redisClient,
                logger,
                INSTANCE_ID
              );
              break;
            }
            case 'create_agent': {
              const { agentName, description: agentDescription } = params;
              if (!agentName) {
                throw new Error('缺少必填参数: agentName（如：cncplanner）');
              }

              logger.info(`[hr:create_agent] 创建 Agent: ${agentName}, 描述: ${agentDescription || '无'}`);

              // 导入 executeCreateAgent
              const { executeCreateAgent } = await import('./hr-manage-core.js');

              const createResult = await executeCreateAgent(
                {
                  agentName: agentName.toLowerCase(),
                  accountId: agentName.toLowerCase(),
                  instanceId: INSTANCE_ID,
                  capabilities: [agentName.toLowerCase(), 'wegirl_send'],
                  role: agentDescription || '-'
                },
                {
                  instanceId: INSTANCE_ID,
                  logger,
                  redis: redisClient
                }
              );

              result = {
                success: createResult.success,
                action: 'create_agent',
                agentName: createResult.agentName,
                accountId: createResult.accountId,
                workspacePath: createResult.metadata.workspacePath,
                steps: createResult.steps,
                error: createResult.error
              };
              break;
            }
            default:
              throw new Error(`未知操作: ${action}`);
          }

          logger.info(`[hr] action=${action} 执行完成`);

          // create_staff 已通过 redis 发送消息，返回 null 阻止 deliver
          if (action === 'create_staff') {
            return null;
          }

          // === 主动回复逻辑 ===
          // 如果 replyTo 存在且不是自己，主动发送结果给 replyTo
          if (replyTo && replyTo !== 'hr' && !replyTo.includes('hr')) {
            logger.info(`[hr] 检测到 replyTo=${replyTo}，准备主动发送结果`);
            
            try {
              // 动态导入 wegirlSend 避免循环依赖
              const { wegirlSend } = await import('./core/send.js');
              
              const replyMessage = formatResultForReply(action, result);
              const targetType = replyTo.startsWith('source:') || replyTo.startsWith('ou_') 
                ? 'A2H' : 'A2A';
              
              // 发送给 replyTo
              await wegirlSend({
                flowType: targetType,
                source: 'hr',
                target: replyTo,
                message: replyMessage,
                replyTo: replyTo,
                routingId: routingId || `hr-reply-${Date.now()}`,
                chatType: 'direct'
              }, logger);
              
              logger.info(`[hr] 已主动发送结果给 ${replyTo}`);
              
              // 主动发送后，返回 null 防止再次发送
              return null;
            } catch (err: any) {
              logger.error(`[hr] 主动发送失败: ${err.message}`);
              // 发送失败，返回正常结果
            }
          }

          // 返回 OpenClaw 期望的格式
          return {
            content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
            details: result
          };
        }
      } as any);

      logger.info('[WeGirl register] Tools registered: wegirl_send, hr_manage');
    } else {
      logger.warn('[WeGirl register] registerTool not available');
    }

    // TODO: default 消息处理通过 Stream 消费端实现
    // 当收到 target 为 default:{instance} 的消息时，
    // 在 messageRouter 中处理并调用 executeCreateAgent

    // 重置并注册事件处理器 - 使用单独文件
    resetEventHandlers();
    registerEventHandlers({
      context,
      logger,
      pluginConfig,
      getRedisClient: () => redisClient,
      getRegistry: () => registry,
      instanceId: INSTANCE_ID
    });

    // HTTP 路由
    if (typeof context.registerHttpRoute === 'function') {
      // Webhook 接收端点
      context.registerHttpRoute({
        path: '/wegirl/webhook',
        method: 'POST',
        handler: async (req: any, res: any) => {
          try {
            const data = JSON.parse(req.body);
            logger.info('[WeGirl register] Webhook received:', JSON.stringify(data));

            res.status(200).json({ success: true });
          } catch (err: any) {
            logger.error('[WeGirl register] Webhook error:', err.message);
            res.status(500).json({ error: err.message });
          }
        }
      });

      // 监控接口 - Stream 和 Consumer Group 状态
      context.registerHttpRoute({
        path: '/wegirl/metrics',
        method: 'GET',
        handler: async (_req: any, res: any) => {
          try {
            await initRedis();
            if (!redisClient) {
              return res.status(503).json({ error: 'Redis not connected' });
            }

            const KEY_PREFIX = 'wegirl:';
            const instanceId = pluginConfig?.instanceId || 'instance-local';
            const streamKey = `${KEY_PREFIX}stream:instance:${instanceId}`;
            const consumerGroup = 'wegirl-consumers';

            const metrics: any = {
              timestamp: Date.now(),
              instanceId,
              streamKey,
              consumerGroup
            };

            // 1. Stream 基本信息
            try {
              const streamInfo = await redisClient.xinfo('STREAM', streamKey) as any[];
              const infoMap: Record<string, any> = {};
              for (let i = 0; i < streamInfo.length; i += 2) {
                infoMap[streamInfo[i]] = streamInfo[i + 1];
              }
              metrics.stream = {
                length: infoMap.length || 0,
                radixTreeKeys: infoMap['radix-tree-keys'],
                radixTreeNodes: infoMap['radix-tree-nodes'],
                groups: infoMap.groups || 0,
                lastGeneratedId: infoMap['last-generated-id'],
                firstEntry: infoMap['first-entry'] ? {
                  id: infoMap['first-entry'][0],
                  data: infoMap['first-entry'][1]
                } : null,
                lastEntry: infoMap['last-entry'] ? {
                  id: infoMap['last-entry'][0],
                  data: infoMap['last-entry'][1]
                } : null
              };
            } catch (err: any) {
              if (err.message?.includes('no such key')) {
                metrics.stream = { exists: false, length: 0 };
              } else {
                metrics.stream = { error: err.message };
              }
            }

            // 2. Consumer Group 信息
            try {
              const groupInfo = await redisClient.xinfo('GROUPS', streamKey) as any[];
              const groups = [];
              for (const group of groupInfo) {
                const groupMap: Record<string, any> = {};
                for (let i = 0; i < group.length; i += 2) {
                  groupMap[group[i]] = group[i + 1];
                }
                groups.push({
                  name: groupMap.name,
                  consumers: groupMap.consumers || 0,
                  pending: groupMap.pending || 0,
                  lastDeliveredId: groupMap['last-delivered-id']
                });
              }
              metrics.consumerGroups = groups;
            } catch (err: any) {
              if (err.message?.includes('no such key')) {
                metrics.consumerGroups = [];
              } else {
                metrics.consumerGroups = { error: err.message };
              }
            }

            // 3. Pending 消息详情（如果组存在）
            try {
              const pending = await redisClient.xpending(streamKey, consumerGroup) as any[];
              if (pending && Array.isArray(pending)) {
                metrics.pending = {
                  count: pending[0] as number || 0,
                  minId: pending[1] || null,
                  maxId: pending[2] || null
                };

                // 如果 pending 数量 > 0，获取详细列表
                if ((pending[0] as number) > 0) {
                  const pendingDetails = await redisClient.xpending(
                    streamKey, consumerGroup,
                    '-', '+', Math.min(pending[0] as number, 10)  // 最多返回 10 条
                  ) as any[];
                  metrics.pending.details = pendingDetails.map((p: any) => ({
                    messageId: p[0],
                    consumer: p[1],
                    idleTimeMs: p[2],
                    deliveryCount: p[3]
                  }));
                }
              }
            } catch (err: any) {
              metrics.pending = { error: err.message };
            }

            // 4. 活跃 Agent 统计 (使用统一的 staff key)
            try {
              const staffKeys = await redisClient.keys(`${KEY_PREFIX}staff:*`);
              const agentKeys = staffKeys.filter(k => !k.includes(':by-type:') && !k.includes(':capability:'));
              const agentIds: string[] = [];
              for (const key of agentKeys) {
                const data = await redisClient.hgetall(key);
                if (data.type === 'agent') {
                  agentIds.push(data.staffId);
                }
              }
              metrics.agents = {
                total: agentIds.length,
                list: agentIds
              };
            } catch (err: any) {
              metrics.agents = { error: err.message };
            }

            // 5. 能力索引统计
            try {
              const capabilityKeys = await redisClient.keys(`${KEY_PREFIX}capability:*`);
              const capabilities: Record<string, number> = {};
              for (const key of capabilityKeys) {
                const cap = key.replace(`${KEY_PREFIX}capability:`, '');
                const count = await redisClient.scard(key);
                capabilities[cap] = count;
              }
              metrics.capabilities = capabilities;
            } catch (err: any) {
              metrics.capabilities = { error: err.message };
            }

            res.status(200).json(metrics);
          } catch (err: any) {
            logger.error('[WeGirl register] Metrics error:', err.message);
            res.status(500).json({ error: err.message });
          }
        }
      });

      // 健康检查端点
      context.registerHttpRoute({
        path: '/wegirl/health',
        method: 'GET',
        handler: async (_req: any, res: any) => {
          try {
            await initRedis();
            if (!redisClient) {
              return res.status(503).json({
                status: 'unhealthy',
                redis: 'disconnected',
                timestamp: Date.now()
              });
            }
            await redisClient.ping();
            res.status(200).json({
              status: 'healthy',
              redis: 'connected',
              instanceId: pluginConfig?.instanceId || 'instance-local',
              timestamp: Date.now()
            });
          } catch (err: any) {
            res.status(503).json({
              status: 'unhealthy',
              redis: 'error',
              error: err.message,
              timestamp: Date.now()
            });
          }
        }
      });
    }

    logger.info('[WeGirl register] Plugin registered successfully');
  },
};

// ============ HR Manage Tool Handlers ============

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// 获取 OpenClaw 配置路径（支持环境变量或默认用户目录）
function getOpenClawConfigPath(): string {
  if (process.env.OPENCLAW_CONFIG_PATH) {
    return process.env.OPENCLAW_CONFIG_PATH;
  }
  const homeDir = process.env.OPENCLAW_HOME || os.homedir();
  return path.join(homeDir, '.openclaw', 'openclaw.json');
}

// 获取 OpenClaw 主目录
function getOpenClawHome(): string {
  return process.env.OPENCLAW_HOME || path.join(os.homedir(), '.openclaw');
}

interface CreateAgentArgs {
  agentName: string;
  accountId: string;
  instanceId?: string;
  capabilities?: string[];
}

/**
 * 创建新 Agent
 * 流程：
 * 1. 执行 openclaw agents add {agentName}
 * 2. 更新 openclaw.json（binding + wegirl account）
 * 3. 注册到 Redis
 *
 * 注意：实际实现已移至 hr-manage-core.ts 中的 executeCreateAgent
 */

/**
 * 列出所有 Agents (使用统一的 staff key)
 */
async function handleListAgents(redis: Redis, logger: any): Promise<any> {
  logger.info('[hr] Listing all agents');

  const KEY_PREFIX = 'wegirl:';
  // 获取所有 staff，过滤出纯 staff key（排除 :position, :by-type: 等后缀）
  const keys = await redis.keys(`${KEY_PREFIX}staff:*`);
  const staffKeys = keys.filter(k => {
    // 只保留 wegirl:staff:xxx 格式，排除 wegirl:staff:xxx:position 等
    const parts = k.split(':');
    return parts.length === 3 && !k.includes(':by-type:') && !k.includes(':capability:') && !k.includes(':personality:');
  });

  logger.info(`[hr] Found ${staffKeys.length} staff keys: ${staffKeys.join(', ')}`);

  const agents = await Promise.all(
    staffKeys.map(async (key) => {
      try {
        // 先检查 key 类型
        const keyType = await redis.type(key);
        if (keyType !== 'hash') {
          logger.warn(`[hr] Skipping non-hash key: ${key} (type: ${keyType})`);
          return null;
        }

        const data = await redis.hgetall(key);
        // 只返回 agent 类型
        if (data.type !== 'agent') return null;

        // 解析性格和能力
        let personalityVibe = '-';
        let capabilities: string[] = [];
        try {
          if (data.personality) {
            const p = JSON.parse(data.personality);
            personalityVibe = p.vibe || p.style || '-';
          }
        } catch (e) {
          // ignore
        }
        try {
          if (data.capabilities) {
            capabilities = JSON.parse(data.capabilities);
          }
        } catch (e) {
          capabilities = data.capabilities?.split(',').filter(Boolean) || [];
        }

        return {
          accountId: data.staffId,
          name: data.name,
          type: data.type,
          role: data.role || '-',
          instanceId: data.instanceId,
          status: data.status,
          personalityVibe,
          capabilities: capabilities.slice(0, 3), // 只显示前3个能力
          capabilityCount: capabilities.length,
          lastHeartbeat: data.lastHeartbeat
        };
      } catch (err: any) {
        logger.error(`[hr] Error reading key ${key}: ${err.message}`);
        return null;
      }
    })
  );

  const validAgents = agents.filter(a => a !== null);
  logger.info(`[hr] Returning ${validAgents.length} agents`);

  return {
    success: true,
    count: validAgents.length,
    agents: validAgents
  };
}

/**
 * 获取单个 Agent 信息 (使用统一的 staff key)
 */
async function handleGetAgent(args: any, redis: Redis, logger: any): Promise<any> {
  const { accountId } = args;
  logger.info(`[hr] Getting agent: ${accountId}`);

  const KEY_PREFIX = 'wegirl:';
  const data = await redis.hgetall(`${KEY_PREFIX}staff:${accountId}`);

  if (!data.staffId) {
    return { success: false, error: `Agent not found: ${accountId}` };
  }

  return {
    success: true,
    agent: {
      accountId: data.staffId,
      name: data.name,
      instanceId: data.instanceId,
      status: data.status,
      capabilities: data.capabilities?.split(',') || [],
      lastHeartbeat: data.lastHeartbeat,
      load: {
        activeTasks: parseInt(data['load:activeTasks'] || '0'),
        pendingTasks: parseInt(data['load:pendingTasks'] || '0')
      }
    }
  };
}

/**
 * 获取 Agent 详细档案（包括性格和能力）
 */
async function handleGetAgentProfile(args: any, redis: Redis, logger: any): Promise<any> {
  const { accountId } = args;
  if (!accountId) {
    return { success: false, error: '缺少必填参数: accountId' };
  }

  logger.info(`[hr] Getting agent profile: ${accountId}`);

  const KEY_PREFIX = 'wegirl:';
  const data = await redis.hgetall(`${KEY_PREFIX}staff:${accountId}`);

  if (!data.staffId) {
    return { success: false, error: `Agent not found: ${accountId}` };
  }

  // 解析 JSON 字段
  let personality = {};
  let capabilities = [];
  try {
    if (data.personality) {
      personality = JSON.parse(data.personality);
    }
  } catch (e) {
    logger.warn(`[hr] Failed to parse personality for ${accountId}`);
  }

  try {
    if (data.capabilities) {
      capabilities = JSON.parse(data.capabilities);
    }
  } catch (e) {
    // 兼容旧格式（逗号分隔）
    capabilities = data.capabilities?.split(',').filter(Boolean) || [];
  }

  return {
    success: true,
    agent: {
      accountId: data.staffId,
      name: data.name,
      type: data.type,
      instanceId: data.instanceId,
      status: data.status,
      description: data.description || '',
      workspace: data.workspace || '',
      personality,
      capabilities,
      metadata: {
        createdAt: data.createdAt,
        updatedAt: data.updatedAt,
        version: data.version || '1.0'
      },
      lastHeartbeat: data.lastHeartbeat
    }
  };
}

/**
 * 更新 Agent 档案（性格、能力等）
 */
async function handleUpdateAgentProfile(args: any, redis: Redis, logger: any): Promise<any> {
  const { accountId, profile } = args;
  if (!accountId) {
    return { success: false, error: '缺少必填参数: accountId' };
  }
  if (!profile || typeof profile !== 'object') {
    return { success: false, error: '缺少必填参数: profile' };
  }

  logger.info(`[hr] Updating agent profile: ${accountId}`);

  const KEY_PREFIX = 'wegirl:';
  const key = `${KEY_PREFIX}staff:${accountId}`;

  // 检查 agent 是否存在
  const exists = await redis.exists(key);
  if (!exists) {
    return { success: false, error: `Agent not found: ${accountId}` };
  }

  const pipeline = redis.pipeline();
  const now = Date.now().toString();

  // 更新基本字段
  if (profile.name !== undefined) {
    pipeline.hset(key, 'name', profile.name);
  }
  if (profile.description !== undefined) {
    pipeline.hset(key, 'description', profile.description);
  }
  if (profile.workspace !== undefined) {
    pipeline.hset(key, 'workspace', profile.workspace);
  }

  // 更新性格（JSON 存储）
  if (profile.personality !== undefined) {
    pipeline.hset(key, 'personality', JSON.stringify(profile.personality));

    // 更新性格标签索引
    if (profile.personality.traits && Array.isArray(profile.personality.traits)) {
      // 先获取旧的 personality 以清理旧索引
      const oldData = await redis.hget(key, 'personality');
      let oldTraits: string[] = [];
      try {
        const oldPersonality = JSON.parse(oldData || '{}');
        oldTraits = oldPersonality.traits || [];
      } catch (e) {
        // ignore
      }

      // 移除旧的性格索引
      for (const trait of oldTraits) {
        pipeline.srem(`${KEY_PREFIX}personality:${trait}`, accountId);
      }
      // 添加新的性格索引
      for (const trait of profile.personality.traits) {
        if (trait) {
          pipeline.sadd(`${KEY_PREFIX}personality:${trait}`, accountId);
        }
      }
    }
  }

  // 更新能力（JSON 数组存储）
  if (profile.capabilities !== undefined && Array.isArray(profile.capabilities)) {
    // 获取旧的能力以清理索引
    const oldCapsData = await redis.hget(key, 'capabilities');
    let oldCaps: string[] = [];
    try {
      oldCaps = JSON.parse(oldCapsData || '[]');
    } catch (e) {
      oldCaps = oldCapsData?.split(',').filter(Boolean) || [];
    }

    // 移除旧的能力索引
    for (const cap of oldCaps) {
      pipeline.srem(`${KEY_PREFIX}capability:${cap}`, accountId);
    }
    // 添加新的能力索引
    for (const cap of profile.capabilities) {
      if (cap) {
        pipeline.sadd(`${KEY_PREFIX}capability:${cap}`, accountId);
      }
    }

    pipeline.hset(key, 'capabilities', JSON.stringify(profile.capabilities));
  }

  // 更新时间戳
  pipeline.hset(key, 'updatedAt', now);

  await pipeline.exec();

  logger.info(`[hr] Agent profile updated: ${accountId}`);

  return {
    success: true,
    message: `Agent ${accountId} profile updated successfully`,
    accountId,
    updatedAt: now
  };
}

/**
 * 删除 Agent（仅 Redis 注册信息）- 使用统一的 staff key
 */
async function handleDeleteAgent(args: any, redis: Redis, logger: any): Promise<any> {
  const { accountId } = args;
  logger.info(`[hr] Deleting agent: ${accountId}`);

  const KEY_PREFIX = 'wegirl:';

  // 获取 staff 信息
  const data = await redis.hgetall(`${KEY_PREFIX}staff:${accountId}`);
  if (!data.staffId) {
    return { success: false, error: `Agent not found: ${accountId}` };
  }

  const capabilities = data.capabilities?.split(',') || [];
  const instanceId = data.instanceId;

  // 删除能力索引
  for (const cap of capabilities) {
    await redis.srem(`${KEY_PREFIX}capability:${cap}`, accountId);
  }

  // 从类型索引移除
  await redis.srem(`${KEY_PREFIX}staff:by-type:agent`, accountId);

  // 从实例集合移除 (使用新的 staff 集合)
  await redis.srem(`${KEY_PREFIX}instance:${instanceId}:staff`, accountId);

  // 删除 staff 信息
  await redis.del(`${KEY_PREFIX}staff:${accountId}`);

  logger.info(`[hr] Agent ${accountId} deleted from Redis`);

  return {
    success: true,
    message: `Agent ${accountId} deleted from Redis (注：OpenClaw agent 文件未删除，请手动执行: openclaw agents remove ${data.name?.replace(' Notifier', '').toLowerCase()})`
  };
}

/**
 * 从 openclaw.json 读取 instanceId
 */
function getInstanceIdFromConfig(logger?: any): string {
  try {
    const configPath = getOpenClawConfigPath();
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    const instanceId = config.plugins?.wegirl?.config?.instanceId || 'instance-local';
    logger?.info?.(`[hr] Got instanceId from openclaw.json: ${instanceId}`);
    return instanceId;
  } catch (err: any) {
    logger?.error?.(`[hr] Failed to read instanceId from config: ${err.message}`);
    return 'instance-local';
  }
}

// ============ Agent 同步与清理 ============

interface SyncResult {
  kept: number;
  removed: number;
  removedIds: string[];
  registered?: number;
}

// 获取本地所有 agents（从配置文件读取）
async function getLocalAgents(logger: any): Promise<Array<{ name: string; id: string }>> {
  try {
    const configPath = getOpenClawConfigPath();
    logger.info(`[sync] Reading config from: ${configPath}`);

    if (!fs.existsSync(configPath)) {
      logger.warn(`[sync] Config file not found: ${configPath}`);
      return [];
    }

    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    // openclaw.json 中 agents 在 .agents.list 数组中
    const agents = config.agents?.list || [];
    logger.info(`[sync] Found ${agents.length} agents in config`);

    return agents
      .filter((a: any) => a != null)  // 过滤掉 null/undefined
      .map((a: any) => ({
        name: a.name || a.id,
        id: a.id
      }));
  } catch (err: any) {
    logger.error(`[sync] Failed to read local agents: ${err.message}`);
    return [];
  }
}

// 从 Redis 清理单个 agent (使用统一的 staff key)
async function cleanupAgentFromRedis(
  accountId: string,
  instanceId: string,
  redis: Redis,
  logger: any
): Promise<void> {
  const KEY_PREFIX = 'wegirl:';

  const staffData = await redis.hgetall(`${KEY_PREFIX}staff:${accountId}`);
  const capabilities = staffData.capabilities?.split(',') || [];

  // 删除能力索引
  for (const cap of capabilities) {
    await redis.srem(`${KEY_PREFIX}capability:${cap}`, accountId);
  }

  // 从类型索引移除
  await redis.srem(`${KEY_PREFIX}staff:by-type:agent`, accountId);

  // 从实例集合移除 (使用新的 staff 集合)
  await redis.srem(`${KEY_PREFIX}instance:${instanceId}:staff`, accountId);

  // 删除 staff 信息
  await redis.del(`${KEY_PREFIX}staff:${accountId}`);

  logger.info(`[sync] Cleaned up zombie agent: ${accountId}`);
}

// 同步 agents：注册本地 agents，清理僵尸 agents (使用统一的 staff key)
async function syncAgentsFromLocal(
  instanceId: string,
  redis: Redis,
  logger: any
): Promise<SyncResult> {
  const KEY_PREFIX = 'wegirl:';

  logger.info(`[sync] Starting agent sync for instance: ${instanceId}`);

  // 1. 获取本地所有 agents
  const localAgents = await getLocalAgents(logger);
  logger.info(`[sync] Found ${localAgents.length} local agents`);

  // 2. 获取 Redis 中该实例的所有 staff (agent 类型)
  const redisStaffIds = await redis.smembers(
    `${KEY_PREFIX}instance:${instanceId}:staff`
  );

  // 过滤出 agent 类型的 staff
  const redisAgentIds: string[] = [];
  for (const staffId of redisStaffIds) {
    const data = await redis.hgetall(`${KEY_PREFIX}staff:${staffId}`);
    if (data.type === 'agent') {
      redisAgentIds.push(staffId);
    }
  }
  logger.info(`[sync] Found ${redisAgentIds.length} agents in Redis`);

  const toKeep: string[] = [];
  const toRemove: string[] = [];
  const toRegister: Array<{ name: string; id: string }> = [];

  // 检查 Redis 中的 agents：保留存在的，清理僵尸
  for (const accountId of redisAgentIds) {
    const staffData = await redis.hgetall(`${KEY_PREFIX}staff:${accountId}`);
    const agentName = staffData.name?.replace(' Notifier', '').toLowerCase();

    // 检查本地是否存在
    const existsLocally = localAgents?.some(
      a => a?.name?.toLowerCase() === agentName || a?.id === accountId
    ) || false;

    if (existsLocally) {
      toKeep.push(accountId);
      // 更新心跳
      await redis.hset(`${KEY_PREFIX}staff:${accountId}`, {
        lastHeartbeat: Date.now().toString(),
        status: 'online'
      });
    } else {
      // 僵尸 agent：本地已不存在，需要清理
      toRemove.push(accountId);
    }
  }

  // 检查本地 agents：注册 Redis 中不存在的
  for (const localAgent of (localAgents || [])) {
    if (!localAgent?.name) continue;
    const accountId = `${localAgent.name}`;
    if (!redisAgentIds.includes(accountId)) {
      toRegister.push(localAgent);
    }
  }

  // 3. 注册新 agents (使用统一的 staff key)
  for (const agent of toRegister) {
    const accountId = `${agent.name}`;
    const agentCapabilities = [agent.name, 'wegirl_send'];

    await redis.hset(`${KEY_PREFIX}staff:${accountId}`, {
      staffId: accountId,
      type: 'agent',
      instanceId: instanceId,
      role: '-',
      name: agent.name,
      capabilities: agentCapabilities.join(','),
      status: 'online',
      lastHeartbeat: Date.now().toString(),
      'load:activeTasks': '0',
      'load:pendingTasks': '0'
    });

    // 添加到能力索引
    for (const cap of agentCapabilities) {
      await redis.sadd(`${KEY_PREFIX}capability:${cap}`, accountId);
    }

    // 添加到类型索引
    await redis.sadd(`${KEY_PREFIX}staff:by-type:agent`, accountId);

    // 添加到实例集合 (使用新的 staff 集合)
    await redis.sadd(`${KEY_PREFIX}instance:${instanceId}:staff`, accountId);

    logger.info(`[sync] Registered agent: ${accountId}`);
  }

  // 4. 清理僵尸 agents
  for (const accountId of toRemove) {
    await cleanupAgentFromRedis(accountId, instanceId, redis, logger);
  }

  logger.info(`[sync] Sync complete: ${toKeep.length} kept, ${toRegister.length} registered, ${toRemove.length} zombies removed`);

  return {
    kept: toKeep.length,
    removed: toRemove.length,
    removedIds: toRemove,
    registered: toRegister.length
  };
}

// ============ HR Command Sender ============

interface SendCommandArgs {
  command: string;
  payload: Record<string, any>;
}

/**
 * 发送 HR 命令到 wegirl:replies channel
 * wegirl-service 会根据消息类型处理这些命令
 */
async function handleSendCommand(
  args: SendCommandArgs,
  redis: Redis,
  logger: any,
  instanceId: string
): Promise<any> {
  const { command, payload } = args;

  logger.info(`[hr_manage:send_command] Sending command: ${command}`);

  // 构建消息 - 使用标准 V2 格式
  const routingId = randomUUID();
  const message = {
    flowType: 'A2A' as const,
    source: 'hr',
    target: payload?.agentId || 'default',
    message: command,
    chatType: 'direct' as const,
    routingId,
    msgType: 'hr_command',
    payload: {
      ...payload,
      fromAgent: 'hr',
      instanceId,
    },
    metadata: {
      originalCommand: command,
    },
    timestamp: Date.now(),
  };

  try {
    // 发布到 wegirl:replies channel
    await redis.publish('wegirl:replies', JSON.stringify(message));

    logger.info(`[hr_manage:send_command] Command sent to wegirl:replies: ${command}`);

    return {
      success: true,
      command: command,
      message: `命令 ${command} 已发送到 wegirl:replies`,
      payload: payload
    };
  } catch (err: any) {
    logger.error(`[hr_manage:send_command] Failed to send command: ${err.message}`);
    throw new Error(`发送命令失败: ${err.message}`);
  }
}

/**
 * 处理入职消息
 * 根据消息类型（私聊/群聊@）判断并发送相应命令
 */
async function handleProcessMessage(
  message: any,
  redis: Redis,
  logger: any,
  instanceId: string
): Promise<any> {
  logger.info(`[hr_manage:create_staff] Processing message`);

  const chatType = message.chatType || message.chat_type;
  const source = message.source;
  const target = message.target;
  const mentions = message.mentions || message.metadata?.mentions || [];

  // 1. 私聊消息 → 入职绑定流程
  if ((chatType === 'p2p' || chatType === 'direct') && (!mentions || mentions.length === 0)) {
    logger.info(`[hr_manage:create_staff] Private message from ${source}`);

    // 防护：确保 message 和 message.message 存在
    const userMessage = message?.message || '';
    const userId = source || 'unknown';

    const messageObj = await handlePrivateMessage(
      {
        message: userMessage,
        userId: userId,
      },
      redis,
      logger,
      instanceId
    );

    // 统一 publish 消息（如果 handlePrivateMessage 返回了消息对象）
    if (messageObj) {
      // 所有消息都通过 redis 发送，不通过 deliver
      await redis.publish('wegirl:replies', JSON.stringify(messageObj));
      console.log(`[hr_manage:create_staff] Message published to wegirl:replies, msgType=${messageObj.msgType}`);
    }

    // 返回 null，deliver 不会发送任何消息
    return null;
  }

  // 2. 群聊 @ 消息 → 判断是 agent 还是人类
  if (chatType === 'group' && mentions && mentions.length > 0) {
    logger.info(`[hr_manage:create_staff] Group mention message with ${mentions.length} mentions`);

    const results = [];
    const fromUser = message.source;
    const senderName = message.senderName || message.fromUserName || '';

    for (const mention of mentions) {
      const mentionKey = mention.key || mention;
      const mentionId = mention.id || mention;
      const mentionName = mention.name || mention;

      const context = {
        mentionKey,
        mentionId,
        mentionName,
        chatId: message.chatId,
        chatType: chatType,
        fromUser: fromUser,
        senderName: senderName,
      };

      await handleMentionMessage(context, redis, logger, instanceId);

      results.push({
        mention: mentionId || mentionKey,
        processed: true
      });
    }

    return {
      success: true,
      action: 'process_mentions',
      count: mentions.length,
      results: results,
      message: `群聊@消息已处理，共 ${mentions.length} 个提及`
    };
  }

  // 其他消息类型
  return {
    success: true,
    action: 'none',
    message: '消息无需特殊处理'
  };
}

// ============ 全局 Stream 消费者（单例模式）============

const KEY_PREFIX = 'wegirl:';
const GLOBAL_CONSUMER_GROUP = 'wegirl-global';

/**
 * 启动全局 Stream 消费者
 * 只有一个消费者实例，根据 target 分发消息到不同 agent
 */
async function startGlobalStreamConsumer(
  context: PluginContext,
  pluginConfig: any,
  instanceId: string
): Promise<void> {
  if (globalConsumerStarted) {
    context.logger.info('[WeGirl register] Global stream consumer already started');
    return;
  }
  globalConsumerStarted = true;

  const logger = context.logger;
  const config = pluginConfig || {};
  const db = config.redisDb ?? 1;
  const password = config.redisPassword;
  const url = config.redisUrl || 'redis://localhost:6379';
  const consumerName = `consumer-${instanceId}`;
  
  // 按实例分 Stream: wegirl:stream:global:{instanceId}
  const GLOBAL_STREAM_KEY = `${KEY_PREFIX}stream:global:${instanceId}`;

  logger.info(`[WeGirl register] Starting global stream consumer (instance: ${instanceId})`);

  const redisOptions: any = { db };
  if (password) redisOptions.password = password;

  // 创建两个 Redis 连接：一个用于消费，一个用于发布
  globalStreamClient = new Redis(url, redisOptions);
  globalPublisher = new Redis(url, redisOptions);

  // 等待连接就绪
  await Promise.all([
    new Promise<void>((resolve, reject) => {
      globalStreamClient!.once('ready', resolve);
      globalStreamClient!.once('error', (err) => reject(err));
      setTimeout(() => reject(new Error('streamClient connect timeout')), 10000);
    }),
    new Promise<void>((resolve, reject) => {
      globalPublisher!.once('ready', resolve);
      globalPublisher!.once('error', (err) => reject(err));
      setTimeout(() => reject(new Error('publisher connect timeout')), 10000);
    })
  ]);

  logger.info('[WeGirl register] Global stream Redis connections ready');

  // 创建消费者组（如果不存在）
  try {
    await globalStreamClient.xgroup('CREATE', GLOBAL_STREAM_KEY, GLOBAL_CONSUMER_GROUP, '$', 'MKSTREAM');
    logger.info(`[WeGirl register] Created global consumer group: ${GLOBAL_CONSUMER_GROUP}`);
  } catch (err: any) {
    if (!err.message?.includes('already exists')) {
      logger.error(`[WeGirl register] Failed to create global consumer group: ${err.message}`);
      throw err;
    }
    logger.info(`[WeGirl register] Global consumer group exists: ${GLOBAL_CONSUMER_GROUP}`);
  }

  // 消费循环
  let running = true;
  let consecutiveErrors = 0;
  const MAX_CONSECUTIVE_ERRORS = 10;

  const consumeStream = async () => {
    while (running) {
      try {
        // XREADGROUP: 从全局消费者组读取消息
        const results = await globalStreamClient!.xreadgroup(
          'GROUP', GLOBAL_CONSUMER_GROUP, consumerName,
          'COUNT', 1,
          'BLOCK', 5000,
          'STREAMS', GLOBAL_STREAM_KEY,
          '>'
        ) as any;

        consecutiveErrors = 0;

        if (!results || results.length === 0) continue;

        // 解析并分发消息
        for (const [, messages] of results) {
          for (const [messageId, fields] of messages) {
            try {
              const fieldMap: Record<string, string> = {};
              for (let i = 0; i < fields.length; i += 2) {
                fieldMap[fields[i]] = fields[i + 1];
              }

              if (fieldMap.data) {
                const data = JSON.parse(fieldMap.data);
                logger.info(`[WeGirl register] Received message from stream: target=${data.target}, flowType=${data.flowType}`);
                await dispatchMessageToAgent(data, context, logger, instanceId);
              }

              // ACK 消息
              await globalStreamClient!.xack(GLOBAL_STREAM_KEY, GLOBAL_CONSUMER_GROUP, messageId);
            } catch (err: any) {
              logger.error(`[WeGirl register] Failed to dispatch message ${messageId}:`, err.message);
              // 失败也要 ACK，避免无限重试
              try {
                await globalStreamClient!.xack(GLOBAL_STREAM_KEY, GLOBAL_CONSUMER_GROUP, messageId);
              } catch {}
            }
          }
        }
      } catch (err: any) {
        consecutiveErrors++;
        logger.error(`[WeGirl register] Global stream error (${consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS}):`, err.message);

        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          logger.error('[WeGirl register] Too many errors, stopping global consumer');
          break;
        }

        await new Promise(resolve => setTimeout(resolve, Math.min(consecutiveErrors * 1000, 10000)));
      }
    }
  };

  // 启动消费（不阻塞）
  consumeStream().catch(err => {
    logger.error('[WeGirl register] Global consumer crashed:', err.message);
  });

  logger.info('[WeGirl register] Global stream consumer started');
}

/**
 * 根据 target 分发消息到对应 agent
 * 直接调用 wegirlSessionsSend 发送消息
 */
async function dispatchMessageToAgent(
  data: any,
  context: PluginContext,
  logger: any,
  instanceId: string
): Promise<void> {
  const target = data.target;

  if (!target) {
    logger.warn('[WeGirl register] Message missing target:', data);
    return;
  }

  const routingId = data.routingId || `wegirl-${Date.now()}`;

  try {
    // 保存 routingId 到 Redis
    const sessionRoutingKey = `${KEY_PREFIX}session:${target}:routingId`;
    await globalPublisher!.setex(sessionRoutingKey, 3600, routingId);

    // 直接调用 wegirlSessionsSend 发送消息
    const fullCfg = getGlobalConfig() || {};
    await wegirlSessionsSend({
      message: data.message,
      source: data.source,
      target: data.target,
      chatType: data.chatType === 'group' ? 'group' : 'direct',
      groupId: data.groupId,
      routingId: routingId,
      taskId: data.taskId,
      stepId: data.stepId,
      stepTotalAgents: data.stepTotalAgents,
      msgType: data.msgType,
      payload: data.payload,
      metadata: data.metadata,
      replyTo: data.replyTo,
      fromType: 'outer',
      cfg: fullCfg,
      channel: 'wegirl',
      log: logger,
    });

    logger.info(`[WeGirl register] Message sent to ${target} via wegirlSessionsSend`);
  } catch (err: any) {
    logger.error(`[WeGirl register] Failed to dispatch to ${target}:`, err.message);
  }
}

/**
 * 查找或创建 agent 的 session
 */
async function findOrCreateAgentSession(
  agentId: string,
  runtime: any,
  logger: any
): Promise<string | null> {
  try {
    // 1. 尝试从 Redis 获取 agent 的 session key
    const sessionKey = await globalPublisher!.get(`${KEY_PREFIX}agent:${agentId}:session`);
    if (sessionKey) {
      // 验证 session 是否仍然有效
      const session = await runtime.getSession?.(sessionKey);
      if (session) {
        return sessionKey;
      }
    }

    // 2. 如果 agent 有绑定的 account，创建新 session
    // 这需要通过 runtime 创建新 session
    // 注意：这里简化处理，实际可能需要更复杂的逻辑
    logger.warn(`[WeGirl register] Agent ${agentId} has no active session, message will be queued`);
    return null;
  } catch (err: any) {
    logger.error(`[WeGirl register] Error finding session for ${agentId}:`, err.message);
    return null;
  }
}

// ============ Agent Session 管理 ============

export default plugin;

// 导出 accounts 相关函数供其他模块使用
export { getAccount, hasAccount, accountsCache };

// ============ 结果格式化 ============

/**
 * 格式化 hr_manage 结果为易读的回复消息
 */
function formatResultForReply(action: string, result: any): string {
  switch (action) {
    case 'list_staffs': {
      if (!result.success || !result.agents) {
        return `❌ 获取花名册失败: ${result.error || '未知错误'}`;
      }

      const agents = result.agents || [];
      if (agents.length === 0) {
        return '📋 团队花名册\n\n暂无成员';
      }

      const lines = ['📋 团队花名册', ''];
      agents.forEach((agent: any, index: number) => {
        const name = agent.name || agent.accountId || 'Unknown';
        const status = agent.status || 'unknown';
        const vibe = agent.personalityVibe || '-';
        const caps = (agent.capabilities || []).join(', ') || '-';
        lines.push(`${index + 1}. ${name} | ${status}`);
        lines.push(`   风格: ${vibe}`);
        if (caps !== '-') {
          lines.push(`   能力: ${caps}${agent.capabilityCount > 3 ? ` (+${agent.capabilityCount - 3})` : ''}`);
        }
        lines.push('');
      });

      lines.push(`共 ${agents.length} 位成员`);
      return lines.join('\n');
    }

    case 'get_staff': {
      if (!result.success || !result.agent) {
        return `❌ 获取员工信息失败: ${result.error || '未知错误'}`;
      }

      const agent = result.agent;
      const lines = ['👤 员工信息', ''];
      lines.push(`工号: ${agent.accountId}`);
      lines.push(`姓名: ${agent.name}`);
      lines.push(`状态: ${agent.status}`);
      if (agent.instanceId) lines.push(`实例: ${agent.instanceId}`);
      if (agent.capabilities?.length > 0) {
        lines.push(`能力: ${agent.capabilities.join(', ')}`);
      }
      return lines.join('\n');
    }

    case 'get_agent_profile': {
      if (!result.success || !result.agent) {
        return `❌ 获取档案失败: ${result.error || '未知错误'}`;
      }

      const agent = result.agent;
      const lines = ['📋 Agent 档案', ''];
      lines.push(`工号: ${agent.accountId}`);
      lines.push(`姓名: ${agent.name}`);
      lines.push(`状态: ${agent.status}`);
      if (agent.description) lines.push(`职责: ${agent.description}`);

      // 性格
      if (agent.personality && Object.keys(agent.personality).length > 0) {
        lines.push('');
        lines.push('🎭 性格:');
        const p = agent.personality;
        if (p.vibe) lines.push(`  风格: ${p.vibe}`);
        if (p.traits?.length > 0) lines.push(`  特质: ${p.traits.join(', ')}`);
        if (p.emoji) lines.push(`  表情: ${p.emoji}`);
        if (p.voice) lines.push(`  语音: ${p.voice}`);
        if (p.style) lines.push(`  沟通: ${p.style}`);
      }

      // 能力
      if (agent.capabilities?.length > 0) {
        lines.push('');
        lines.push('⚡ 能力:');
        agent.capabilities.forEach((cap: string, i: number) => {
          lines.push(`  ${i + 1}. ${cap}`);
        });
      }

      return lines.join('\n');
    }

    case 'update_agent_profile': {
      if (!result.success) {
        return `❌ 更新失败: ${result.error || '未知错误'}`;
      }
      return `✅ ${result.message}`;
    }

    case 'send_command': {
      if (!result.success) {
        return `❌ 命令发送失败: ${result.error || '未知错误'}`;
      }
      return `✅ ${result.message}`;
    }

    case 'create_agent': {
      if (!result.success) {
        return `❌ 创建 Agent 失败: ${result.error || '未知错误'}`;
      }

      const lines = ['🤖 Agent 创建结果', ''];
      lines.push(`名称: ${result.agentName}`);
      lines.push(`账号: ${result.accountId}`);
      lines.push(`工作目录: ${result.workspacePath}`);
      lines.push('');

      if (result.steps && result.steps.length > 0) {
        lines.push('执行步骤:');
        result.steps.forEach((step: any) => {
          const icon = step.status === 'success' ? '✅' : '❌';
          lines.push(`  ${icon} ${step.name}${step.message ? `: ${step.message}` : ''}`);
        });
      }

      return lines.join('\n');
    }

    default:
      return JSON.stringify(result, null, 2);
  }
}
