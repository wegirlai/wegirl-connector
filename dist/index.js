import Redis from 'ioredis';
import { randomUUID } from 'crypto';
import { wegirlPlugin } from './channel.js';
import { setWeGirlRuntime, setWeGirlConfig } from './runtime.js';
import { Registry } from './registry.js';
import { PendingQueue } from './queue.js';
import { MessageRouter } from './router.js';
import { WeGirlTools } from './tools.js';
import { registerEventHandlers } from './event-handlers.js';
import { handleMentionMessage, handlePrivateMessage } from './hr-message-handler.js';
import { wegirlSend } from './core/index.js'; // 新核心模块
import { initGlobalConfig, getGlobalConfig, getWeGirlPluginConfig } from './config.js';
let accountsCache = new Map();
/**
 * 从 Redis 加载所有 agents 和 humans 到 accounts
 */
async function loadAccountsFromRedis(redis, logger) {
    const KEY_PREFIX = 'wegirl:';
    const accounts = new Map();
    try {
        // 获取所有 staff keys
        const keys = await redis.keys(`${KEY_PREFIX}staff:*`);
        logger?.info?.(`[WeGirl] Loading accounts from Redis: found ${keys.length} staff keys`);
        for (const key of keys) {
            const staffId = key.toString().replace(`${KEY_PREFIX}staff:`, '');
            // 跳过特殊 keys
            if (staffId.includes(':') && !staffId.startsWith('source:'))
                continue;
            const data = await redis.hgetall(key);
            if (!data || Object.keys(data).length === 0)
                continue;
            // 将 Buffer 转换为字符串
            const getString = (val) => {
                if (!val)
                    return undefined;
                if (Buffer.isBuffer(val))
                    return val.toString('utf-8');
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
            }
            else if (type === 'human' || staffId.startsWith('source:')) {
                accounts.set(staffId, {
                    id: staffId,
                    name: name || staffId,
                    type: 'human',
                    status: status || 'active'
                });
            }
        }
        logger?.info?.(`[WeGirl] Loaded ${accounts.size} accounts into cache`);
    }
    catch (err) {
        logger?.error?.(`[WeGirl] Failed to load accounts from Redis:`, err.message);
    }
    return accounts;
}
/**
 * 获取 account 信息
 */
function getAccount(staffId) {
    return accountsCache.get(staffId);
}
/**
 * 检查 account 是否存在
 */
function hasAccount(staffId) {
    return accountsCache.has(staffId);
}
// 模块实例
let redisClient = null;
let redisConnectPromise = null;
let registry = null;
let pendingQueue = null;
let messageRouter = null;
let wegirlTools = null;
// 全局单例控制 - 确保只有一个 Stream 消费者
let globalConsumerStarted = false;
let globalStreamClient = null;
let globalPublisher = null;
// Agent 就绪状态映射 (accountId -> sessionKey)
const agentReadyMap = new Map();
const plugin = {
    id: 'wegirl',
    name: 'WeGirl',
    description: 'WeGirl Redis connector for OpenClaw - Multi-Agent orchestration hub',
    register(context) {
        const logger = context.logger;
        // 初始化全局配置（从文件加载）
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
            logger.info('[WeGirl] Runtime saved to global');
        }
        else {
            logger.error('[WeGirl] No runtime in context!');
        }
        // 保存 PluginConfig（用于兼容性）
        setWeGirlConfig(pluginConfig);
        logger.info('[WeGirl] PluginConfig saved to global');
        logger.info(`[WeGirl register] Redis config from openclaw.json: ${pluginConfig.redisUrl || 'not set'}`);
        // 初始化 Redis 连接
        async function initRedis() {
            if (redisConnectPromise)
                return redisConnectPromise;
            redisConnectPromise = (async () => {
                // 统一从 pluginConfig (openclaw.json 的 plugins.wegirl.config) 读取
                const config = pluginConfig || {};
                const db = config.redisDb ?? 1;
                const password = config.redisPassword;
                const url = config.redisUrl || 'redis://localhost:6379';
                logger.info(`[WeGirl register] Redis URL: ${url.replace(/:\/\/.*@/, '://***@')}, db: ${db}`);
                const redisOptions = {
                    db,
                    retryStrategy: (times) => {
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
                await new Promise((resolve, reject) => {
                    redisClient.once('ready', () => {
                        logger.info('[WeGirl] Redis 连接成功');
                        resolve();
                    });
                    redisClient.once('error', (err) => {
                        logger.error('[WeGirl] Redis 连接失败:', err.message);
                        reject(err);
                    });
                    // 超时处理
                    setTimeout(() => reject(new Error('Redis connect timeout')), 10000);
                });
                // 加载所有 agents 和 humans 到 accounts cache
                accountsCache = await loadAccountsFromRedis(redisClient, logger);
                // 注册 Agent 心跳（如果配置了 agentId）
                const agentId = config.agentId;
                if (agentId && redisClient) {
                    registry = new Registry(redisClient, INSTANCE_ID, logger);
                    await registry.register({
                        staffId: agentId,
                        type: 'agent',
                        name: config.agentName || agentId,
                        capabilities: config.capabilities || [],
                        maxConcurrent: config.maxConcurrent || 3,
                    });
                    logger.info(`[WeGirl register] Agent ${agentId} registered with heartbeat`);
                    // 启动心跳定时器
                    setInterval(async () => {
                        try {
                            await registry.heartbeat(agentId);
                        }
                        catch (err) {
                            logger.error(`[WeGirl register] Heartbeat error:`, err.message);
                        }
                    }, 30000);
                }
                // 初始化队列和路由器
                if (redisClient) {
                    pendingQueue = new PendingQueue(redisClient);
                    messageRouter = new MessageRouter(redisClient, INSTANCE_ID, logger, url, password);
                    wegirlTools = new WeGirlTools(redisClient, INSTANCE_ID, logger);
                    // 启动跨实例消息监听
                    await messageRouter.startListening();
                    logger.info('[WeGirl] Cross-instance message listener started');
                    // 同步 agents：清理 Redis 中不存在于本地的僵尸 agent
                    try {
                        const syncResult = await syncAgentsFromLocal(INSTANCE_ID, redisClient, logger);
                        logger.info(`[WeGirl register] Agent sync completed: ${syncResult.kept} kept, ${syncResult.removed} zombies removed`);
                    }
                    catch (syncErr) {
                        logger.error('[WeGirl] Agent sync failed:', syncErr.message);
                    }
                }
            })();
            return redisConnectPromise;
        }
        // 启动初始化（异步，不阻塞注册）
        initRedis().catch((err) => {
            logger.error('[WeGirl] Redis initialization failed:', err.message);
        });
        // 启动全局 Stream 消费者（单例模式）
        startGlobalStreamConsumer(context, pluginConfig, INSTANCE_ID).catch((err) => {
            logger.error('[WeGirl] Global stream consumer failed:', err.message);
        });
        // 注册 Channel（同步）
        if (typeof context.registerChannel === 'function') {
            context.registerChannel(wegirlPlugin);
            logger.info('[WeGirl] Channel registered');
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
                        }
                    },
                    required: ['flowType', 'source', 'target', 'message', 'replyTo', 'routingId']
                },
                execute: async (_toolCallId, params) => {
                    logger.info(`[wegirl_send] 调用: ${JSON.stringify(params)}`);
                    try {
                        const result = await wegirlSend(params, logger);
                        return {
                            success: result.success,
                            routingId: result.routingId,
                            local: result.local,
                            targetInstanceId: result.targetInstanceId,
                            error: result.error
                        };
                    }
                    catch (err) {
                        logger.error(`[wegirl_send] 失败:`, err.message);
                        return {
                            success: false,
                            error: err.message
                        };
                    }
                }
            });
            // HR Manage Tool - 仅限 HR Agent 使用
            context.registerTool({
                name: 'hr_manage',
                description: 'HR Agent 专用：处理新成员入职、查看团队花名册、查询员工信息。使用场景：1) 处理新员工入职使用 create_staff；2) 查看所有员工使用 list_staffs；3) 查询特定员工信息使用 get_staff；4) 同步本地信息到 Redis 使用 sync_agents_to_redis。',
                parameters: {
                    type: 'object',
                    properties: {
                        action: {
                            type: 'string',
                            enum: ['list_staffs', 'get_staff', 'sync_agents_to_redis', 'send_command', 'create_staff'],
                            description: '操作类型'
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
                        }
                    },
                    required: ['action']
                },
                execute: async (_toolCallId, params) => {
                    console.log(`[hr_manage] 被调用, params=${JSON.stringify(params)}`);
                    await initRedis();
                    if (!redisClient)
                        throw new Error('Redis not initialized');
                    const { action } = params;
                    const INSTANCE_ID = pluginConfig?.instanceId || 'instance-local';
                    let result;
                    switch (action) {
                        case 'create_staff': {
                            const { message, chatType, source, target, senderName, groupId, routingId } = params;
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
                            result = await handleProcessMessage(normalizedMessage, redisClient, logger, INSTANCE_ID);
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
                        case 'sync_agents_to_redis':
                            result = await handleSyncAgents(redisClient, logger);
                            break;
                        case 'send_command': {
                            const { command, payload: cmdPayload } = params;
                            if (!command) {
                                throw new Error('缺少必填参数: command');
                            }
                            result = await handleSendCommand({ command, payload: cmdPayload || {} }, redisClient, logger, INSTANCE_ID);
                            break;
                        }
                        default:
                            throw new Error(`未知操作: ${action}`);
                    }
                    logger.info(`[hr_manage] action=${action} 执行完成`);
                    // create_staff 已通过 redis 发送消息，返回 null 阻止 deliver
                    if (action === 'create_staff') {
                        return null;
                    }
                    // 返回 OpenClaw 期望的格式
                    return {
                        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
                        details: result
                    };
                }
            });
            logger.info('[WeGirl] Tools registered: wegirl_send, hr_manage');
        }
        else {
            logger.warn('[WeGirl] registerTool not available');
        }
        // TODO: default 消息处理通过 Stream 消费端实现
        // 当收到 target 为 default:{instance} 的消息时，
        // 在 messageRouter 中处理并调用 executeCreateAgent
        // 注册事件处理器 - 使用单独文件
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
                handler: async (req, res) => {
                    try {
                        const data = JSON.parse(req.body);
                        logger.info('[WeGirl] Webhook received:', JSON.stringify(data));
                        res.status(200).json({ success: true });
                    }
                    catch (err) {
                        logger.error('[WeGirl] Webhook error:', err.message);
                        res.status(500).json({ error: err.message });
                    }
                }
            });
            // 监控接口 - Stream 和 Consumer Group 状态
            context.registerHttpRoute({
                path: '/wegirl/metrics',
                method: 'GET',
                handler: async (_req, res) => {
                    try {
                        await initRedis();
                        if (!redisClient) {
                            return res.status(503).json({ error: 'Redis not connected' });
                        }
                        const KEY_PREFIX = 'wegirl:';
                        const instanceId = pluginConfig?.instanceId || 'instance-local';
                        const streamKey = `${KEY_PREFIX}stream:instance:${instanceId}`;
                        const consumerGroup = 'wegirl-consumers';
                        const metrics = {
                            timestamp: Date.now(),
                            instanceId,
                            streamKey,
                            consumerGroup
                        };
                        // 1. Stream 基本信息
                        try {
                            const streamInfo = await redisClient.xinfo('STREAM', streamKey);
                            const infoMap = {};
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
                        }
                        catch (err) {
                            if (err.message?.includes('no such key')) {
                                metrics.stream = { exists: false, length: 0 };
                            }
                            else {
                                metrics.stream = { error: err.message };
                            }
                        }
                        // 2. Consumer Group 信息
                        try {
                            const groupInfo = await redisClient.xinfo('GROUPS', streamKey);
                            const groups = [];
                            for (const group of groupInfo) {
                                const groupMap = {};
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
                        }
                        catch (err) {
                            if (err.message?.includes('no such key')) {
                                metrics.consumerGroups = [];
                            }
                            else {
                                metrics.consumerGroups = { error: err.message };
                            }
                        }
                        // 3. Pending 消息详情（如果组存在）
                        try {
                            const pending = await redisClient.xpending(streamKey, consumerGroup);
                            if (pending && Array.isArray(pending)) {
                                metrics.pending = {
                                    count: pending[0] || 0,
                                    minId: pending[1] || null,
                                    maxId: pending[2] || null
                                };
                                // 如果 pending 数量 > 0，获取详细列表
                                if (pending[0] > 0) {
                                    const pendingDetails = await redisClient.xpending(streamKey, consumerGroup, '-', '+', Math.min(pending[0], 10) // 最多返回 10 条
                                    );
                                    metrics.pending.details = pendingDetails.map((p) => ({
                                        messageId: p[0],
                                        consumer: p[1],
                                        idleTimeMs: p[2],
                                        deliveryCount: p[3]
                                    }));
                                }
                            }
                        }
                        catch (err) {
                            metrics.pending = { error: err.message };
                        }
                        // 4. 活跃 Agent 统计 (使用统一的 staff key)
                        try {
                            const staffKeys = await redisClient.keys(`${KEY_PREFIX}staff:*`);
                            const agentKeys = staffKeys.filter(k => !k.includes(':by-type:') && !k.includes(':capability:'));
                            const agentIds = [];
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
                        }
                        catch (err) {
                            metrics.agents = { error: err.message };
                        }
                        // 5. 能力索引统计
                        try {
                            const capabilityKeys = await redisClient.keys(`${KEY_PREFIX}capability:*`);
                            const capabilities = {};
                            for (const key of capabilityKeys) {
                                const cap = key.replace(`${KEY_PREFIX}capability:`, '');
                                const count = await redisClient.scard(key);
                                capabilities[cap] = count;
                            }
                            metrics.capabilities = capabilities;
                        }
                        catch (err) {
                            metrics.capabilities = { error: err.message };
                        }
                        res.status(200).json(metrics);
                    }
                    catch (err) {
                        logger.error('[WeGirl] Metrics error:', err.message);
                        res.status(500).json({ error: err.message });
                    }
                }
            });
            // 健康检查端点
            context.registerHttpRoute({
                path: '/wegirl/health',
                method: 'GET',
                handler: async (_req, res) => {
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
                    }
                    catch (err) {
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
        logger.info('[WeGirl] Plugin registered successfully');
    },
};
// ============ HR Manage Tool Handlers ============
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
// 获取 OpenClaw 配置路径（支持环境变量或默认用户目录）
function getOpenClawConfigPath() {
    if (process.env.OPENCLAW_CONFIG_PATH) {
        return process.env.OPENCLAW_CONFIG_PATH;
    }
    const homeDir = process.env.OPENCLAW_HOME || os.homedir();
    return path.join(homeDir, '.openclaw', 'openclaw.json');
}
// 获取 OpenClaw 主目录
function getOpenClawHome() {
    return process.env.OPENCLAW_HOME || path.join(os.homedir(), '.openclaw');
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
async function handleListAgents(redis, logger) {
    logger.info('[hr_manage] Listing all agents');
    const KEY_PREFIX = 'wegirl:';
    // 获取所有 staff，过滤出 agent 类型
    const keys = await redis.keys(`${KEY_PREFIX}staff:*`);
    const staffKeys = keys.filter(k => !k.includes(':by-type:') && !k.includes(':capability:'));
    const agents = await Promise.all(staffKeys.map(async (key) => {
        const data = await redis.hgetall(key);
        // 只返回 agent 类型
        if (data.type !== 'agent')
            return null;
        return {
            accountId: data.staffId,
            name: data.name,
            type: data.type,
            role: data.role || '-',
            instanceId: data.instanceId,
            status: data.status,
            capabilities: data.capabilities?.split(',') || [],
            lastHeartbeat: data.lastHeartbeat
        };
    }));
    return {
        success: true,
        count: agents.filter(a => a !== null).length,
        agents: agents.filter(a => a !== null)
    };
}
/**
 * 获取单个 Agent 信息 (使用统一的 staff key)
 */
async function handleGetAgent(args, redis, logger) {
    const { accountId } = args;
    logger.info(`[hr_manage] Getting agent: ${accountId}`);
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
 * 删除 Agent（仅 Redis 注册信息）- 使用统一的 staff key
 */
async function handleDeleteAgent(args, redis, logger) {
    const { accountId } = args;
    logger.info(`[hr_manage] Deleting agent: ${accountId}`);
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
    logger.info(`[hr_manage] Agent ${accountId} deleted from Redis`);
    return {
        success: true,
        message: `Agent ${accountId} deleted from Redis (注：OpenClaw agent 文件未删除，请手动执行: openclaw agents remove ${data.name?.replace(' Notifier', '').toLowerCase()})`
    };
}
/**
 * 从 openclaw.json 读取 instanceId
 */
function getInstanceIdFromConfig(logger) {
    try {
        const configPath = getOpenClawConfigPath();
        const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        const instanceId = config.plugins?.wegirl?.config?.instanceId || 'instance-local';
        logger?.info?.(`[hr_manage] Got instanceId from openclaw.json: ${instanceId}`);
        return instanceId;
    }
    catch (err) {
        logger?.error?.(`[hr_manage] Failed to read instanceId from config: ${err.message}`);
        return 'instance-local';
    }
}
/**
 * 手动同步所有本地 Agents 到 Redis
 */
async function handleSyncAgents(redis, logger) {
    const INSTANCE_ID = getInstanceIdFromConfig(logger);
    logger.info(`[hr_manage] Starting manual agent sync to Redis for instance: ${INSTANCE_ID}`);
    try {
        const result = await syncAgentsFromLocal(INSTANCE_ID, redis, logger);
        return {
            success: true,
            message: `同步完成: ${result.kept} 个保持, ${result.removed} 个清理, 新增 ${result.registered || 0} 个`,
            details: result
        };
    }
    catch (err) {
        logger.error('[hr_manage] Sync failed:', err.message);
        return {
            success: false,
            message: `同步失败: ${err.message}`
        };
    }
}
// 获取本地所有 agents（从配置文件读取）
async function getLocalAgents(logger) {
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
            .filter((a) => a != null) // 过滤掉 null/undefined
            .map((a) => ({
            name: a.name || a.id,
            id: a.id
        }));
    }
    catch (err) {
        logger.error(`[sync] Failed to read local agents: ${err.message}`);
        return [];
    }
}
// 从 Redis 清理单个 agent (使用统一的 staff key)
async function cleanupAgentFromRedis(accountId, instanceId, redis, logger) {
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
async function syncAgentsFromLocal(instanceId, redis, logger) {
    const KEY_PREFIX = 'wegirl:';
    logger.info(`[sync] Starting agent sync for instance: ${instanceId}`);
    // 1. 获取本地所有 agents
    const localAgents = await getLocalAgents(logger);
    logger.info(`[sync] Found ${localAgents.length} local agents`);
    // 2. 获取 Redis 中该实例的所有 staff (agent 类型)
    const redisStaffIds = await redis.smembers(`${KEY_PREFIX}instance:${instanceId}:staff`);
    // 过滤出 agent 类型的 staff
    const redisAgentIds = [];
    for (const staffId of redisStaffIds) {
        const data = await redis.hgetall(`${KEY_PREFIX}staff:${staffId}`);
        if (data.type === 'agent') {
            redisAgentIds.push(staffId);
        }
    }
    logger.info(`[sync] Found ${redisAgentIds.length} agents in Redis`);
    const toKeep = [];
    const toRemove = [];
    const toRegister = [];
    // 检查 Redis 中的 agents：保留存在的，清理僵尸
    for (const accountId of redisAgentIds) {
        const staffData = await redis.hgetall(`${KEY_PREFIX}staff:${accountId}`);
        const agentName = staffData.name?.replace(' Notifier', '').toLowerCase();
        // 检查本地是否存在
        const existsLocally = localAgents?.some(a => a?.name?.toLowerCase() === agentName || a?.id === accountId) || false;
        if (existsLocally) {
            toKeep.push(accountId);
            // 更新心跳
            await redis.hset(`${KEY_PREFIX}staff:${accountId}`, {
                lastHeartbeat: Date.now().toString(),
                status: 'online'
            });
        }
        else {
            // 僵尸 agent：本地已不存在，需要清理
            toRemove.push(accountId);
        }
    }
    // 检查本地 agents：注册 Redis 中不存在的
    for (const localAgent of (localAgents || [])) {
        if (!localAgent?.name)
            continue;
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
/**
 * 发送 HR 命令到 wegirl:replies channel
 * wegirl-service 会根据消息类型处理这些命令
 */
async function handleSendCommand(args, redis, logger, instanceId) {
    const { command, payload } = args;
    logger.info(`[hr_manage:send_command] Sending command: ${command}`);
    // 构建消息 - 使用标准 V2 格式
    const routingId = randomUUID();
    const message = {
        flowType: 'A2A',
        source: 'hr',
        target: payload?.agentId || 'default',
        message: command,
        chatType: 'direct',
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
    }
    catch (err) {
        logger.error(`[hr_manage:send_command] Failed to send command: ${err.message}`);
        throw new Error(`发送命令失败: ${err.message}`);
    }
}
/**
 * 处理入职消息
 * 根据消息类型（私聊/群聊@）判断并发送相应命令
 */
async function handleProcessMessage(message, redis, logger, instanceId) {
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
        const messageObj = await handlePrivateMessage({
            message: userMessage,
            userId: userId,
        }, redis, logger, instanceId);
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
const GLOBAL_STREAM_KEY = `${KEY_PREFIX}stream:global`;
const GLOBAL_CONSUMER_GROUP = 'wegirl-global';
/**
 * 启动全局 Stream 消费者
 * 只有一个消费者实例，根据 target 分发消息到不同 agent
 */
async function startGlobalStreamConsumer(context, pluginConfig, instanceId) {
    if (globalConsumerStarted) {
        context.logger.info('[WeGirl] Global stream consumer already started');
        return;
    }
    globalConsumerStarted = true;
    const logger = context.logger;
    const config = pluginConfig || {};
    const db = config.redisDb ?? 1;
    const password = config.redisPassword;
    const url = config.redisUrl || 'redis://localhost:6379';
    const consumerName = `consumer-${instanceId}`;
    logger.info(`[WeGirl register] Starting global stream consumer (instance: ${instanceId})`);
    const redisOptions = { db };
    if (password)
        redisOptions.password = password;
    // 创建两个 Redis 连接：一个用于消费，一个用于发布
    globalStreamClient = new Redis(url, redisOptions);
    globalPublisher = new Redis(url, redisOptions);
    // 等待连接就绪
    await Promise.all([
        new Promise((resolve, reject) => {
            globalStreamClient.once('ready', resolve);
            globalStreamClient.once('error', (err) => reject(err));
            setTimeout(() => reject(new Error('streamClient connect timeout')), 10000);
        }),
        new Promise((resolve, reject) => {
            globalPublisher.once('ready', resolve);
            globalPublisher.once('error', (err) => reject(err));
            setTimeout(() => reject(new Error('publisher connect timeout')), 10000);
        })
    ]);
    logger.info('[WeGirl] Global stream Redis connections ready');
    // 创建消费者组（如果不存在）
    try {
        await globalStreamClient.xgroup('CREATE', GLOBAL_STREAM_KEY, GLOBAL_CONSUMER_GROUP, '$', 'MKSTREAM');
        logger.info(`[WeGirl register] Created global consumer group: ${GLOBAL_CONSUMER_GROUP}`);
    }
    catch (err) {
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
                const results = await globalStreamClient.xreadgroup('GROUP', GLOBAL_CONSUMER_GROUP, consumerName, 'COUNT', 1, 'BLOCK', 5000, 'STREAMS', GLOBAL_STREAM_KEY, '>');
                consecutiveErrors = 0;
                if (!results || results.length === 0)
                    continue;
                // 解析并分发消息
                for (const [, messages] of results) {
                    for (const [messageId, fields] of messages) {
                        try {
                            const fieldMap = {};
                            for (let i = 0; i < fields.length; i += 2) {
                                fieldMap[fields[i]] = fields[i + 1];
                            }
                            if (fieldMap.data) {
                                const data = JSON.parse(fieldMap.data);
                                await dispatchMessageToAgent(data, context, logger, instanceId);
                            }
                            // ACK 消息
                            await globalStreamClient.xack(GLOBAL_STREAM_KEY, GLOBAL_CONSUMER_GROUP, messageId);
                        }
                        catch (err) {
                            logger.error(`[WeGirl register] Failed to dispatch message ${messageId}:`, err.message);
                            // 失败也要 ACK，避免无限重试
                            try {
                                await globalStreamClient.xack(GLOBAL_STREAM_KEY, GLOBAL_CONSUMER_GROUP, messageId);
                            }
                            catch { }
                        }
                    }
                }
            }
            catch (err) {
                consecutiveErrors++;
                logger.error(`[WeGirl register] Global stream error (${consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS}):`, err.message);
                if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
                    logger.error('[WeGirl] Too many errors, stopping global consumer');
                    break;
                }
                await new Promise(resolve => setTimeout(resolve, Math.min(consecutiveErrors * 1000, 10000)));
            }
        }
    };
    // 启动消费（不阻塞）
    consumeStream().catch(err => {
        logger.error('[WeGirl] Global consumer crashed:', err.message);
    });
    logger.info('[WeGirl] Global stream consumer started');
}
/**
 * 根据 target 分发消息到对应 agent
 */
async function dispatchMessageToAgent(data, context, logger, instanceId) {
    const target = data.target;
    if (!target) {
        logger.warn('[WeGirl] Message missing target:', data);
        return;
    }
    logger.info(`[WeGirl register] Message for ${target} will be consumed by target agent directly`);
    // 只保存 routingId 到 Redis，不做转发
    // 每个 agent 直接从全局 Stream 消费并过滤
    const routingId = data.routingId || `wegirl-${Date.now()}`;
    try {
        const sessionRoutingKey = `${KEY_PREFIX}session:${target}:routingId`;
        await globalPublisher.setex(sessionRoutingKey, 3600, routingId);
    }
    catch (err) {
        logger.warn(`[WeGirl register] Failed to save routingId:`, err.message);
    }
}
/**
 * 查找或创建 agent 的 session
 */
async function findOrCreateAgentSession(agentId, runtime, logger) {
    try {
        // 1. 尝试从 Redis 获取 agent 的 session key
        const sessionKey = await globalPublisher.get(`${KEY_PREFIX}agent:${agentId}:session`);
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
    }
    catch (err) {
        logger.error(`[WeGirl register] Error finding session for ${agentId}:`, err.message);
        return null;
    }
}
// ============ Agent Session 管理 ============
/**
 * 注册 agent 就绪状态
 * 由 channel.ts 的 startAccount 调用
 */
export function registerAgentReady(accountId, sessionKey, logger) {
    agentReadyMap.set(accountId, sessionKey);
    logger?.info?.(`[WeGirl] Agent ${accountId} registered with session ${sessionKey}`);
}
/**
 * 注销 agent 就绪状态
 * 由 channel.ts 的 stopAccount 调用
 */
export function unregisterAgentReady(accountId, logger) {
    agentReadyMap.delete(accountId);
    logger?.info?.(`[WeGirl] Agent ${accountId} unregistered`);
}
/**
 * 获取 agent 的 session key
 */
export function getAgentSessionKey(accountId) {
    return agentReadyMap.get(accountId);
}
export default plugin;
// 导出 accounts 相关函数供其他模块使用
export { getAccount, hasAccount, accountsCache };
//# sourceMappingURL=index.js.map