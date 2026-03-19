// src/event-handlers.ts - OpenClaw 事件处理器注册
import { randomUUID } from 'crypto';
/**
 * 注册所有 OpenClaw 事件处理器
 */
export function registerEventHandlers(ctx) {
    const { context, logger, pluginConfig, getRedisClient, getRegistry, instanceId } = ctx;
    const keyPrefix = pluginConfig?.keyPrefix || 'openclaw:events:';
    // Agent 启动时自动注册到 wegirl
    context.on('before_agent_start', async (event) => {
        const agentId = event?.agentId;
        const registry = getRegistry();
        if (agentId && registry) {
            try {
                await registry.registerAgent({
                    agentId,
                    name: agentId,
                    capabilities: event.capabilities || ['general'],
                    maxConcurrent: 3
                }, {
                    instanceId,
                    version: '1.0'
                });
                logger.info(`[WeGirl] Agent auto-registered: ${agentId}`);
            }
            catch (err) {
                logger.error(`[WeGirl] Agent registration failed:`, err.message);
            }
        }
        await persistEvent('before_agent_start', event, ctx);
    });
    // Agent 结束时注销
    context.on('agent_end', async (event) => {
        const agentId = event?.agentId;
        const registry = getRegistry();
        if (agentId && registry) {
            await registry.unregisterAgent(agentId);
            logger.info(`[WeGirl] Agent unregistered: ${agentId}`);
        }
        await persistEvent('agent_end', event, ctx);
    });
    // 子 Agent 启动中
    context.on('subagent_spawning', (event) => {
        persistEvent('subagent_spawning', event, ctx);
    });
    // Agent 错误
    context.on('agent_error', (event) => {
        logger.error(`[WeGirl] Event: agent_error`);
        persistEvent('agent_error', event, ctx);
    });
    // 收到消息
    context.on('message_received', (event) => {
        const content = event?.content || '';
        const preview = typeof content === 'string'
            ? content.substring(0, 100)
            : JSON.stringify(content).substring(0, 100);
        logger.info(`[WeGirl] Event: message_received, content=${preview}${content.length > 100 ? '...' : ''}`);
        persistEvent('message_received', event, ctx);
    });
    // 发送消息
    context.on('message_sent', (event) => {
        logger.info(`[WeGirl] Event: message_sent`);
        persistEvent('message_sent', event, ctx);
    });
    // 会话创建
    context.on('session_created', (event) => {
        logger.info('[WeGirl] Event: session_created');
        persistEvent('session_created', event, ctx);
    });
    // 会话结束
    context.on('session_ended', (event) => {
        logger.info('[WeGirl] Event: session_ended');
        persistEvent('session_ended', event, ctx);
    });
    // Tool 调用前
    context.on('before_tool_call', (event) => {
        const toolName = event?.toolName || 'unknown';
        const params = event?.params || {};
        // 提取文件路径（针对 read/edit 工具）
        let target = 'N/A';
        if (toolName === 'read' || toolName === 'edit') {
            target = params.file_path || params.path || params.filePath || 'N/A';
        }
        else {
            target = params.command || 'N/A';
        }
        logger.info(`[WeGirl] Event: before_tool_call - ${toolName} (target: ${target})`);
        persistEvent('before_tool_call', event, ctx);
    });
    // Tool 调用后
    context.on('after_tool_call', (event) => {
        const toolName = event?.toolName || 'unknown';
        const params = event?.params || {};
        const duration = event?.durationMs || 'unknown';
        // 提取文件路径（针对 read/edit 工具）
        let target = 'N/A';
        if (toolName === 'read' || toolName === 'edit') {
            target = params.file_path || params.path || params.filePath || 'N/A';
        }
        else {
            target = params.command || 'N/A';
        }
        logger.info(`[WeGirl] Event: after_tool_call - ${toolName} (target: ${target}, ${duration}ms)`);
        persistEvent('after_tool_call', event, ctx);
    });
    logger.info('[WeGirl] Event handlers registered (10 events)');
}
/**
 * 事件持久化到 Redis
 */
async function persistEvent(eventType, payload, ctx) {
    const redisClient = ctx.getRedisClient();
    if (!redisClient || redisClient.status !== 'ready')
        return;
    const keyPrefix = ctx.pluginConfig?.keyPrefix || 'openclaw:events:';
    const ttl = ctx.pluginConfig?.ttl || 86400 * 7;
    const timestamp = Date.now();
    const eventId = randomUUID();
    const eventData = {
        id: eventId,
        type: eventType,
        timestamp: timestamp.toString(),
        payload: JSON.stringify(payload),
        sessionId: payload?.sessionId || 'global',
        userId: payload?.userId || 'system',
    };
    const pipeline = redisClient.pipeline();
    pipeline.hset(`${keyPrefix}data:${eventId}`, eventData);
    pipeline.zadd(`${keyPrefix}timeline`, timestamp, eventId);
    pipeline.sadd(`${keyPrefix}type:${eventType}`, eventId);
    pipeline.expire(`${keyPrefix}data:${eventId}`, ttl);
    await pipeline.exec();
}
//# sourceMappingURL=event-handlers.js.map