import Redis from 'ioredis';
import { wegirlPlugin } from './channel.js';
import { setWeGirlRuntime } from './runtime.js';
import { Registry } from './registry.js';
import { PendingQueue } from './queue.js';
import { MessageRouter } from './router.js';
import { WeGirlTools } from './tools.js';
import { registerEventHandlers } from './event-handlers.js';
import { executeCreateAgent } from './hr-manage-core.js';
// 模块实例
let redisClient = null;
let redisConnectPromise = null;
let registry = null;
let pendingQueue = null;
let messageRouter = null;
let wegirlTools = null;
const plugin = {
    id: 'wegirl',
    name: 'WeGirl',
    description: 'WeGirl Redis connector for OpenClaw - Multi-Agent orchestration hub',
    register(context) {
        const logger = context.logger;
        const pluginConfig = context.pluginConfig;
        // 实例ID（从配置、环境变量或默认值）
        const INSTANCE_ID = pluginConfig?.instanceId || process.env.OPENCLAW_INSTANCE_ID || 'instance-local';
        logger.info(`[WeGirl] Plugin registering... (Instance: ${INSTANCE_ID})`);
        // 保存 PluginRuntime
        if (context.runtime) {
            setWeGirlRuntime(context.runtime);
            logger.info('[WeGirl] Runtime saved to global');
            logger.info(`[WeGirl] Runtime type: ${typeof context.runtime}`);
            logger.info(`[WeGirl] Runtime methods: ${Object.keys(context.runtime).join(', ')}`);
        }
        else {
            logger.error('[WeGirl] No runtime in context!');
        }
        // 初始化 Redis 连接
        async function initRedis() {
            if (redisConnectPromise)
                return redisConnectPromise;
            redisConnectPromise = (async () => {
                // 优先从环境变量读取，其次 pluginConfig，最后默认值
                const config = pluginConfig || {};
                const db = (parseInt(process.env.REDIS_DB || '') || config.redisDb) ?? 1;
                const password = process.env.REDIS_PASSWORD || config.redisPassword;
                // 构建 Redis URL：优先使用环境变量或完整配置
                let url;
                if (process.env.REDIS_URL) {
                    url = process.env.REDIS_URL;
                }
                else if (process.env.REDIS_HOST) {
                    const host = process.env.REDIS_HOST;
                    const port = process.env.REDIS_PORT || '6379';
                    url = `redis://${host}:${port}`;
                }
                else {
                    url = config.redisUrl || 'redis://localhost:6379';
                }
                logger.info(`[WeGirl] Redis URL: ${url.replace(/:\/\/.*@/, '://***@')}, db: ${db}`);
                const redisOptions = {
                    db,
                    retryStrategy: (times) => {
                        if (times > 10) {
                            logger.error(`[WeGirl] Redis 重试次数(${times})超过限制`);
                            return null; // 停止重连
                        }
                        const delay = Math.min(Math.pow(2, times) * 50, 3000);
                        logger.warn(`[WeGirl] Redis 第 ${times} 次重连，${delay}ms 后尝试`);
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
                    logger.info(`[WeGirl] Agent ${agentId} registered with heartbeat`);
                    // 启动心跳定时器
                    setInterval(async () => {
                        try {
                            await registry.heartbeat(agentId);
                        }
                        catch (err) {
                            logger.error(`[WeGirl] Heartbeat error:`, err.message);
                        }
                    }, 30000);
                }
                // 初始化队列和路由器
                if (redisClient) {
                    pendingQueue = new PendingQueue(redisClient);
                    messageRouter = new MessageRouter(redisClient, INSTANCE_ID, logger);
                    wegirlTools = new WeGirlTools(redisClient, INSTANCE_ID, logger);
                    // 启动跨实例消息监听
                    await messageRouter.startListening();
                    logger.info('[WeGirl] Cross-instance message listener started');
                    // 同步 agents：清理 Redis 中不存在于本地的僵尸 agent
                    try {
                        const syncResult = await syncAgentsFromLocal(INSTANCE_ID, redisClient, logger);
                        logger.info(`[WeGirl] Agent sync completed: ${syncResult.kept} kept, ${syncResult.removed} zombies removed`);
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
        // 注册 Channel（同步）
        if (typeof context.registerChannel === 'function') {
            context.registerChannel(wegirlPlugin);
            logger.info('[WeGirl] Channel registered');
        }
        // 注册 Tools（异步初始化后可用）
        if (typeof context.registerTool === 'function') {
            context.registerTool({
                name: 'wegirl_send',
                description: 'Send message through WeGirl hub to other agents or humans',
                parameters: {
                    type: 'object',
                    properties: {
                        target: {
                            type: 'string',
                            description: 'Target address, e.g., "default", "scout", "ou_xxx" (human user)'
                        },
                        message: {
                            type: 'string',
                            description: 'Message content to send'
                        }
                    },
                    required: ['target', 'message']
                },
                execute: async (_toolCallId, params) => {
                    // 使用 console.log 确保日志输出（logger 可能在此上下文中不可用）
                    console.log(`[WeGirl] ========== wegirl_send execute ==========`);
                    console.log(`[WeGirl] _toolCallId:`, _toolCallId);
                    console.log(`[WeGirl] params:`, JSON.stringify(params, null, 2));
                    await initRedis();
                    if (!wegirlTools)
                        throw new Error('WeGirl not initialized');
                    return wegirlTools.send(params);
                }
            });
            // HR Manage Tool - 仅限 HR Agent 使用
            context.registerTool({
                name: 'hr_manage',
                description: 'HR Agent 专用：创建和管理 OpenClaw Agents，以及同步 agents 到 Redis。使用场景：1) 创建新 agent 时使用 create_agent；2) 查看所有 agents 使用 list_agents；3) 同步本地 agents 到 Redis 使用 sync_agents_to_redis。agent名称只能是英文字母、数字、横线(-)和下划线(_)。',
                parameters: {
                    type: 'object',
                    properties: {
                        action: {
                            type: 'string',
                            enum: ['create_agent', 'list_agents', 'get_agent', 'delete_agent', 'sync_agents_to_redis'],
                            description: '操作类型'
                        },
                        agentName: {
                            type: 'string',
                            description: 'Agent 名称（如：sales, marketing, support）。只能包含英文字母、数字、横线(-)和下划线(_)'
                        },
                        accountId: {
                            type: 'string',
                            description: 'WeGirl account ID（如：sales）。默认值为 {agentName}'
                        },
                        instanceId: {
                            type: 'string',
                            description: '实例 ID。默认值为 HR 所在实例',
                        },
                        capabilities: {
                            type: 'array',
                            items: { type: 'string' },
                            description: 'Agent 能力列表',
                            default: []
                        },
                        role: {
                            type: 'string',
                            description: '职能/角色（如：销售专员、技术支持）',
                            default: '-'
                        }
                    },
                    required: ['action']
                },
                execute: async (_toolCallId, params) => {
                    logger.info(`[hr_manage] 被调用, params=`, JSON.stringify(params));
                    await initRedis();
                    if (!redisClient)
                        throw new Error('Redis not initialized');
                    const { action } = params;
                    const INSTANCE_ID = pluginConfig?.instanceId || process.env.OPENCLAW_INSTANCE_ID || 'instance-local';
                    let result;
                    switch (action) {
                        case 'create_agent': {
                            // 参数处理与验证
                            let { agentName, accountId, instanceId, capabilities, role } = params;
                            // agentName 必填
                            if (!agentName) {
                                throw new Error('缺少必填参数: agentName');
                            }
                            // 验证 agentName: 只允许英文字母、数字、-、_
                            const validNameRegex = /^[a-zA-Z0-9_-]+$/;
                            if (!validNameRegex.test(agentName)) {
                                throw new Error('agentName 只能包含英文字母、数字、横线(-)和下划线(_)');
                            }
                            // 默认值处理
                            // instanceId 默认为当前实例（HR 所在实例）
                            instanceId = instanceId || INSTANCE_ID;
                            // accountId 默认为 {agentName}
                            accountId = accountId || `${agentName}`;
                            // role 默认为 '-'
                            role = role || '-';
                            result = await executeCreateAgent({
                                agentName,
                                accountId,
                                instanceId,
                                capabilities: capabilities || [],
                                role
                            }, {
                                instanceId: INSTANCE_ID,
                                logger,
                                redis: redisClient
                            });
                            break;
                        }
                        case 'list_agents':
                            result = await handleListAgents(redisClient, logger);
                            break;
                        case 'get_agent':
                            result = await handleGetAgent(params, redisClient, logger);
                            break;
                        case 'delete_agent':
                            result = await handleDeleteAgent(params, redisClient, logger);
                            break;
                        case 'sync_agents_to_redis':
                            result = await handleSyncAgents(redisClient, logger);
                            break;
                        default:
                            throw new Error(`未知操作: ${action}`);
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
                        const instanceId = pluginConfig?.instanceId || process.env.OPENCLAW_INSTANCE_ID || 'instance-local';
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
                            instanceId: pluginConfig?.instanceId || process.env.OPENCLAW_INSTANCE_ID || 'instance-local',
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
 * 手动同步所有本地 Agents 到 Redis
 */
async function handleSyncAgents(redis, logger) {
    const INSTANCE_ID = process.env.OPENCLAW_INSTANCE_ID || 'instance-local';
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
        return agents.map((a) => ({
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
    for (const localAgent of localAgents || []) {
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
export default plugin;
//# sourceMappingURL=index.js.map