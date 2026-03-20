/**
 * HR Manage - 消息处理核心
 * 处理群聊 @ 消息，判断是 agent 还是人类，发送命令到 wegirl-service
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
const KEY_PREFIX = 'wegirl:';
/**
 * 检查 identifier 是否是 agent
 * 优先级：openclaw.json > Redis
 */
export async function checkIsAgent(identifier, redis, logger) {
    if (!identifier)
        return false;
    const checkId = identifier.toLowerCase();
    // 1. 检查 openclaw.json (源数据)
    try {
        const openclawHome = process.env.OPENCLAW_HOME || path.join(os.homedir(), '.openclaw');
        const configPath = path.join(openclawHome, 'openclaw.json');
        if (fs.existsSync(configPath)) {
            const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
            const agentsList = config.agents?.list || [];
            for (const agent of agentsList) {
                const agentName = (agent.name || '').toLowerCase();
                const agentId = (agent.id || '').toLowerCase();
                if (checkId === agentName || checkId === agentId) {
                    logger.info(`[HR] Found agent in openclaw.json: ${identifier}`);
                    return true;
                }
            }
        }
    }
    catch (e) {
        logger.debug(`[HR] Error reading openclaw.json: ${e.message}`);
    }
    // 2. 检查 Redis
    try {
        const staffData = await redis.hgetall(`${KEY_PREFIX}staff:${identifier}`);
        if (staffData && staffData.type === 'agent') {
            logger.info(`[HR] Found agent in Redis: ${identifier}`);
            return true;
        }
    }
    catch (e) {
        logger.debug(`[HR] Error checking Redis: ${e.message}`);
    }
    return false;
}
/**
 * 处理群聊 @ 消息
 * 判断被@的是 agent 还是人类，发送相应命令到 wegirl:replies
 */
export async function handleMentionMessage(context, redis, logger, instanceId) {
    const { mentionKey, mentionId, mentionName, chatId, chatType, fromUser, senderName } = context;
    const identifier = mentionId || mentionKey;
    if (!identifier) {
        logger.warn('[HR] Empty mention identifier');
        return;
    }
    logger.info(`[HR] Processing mention: ${identifier} (${mentionName || 'unknown'})`);
    // 判断是 agent 还是人类
    const isAgent = await checkIsAgent(identifier, redis, logger);
    if (isAgent) {
        // 是 agent → 发送同步命令
        logger.info(`[HR] @Agent detected: ${identifier}, sending sync command`);
        const command = {
            type: 'hr_command',
            command: 'sync_agent',
            payload: {
                agentId: identifier,
                fromMention: true,
                chatId,
                chatType,
            },
            fromAgent: 'hr',
            instanceId,
            timestamp: Date.now(),
            routingId: randomUUID(),
        };
        await redis.publish('wegirl:replies', JSON.stringify(command));
        logger.info(`[HR] Sync agent command sent: ${identifier}`);
    }
    else {
        // 是人类 → 发送入职/更新命令
        logger.info(`[HR] @Human detected: ${identifier}, sending onboard command`);
        const humanId = mentionId || mentionKey;
        const command = {
            type: 'hr_command',
            command: 'onboard_user',
            payload: {
                userId: humanId,
                name: mentionName || humanId,
                feishuOpenId: mentionId,
                fromMention: true,
                chatId,
                chatType,
                mentionedBy: fromUser,
                mentionedByName: senderName,
            },
            fromAgent: 'hr',
            instanceId,
            timestamp: Date.now(),
            routingId: randomUUID(),
        };
        await redis.publish('wegirl:replies', JSON.stringify(command));
        logger.info(`[HR] Onboard human command sent: ${humanId}`);
    }
}
/**
 * 处理私聊消息
 * 直接发送入职/更新人类命令
 */
export async function handlePrivateMessage(userId, userName, feishuOpenId, redis, logger, instanceId) {
    if (!userId) {
        logger.warn('[HR] Empty userId in private message');
        return;
    }
    logger.info(`[HR] Processing private message from: ${userId}`);
    const command = {
        type: 'hr_command',
        command: 'onboard_user',
        payload: {
            userId: userId,
            name: userName || userId,
            feishuOpenId: feishuOpenId || userId,
            fromPrivate: true,
        },
        fromAgent: 'hr',
        instanceId,
        timestamp: Date.now(),
        routingId: randomUUID(),
    };
    await redis.publish('wegirl:replies', JSON.stringify(command));
    logger.info(`[HR] Onboard human command sent for private message: ${userId}`);
}
function randomUUID() {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}
//# sourceMappingURL=hr-message-handler.js.map