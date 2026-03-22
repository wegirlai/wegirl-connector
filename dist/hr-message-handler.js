/**
 * HR Manage - 消息处理核心
 * 处理群聊 @ 消息 和 私聊入职绑定流程
 *
 * 消息格式遵循 wegirl_send V2 标准：
 * {
 *   flowType: 'H2A' | 'A2A' | 'A2H',
 *   source: string,      // 发送者 StaffId
 *   target: string,      // 接收者 StaffId
 *   message: string,     // 消息内容
 *   chatType: 'direct' | 'group',
 *   groupId?: string,    // 群聊时必填
 *   routingId?: string,
 *   msgType?: 'message' | 'error' | 'onboard_human' | 'sync_agent',
 *   payload?: object,    // 额外数据
 *   metadata?: object,   // 元数据
 *   timestamp: number
 * }
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
const KEY_PREFIX = 'wegirl:';
/**
 * 检查 identifier 是否是 agent
 */
export async function checkIsAgent(identifier, redis, logger) {
    if (!identifier)
        return false;
    const checkId = identifier.toLowerCase();
    // 1. 检查 openclaw.json
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
 * 检查是否是入职请求
 */
export function isOnboardRequest(message) {
    if (!message || typeof message !== 'string')
        return false;
    const keywords = ['我要入职', '入职', '绑定', '注册', 'onboard', 'bind', 'register'];
    const lowerMsg = message.toLowerCase().trim();
    return keywords.some(kw => lowerMsg.includes(kw));
}
/**
 * 检查是否是入职数据格式
 */
export function isOnboardFormat(message) {
    if (!message || typeof message !== 'string')
        return false;
    // 必须包含 工号 和 姓名
    const hasId = /工号\s*[:：]/.test(message);
    const hasName = /姓名\s*[:：]/.test(message);
    return hasId && hasName;
}
export function parseOnboardData(message) {
    // 将多行合并为单行，方便统一处理
    const fullText = message.replace(/\n/g, ' ').trim();
    let staffId;
    let name;
    let phone;
    let role;
    let capabilities;
    // 按顺序解析各个字段
    // 1. 工号 - 匹配工号：xxx 或 工号: xxx（只匹配合法的工号字符）
    const idMatch = fullText.match(/工号\s*[:：]\s*([a-z0-9_-]+)/i);
    if (idMatch) {
        staffId = idMatch[1].trim();
    }
    // 2. 姓名 - 匹配姓名：xxx 或 姓名: xxx（匹配到下一个关键字之前的内容）
    // 使用正向肯定查看来匹配到"电话"、"角色"或"能力"之前
    const nameMatch = fullText.match(/姓名\s*[:：]\s*([^\s]+?)(?=\s*(?:电话|手机|角色|职责|能力|$))/);
    if (nameMatch) {
        name = nameMatch[1].trim();
    }
    // 3. 电话/手机 - 匹配数字
    const phoneMatch = fullText.match(/(?:电话|手机|联系方式)\s*[:：]\s*(\d+)/);
    if (phoneMatch) {
        phone = phoneMatch[1].trim();
    }
    // 4. 角色/职责 - 匹配到"能力"之前
    const roleMatch = fullText.match(/(?:角色|职责)\s*[:：]\s*([^\s]+?)(?=\s*能力|$)/);
    if (roleMatch) {
        role = roleMatch[1].trim();
    }
    // 5. 能力 - 匹配到行尾，逗号分隔
    const capMatch = fullText.match(/能力\s*[:：]\s*(.+?)(?=\s*(?:$))/);
    if (capMatch) {
        capabilities = capMatch[1]
            .split(/[,，]/)
            .map(c => c.trim())
            .filter(c => c.length > 0);
    }
    // 验证
    if (!staffId) {
        return { staffId: '', name: '', valid: false, error: '未找到工号' };
    }
    // 验证 staffId 格式（小写字母、数字、-、_）
    const validIdPattern = /^[a-z0-9_-]+$/;
    if (!validIdPattern.test(staffId)) {
        return {
            staffId,
            name: name || '',
            valid: false,
            error: '工号格式错误，只能包含小写字母、数字、连字符(-)和下划线(_)'
        };
    }
    if (!name) {
        return { staffId, name: '', valid: false, error: '未找到姓名' };
    }
    return {
        staffId: staffId.toLowerCase(),
        name,
        phone,
        role,
        capabilities,
        valid: true
    };
}
/**
 * 生成入职提示文案（针对 Human）
 * 人事主管风格：专业、热情、有条理
 */
export function generateOnboardPrompt(userName) {
    const greeting = userName ? `${userName}，你好！` : '你好！';
    return `${greeting}欢迎加入微妞团队！我是团队的人事主管，负责协助新成员顺利入职。

为了帮你快速办理入职手续，请按以下格式提供信息：

---

**📝 入职信息登记表**

| 项目 | 说明 |
|------|------|
| **工号** | 系统唯一标识（必填）<br>只能包含：小写字母、数字、横线"-"、下划线"_" |
| **姓名** | 真实姓名（必填） |
| **电话** | 联系方式（选填） |
| **角色** | 职位/职责（选填，如：产品经理、销售专员） |
| **能力** | 技能标签（选填，如：writing, analysis, sales） |

---

**请直接回复：**
\`\`\`
工号：
姓名：
电话：
角色：
能力：
\`\`\`

收到后我会立即处理，并协调 CTO 为你配置工作环境。

如有任何问题，随时找我！`;
}
/**
 * 处理群聊 @ 消息
 */
export async function handleMentionMessage(context, redis, logger, instanceId) {
    const { mentionKey, mentionId, mentionName, chatId, chatType, fromUser, senderName } = context;
    const identifier = mentionId || mentionKey;
    if (!identifier) {
        logger.warn('[HR] Empty mention identifier');
        return;
    }
    logger.info(`[HR] Processing mention: ${identifier} (${mentionName || 'unknown'})`);
    const isAgent = await checkIsAgent(identifier, redis, logger);
    if (isAgent) {
        logger.info(`[HR] @Agent detected: ${identifier}, sending sync_agent`);
        // 构建标准 V2 格式消息
        const syncMsg = {
            flowType: 'A2A',
            source: 'hr',
            target: identifier,
            message: 'sync_agent',
            chatType: 'group',
            groupId: chatId,
            msgType: 'sync_agent',
            routingId: randomUUID(),
            payload: {
                agentId: identifier,
                fromMention: true,
                chatId,
                chatType,
            },
            timestamp: Date.now(),
        };
        await redis.publish('wegirl:replies', JSON.stringify(syncMsg));
        logger.info(`[HR] Sync agent command sent: ${identifier}`);
    }
    else {
        logger.info(`[HR] @Human detected: ${identifier}, ignored`);
    }
}
/**
 * 处理私聊消息 - 入职绑定流程
 * 返回消息对象，未处理返回 null
 */
export async function handlePrivateMessage(context, redis, logger, instanceId) {
    const { message, userId } = context;
    if (!userId) {
        logger.warn('[HR] Empty userId in private message');
        return null;
    }
    logger.info(`[HR] Private message from ${userId}: ${message?.substring(0, 50)}`);
    // 预计算 isOnboardFormat 结果，避免重复调用
    const hasOnboardFormat = isOnboardFormat(message);
    // 1. 检查是否是入职请求（但没有数据）
    if (isOnboardRequest(message) && !hasOnboardFormat) {
        logger.info(`[HR] Onboard request without data from ${userId}`);
        // 返回入职登记表
        return {
            flowType: 'A2H',
            source: 'hr',
            target: userId,
            message: generateOnboardPrompt(""),
            chatType: 'direct',
            msgType: 'message',
            routingId: randomUUID(),
            timestamp: Date.now(),
        };
    }
    // 2. 检查是否是入职数据格式
    console.log(`[HR] Checking onboard format for: ${message?.substring(0, 50)}`);
    console.log(`[HR] isOnboardFormat result: ${hasOnboardFormat}`);
    if (hasOnboardFormat) {
        logger.info(`[HR] Onboard format detected from ${userId}`);
        const data = parseOnboardData(message);
        console.log(`[HR] parseOnboardData result:`, JSON.stringify(data));
        if (!data.valid) {
            // 返回错误消息
            return {
                flowType: 'A2H',
                source: 'hr',
                target: userId,
                message: `❌ 信息格式错误：${data.error}\n\n请按以下格式重新发送：\n\`\`\`\n工号：xxx（只能包含小写字母、数字、-、_）\n姓名：xxx\n电话：xxx（选填）\n角色：xxx（选填）\n能力：xxx, xxx（选填）\n\`\`\``,
                chatType: 'direct',
                msgType: 'error',
                routingId: randomUUID(),
                timestamp: Date.now(),
            };
        }
        // 检查 StaffID 是否被占用
        const existing = await redis.hgetall(`${KEY_PREFIX}staff:${data.staffId}`);
        console.log(`[HR] Check existing staff ${data.staffId}:`, JSON.stringify(existing));
        if (existing && existing.staffId) {
            // 返回冲突错误消息
            return {
                flowType: 'A2H',
                source: 'hr',
                target: userId,
                message: `❌ StaffID "${data.staffId}" 已被占用，请选择其他 ID`,
                chatType: 'direct',
                msgType: 'error',
                routingId: randomUUID(),
                timestamp: Date.now(),
            };
        }
        console.log(`[HR] StaffID ${data.staffId} is available, preparing to publish`);
        // 3. 发送入职数据（标准 V2 格式）
        return {
            flowType: 'A2S',
            source: 'hr',
            target: userId,
            message: `收到新员工入职申请：${data.name} (${data.staffId})`,
            chatType: 'direct',
            msgType: 'onboard_human',
            routingId: randomUUID(),
            payload: {
                staffId: data.staffId,
                name: data.name,
                phone: data.phone,
                role: data.role,
                openId: userId,
                capabilities: data.capabilities,
            },
            timestamp: Date.now(),
        };
    }
    // 3. 其他消息，未处理
    logger.info(`[HR] Ignoring non-onboard message from ${userId}`);
    return null;
}
function randomUUID() {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}
//# sourceMappingURL=hr-message-handler.js.map