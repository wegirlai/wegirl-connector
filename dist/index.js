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
                const config = pluginConfig || {};
                const db = config.redisDb ?? 0;
                const url = config.redisUrl || 'redis://localhost:6379';
                logger.info(`[WeGirl] Redis URL: ${url}, db: ${db}`);
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
                if (config.redisPassword) {
                    redisOptions.password = config.redisPassword;
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
                        agentId,
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
                description: 'Send message through WeGirl hub',
                parameters: {
                    type: 'object',
                    properties: {
                        target: { type: 'string' },
                        message: { type: 'string' }
                    }
                },
                handler: async (args) => {
                    await initRedis();
                    if (!wegirlTools)
                        throw new Error('WeGirl not initialized');
                    return wegirlTools.send(args);
                }
            });
            // HR Manage Tool - 仅限 HR Agent 使用
            context.registerTool({
                name: 'hr_manage',
                description: 'HR Agent 专用：创建和管理 OpenClaw Agents。使用场景：当用户需要创建新 agent 时，询问 agent名称即可调用。agent名称只能是英文字母、数字、横线(-)和下划线(_)，accountId 默认为 {agentName}-notifier，instanceId 默认为当前 HR 实例。',
                parameters: {
                    type: 'object',
                    properties: {
                        action: {
                            type: 'string',
                            enum: ['create_agent', 'list_agents', 'get_agent', 'delete_agent'],
                            description: '操作类型'
                        },
                        agentName: {
                            type: 'string',
                            description: 'Agent 名称（如：sales, marketing, support）。只能包含英文字母、数字、横线(-)和下划线(_)'
                        },
                        accountId: {
                            type: 'string',
                            description: 'WeGirl account ID（如：sales-notifier）。默认值为 {agentName}-notifier'
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
                handler: async (args, ctx) => {
                    // 权限检查：仅限 HR Agent
                    const agentId = ctx?.agentId || ctx?.session?.agentId;
                    if (agentId !== 'hr') {
                        throw new Error('此工具仅限 HR Agent 使用');
                    }
                    await initRedis();
                    if (!redisClient)
                        throw new Error('Redis not initialized');
                    const { action } = args;
                    const INSTANCE_ID = pluginConfig?.instanceId || process.env.OPENCLAW_INSTANCE_ID || 'instance-local';
                    switch (action) {
                        case 'create_agent': {
                            // 参数处理与验证
                            let { agentName, accountId, instanceId, capabilities, role } = args;
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
                            // accountId 默认为 {agentName}-notifier
                            accountId = accountId || `${agentName}-notifier`;
                            // role 默认为 '-'
                            role = role || '-';
                            return executeCreateAgent({
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
                        }
                        case 'list_agents':
                            return handleListAgents(redisClient, logger);
                        case 'get_agent':
                            return handleGetAgent(args, redisClient, logger);
                        case 'delete_agent':
                            return handleDeleteAgent(args, redisClient, logger);
                        default:
                            throw new Error(`未知操作: ${action}`);
                    }
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
                        // 4. 活跃 Agent 统计
                        try {
                            const agentKeys = await redisClient.keys(`${KEY_PREFIX}agents:*`);
                            metrics.agents = {
                                total: agentKeys.length,
                                list: agentKeys.map(k => k.replace(`${KEY_PREFIX}agents:`, ''))
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
 * 列出所有 Agents
 */
async function handleListAgents(redis, logger) {
    logger.info('[hr_manage] Listing all agents');
    const KEY_PREFIX = 'wegirl:';
    const keys = await redis.keys(`${KEY_PREFIX}agents:*`);
    const agents = await Promise.all(keys.map(async (key) => {
        const data = await redis.hgetall(key);
        const type = data.type || 'agent';
        const lastHeartbeat = parseInt(data.lastHeartbeat || '0');
        const now = Date.now();
        const heartbeatAge = now - lastHeartbeat;
        const isOnline = data.status === 'online' && heartbeatAge < 120000; // 2分钟内有心跳视为在线
        return {
            accountId: data.agentId,
            name: data.name,
            type: type,
            role: data.role || '-', // 职能/角色
            instanceId: data.instanceId,
            status: isOnline ? 'online' : 'offline',
            capabilities: data.capabilities?.split(',').filter(Boolean) || [],
            lastHeartbeat: lastHeartbeat,
            heartbeatAge: heartbeatAge,
            load: {
                active: parseInt(data['load:activeTasks'] || '0'),
                pending: parseInt(data['load:pendingTasks'] || '0')
            }
        };
    }));
    // 过滤掉无效的，并按状态排序（在线在前）
    const validAgents = agents
        .filter(a => a.accountId)
        .sort((a, b) => {
        if (a.status === b.status)
            return a.name.localeCompare(b.name);
        return a.status === 'online' ? -1 : 1;
    });
    // 统计信息
    const stats = {
        total: validAgents.length,
        online: validAgents.filter(a => a.status === 'online').length,
        offline: validAgents.filter(a => a.status === 'offline').length,
        byInstance: {}
    };
    validAgents.forEach(a => {
        stats.byInstance[a.instanceId] = (stats.byInstance[a.instanceId] || 0) + 1;
    });
    return {
        success: true,
        timestamp: Date.now(),
        stats: stats,
        agents: validAgents
    };
}
/**
 * 获取单个 Agent 信息
 */
async function handleGetAgent(args, redis, logger) {
    const { accountId } = args;
    logger.info(`[hr_manage] Getting agent: ${accountId}`);
    const KEY_PREFIX = 'wegirl:';
    const data = await redis.hgetall(`${KEY_PREFIX}agents:${accountId}`);
    if (!data.agentId) {
        return { success: false, error: `Agent not found: ${accountId}` };
    }
    return {
        success: true,
        agent: {
            accountId: data.agentId,
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
 * 删除 Agent（仅 Redis 注册信息）
 */
async function handleDeleteAgent(args, redis, logger) {
    const { accountId } = args;
    logger.info(`[hr_manage] Deleting agent: ${accountId}`);
    const KEY_PREFIX = 'wegirl:';
    // 获取 agent 信息
    const data = await redis.hgetall(`${KEY_PREFIX}agents:${accountId}`);
    if (!data.agentId) {
        return { success: false, error: `Agent not found: ${accountId}` };
    }
    const capabilities = data.capabilities?.split(',') || [];
    const instanceId = data.instanceId;
    // 删除能力索引
    for (const cap of capabilities) {
        await redis.srem(`${KEY_PREFIX}capability:${cap}`, accountId);
    }
    // 从实例集合移除
    await redis.srem(`${KEY_PREFIX}instance:${instanceId}:agents`, accountId);
    // 删除 agent 信息
    await redis.del(`${KEY_PREFIX}agents:${accountId}`);
    logger.info(`[hr_manage] Agent ${accountId} deleted from Redis`);
    return {
        success: true,
        message: `Agent ${accountId} deleted from Redis (注：OpenClaw agent 文件未删除，请手动执行: openclaw agents remove ${data.name?.replace(' Notifier', '').toLowerCase()})`
    };
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
// 从 Redis 清理单个 agent
async function cleanupAgentFromRedis(accountId, instanceId, redis, logger) {
    const KEY_PREFIX = 'wegirl:';
    const agentData = await redis.hgetall(`${KEY_PREFIX}agents:${accountId}`);
    const capabilities = agentData.capabilities?.split(',') || [];
    // 删除能力索引
    for (const cap of capabilities) {
        await redis.srem(`${KEY_PREFIX}capability:${cap}`, accountId);
    }
    // 从实例集合移除
    await redis.srem(`${KEY_PREFIX}instance:${instanceId}:agents`, accountId);
    // 删除 agent 信息
    await redis.del(`${KEY_PREFIX}agents:${accountId}`);
    logger.info(`[sync] Cleaned up zombie agent: ${accountId}`);
}
// 同步 agents：注册本地 agents，清理僵尸 agents
async function syncAgentsFromLocal(instanceId, redis, logger) {
    const KEY_PREFIX = 'wegirl:';
    logger.info(`[sync] Starting agent sync for instance: ${instanceId}`);
    // 1. 获取本地所有 agents
    const localAgents = await getLocalAgents(logger);
    logger.info(`[sync] Found ${localAgents.length} local agents`);
    // 2. 获取 Redis 中该实例的所有 agents
    const redisAgentIds = await redis.smembers(`${KEY_PREFIX}instance:${instanceId}:agents`);
    logger.info(`[sync] Found ${redisAgentIds.length} agents in Redis`);
    const toKeep = [];
    const toRemove = [];
    const toRegister = [];
    // 检查 Redis 中的 agents：保留存在的，清理僵尸
    for (const accountId of redisAgentIds) {
        const agentData = await redis.hgetall(`${KEY_PREFIX}agents:${accountId}`);
        const agentName = agentData.name?.replace(' Notifier', '').toLowerCase();
        // 检查本地是否存在
        const existsLocally = localAgents.some(a => a.name.toLowerCase() === agentName || a.id === accountId);
        if (existsLocally) {
            toKeep.push(accountId);
            // 更新心跳
            await redis.hset(`${KEY_PREFIX}agents:${accountId}`, {
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
    for (const localAgent of localAgents) {
        const accountId = `${localAgent.name}-notifier`;
        if (!redisAgentIds.includes(accountId)) {
            toRegister.push(localAgent);
        }
    }
    // 3. 注册新 agents
    for (const agent of toRegister) {
        const accountId = `${agent.name}-notifier`;
        const agentCapabilities = [agent.name];
        await redis.hset(`${KEY_PREFIX}agents:${accountId}`, {
            agentId: accountId,
            instanceId: instanceId,
            type: 'agent',
            role: '-', // 默认职能为空
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
        // 添加到实例集合
        await redis.sadd(`${KEY_PREFIX}instance:${instanceId}:agents`, accountId);
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
        removedIds: toRemove
    };
}
export default plugin;
//# sourceMappingURL=index.js.map