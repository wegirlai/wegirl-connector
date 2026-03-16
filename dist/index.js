import Redis from 'ioredis';
import { wegirlPlugin } from './channel.js';
import { setWeGirlRuntime } from './runtime.js';
import { Registry } from './registry.js';
import { PendingQueue } from './queue.js';
import { MessageRouter } from './router.js';
import { WeGirlTools } from './tools.js';
import { registerEventHandlers } from './event-handlers.js';
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
            logger.info('[WeGirl] Tools registered: wegirl_send');
        }
        else {
            logger.warn('[WeGirl] registerTool not available');
        }
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
export default plugin;
//# sourceMappingURL=index.js.map