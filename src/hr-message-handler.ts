/**
 * HR Manage - 消息处理核心
 * 处理群聊 @ 消息 和 私聊入职绑定流程
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type Redis from 'ioredis';

const KEY_PREFIX = 'wegirl:';

export interface MentionContext {
  mentionKey: string;
  mentionId?: string;
  mentionName?: string;
  chatId?: string;
  chatType?: string;
  fromUser?: string;
  senderName?: string;
}

export interface PrivateMessageContext {
  message: string;
  userId: string;
  userName?: string;
  feishuOpenId?: string;
  chatId: string;
  chatType: string;
}

/**
 * 检查 identifier 是否是 agent
 */
export async function checkIsAgent(
  identifier: string,
  redis: Redis,
  logger: any
): Promise<boolean> {
  if (!identifier) return false;

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
  } catch (e: any) {
    logger.debug(`[HR] Error reading openclaw.json: ${e.message}`);
  }

  // 2. 检查 Redis
  try {
    const staffData = await redis.hgetall(`${KEY_PREFIX}staff:${identifier}`);
    if (staffData && staffData.type === 'agent') {
      logger.info(`[HR] Found agent in Redis: ${identifier}`);
      return true;
    }
  } catch (e: any) {
    logger.debug(`[HR] Error checking Redis: ${e.message}`);
  }

  return false;
}

/**
 * 检查是否是入职请求
 */
export function isOnboardRequest(message: string): boolean {
  const keywords = ['我要入职', '入职', '绑定', '注册', 'onboard', 'bind', 'register'];
  const lowerMsg = message.toLowerCase().trim();
  return keywords.some(kw => lowerMsg.includes(kw));
}

/**
 * 检查是否是入职数据格式
 */
export function isOnboardFormat(message: string): boolean {
  // 必须包含 工号 和 姓名
  const hasId = /工号\s*[:：]/.test(message);
  const hasName = /姓名\s*[:：]/.test(message);
  return hasId && hasName;
}

/**
 * 解析入职数据（Human 入职）
 */
export interface OnboardData {
  staffId: string;  // 工号
  name: string;     // 姓名
  phone?: string;   // 电话
  role?: string;    // 角色
  capabilities?: string[];  // 能力标签
  valid: boolean;
  error?: string;
}

export function parseOnboardData(message: string): OnboardData {
  const lines = message.split('\n').map(l => l.trim()).filter(l => l);
  
  let staffId: string | undefined;
  let name: string | undefined;
  let phone: string | undefined;
  let role: string | undefined;
  let capabilities: string[] | undefined;

  for (const line of lines) {
    // 匹配 工号（支持 : 或 ：）
    const idMatch = line.match(/工号\s*[:：]\s*(.+)/);
    if (idMatch && !staffId) {
      staffId = idMatch[1].trim();
      continue;
    }

    // 匹配姓名（支持 : 或 ：）
    const nameMatch = line.match(/姓名\s*[:：]\s*(.+)/);
    if (nameMatch && !name) {
      name = nameMatch[1].trim();
      continue;
    }

    // 匹配电话/手机（支持 : 或 ：）
    const phoneMatch = line.match(/(?:电话|手机|联系方式)\s*[:：]\s*(.+)/);
    if (phoneMatch && !phone) {
      phone = phoneMatch[1].trim();
      continue;
    }

    // 匹配角色/职责（支持 : 或 ：）
    const roleMatch = line.match(/(?:角色|职责)\s*[:：]\s*(.+)/);
    if (roleMatch && !role) {
      role = roleMatch[1].trim();
      continue;
    }

    // 匹配能力（支持 : 或 ：）
    const capMatch = line.match(/能力\s*[:：]\s*(.+)/);
    if (capMatch) {
      // 解析逗号分隔的能力标签
      capabilities = capMatch[1]
        .split(/[,，]/)
        .map(c => c.trim())
        .filter(c => c.length > 0);
      continue;
    }
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
 */
export function generateOnboardPrompt(userName?: string): string {
  const greeting = userName ? `你好 ${userName}！` : '你好！';
  return `${greeting}请填写入职登记表，我来帮你办理：

---

**📝 入职登记表**

| 项目 | 说明 |
|------|------|
| **工号** | 你的唯一标识（必填）<br>只能含：小写字母、数字、横线"、下划线"_" |
| **姓名** | 你的真实姓名（必填） |
| **电话** | 联系方式（选填） |
| **角色** | 你的职责/职位（选填，如：产品经理、设计师） |
| **能力** | 擅长什么（选填，如：writing, analysis, sales） |

---

**示例：**
\`\`\`
工号：tiger
姓名：张三
电话：13800138000
角色：产品经理
能力：writing, analysis
\`\`\`

请回复你的信息，我马上录入系统！`;
}

/**
 * 处理群聊 @ 消息
 */
export async function handleMentionMessage(
  context: MentionContext,
  redis: Redis,
  logger: any,
  instanceId: string
): Promise<void> {
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

    const command = {
      flowType: 'A2A',
      source: 'hr',
      target: identifier,
      message: 'sync_agent',
      chatType: 'group',
      groupId: chatId,
      msgType: 'sync_agent',  // HR 命令类型
      payload: {
        agentId: identifier,
        fromMention: true,
        chatId,
        chatType,
      },
      routingId: randomUUID(),
      timestamp: Date.now(),
    };

    await redis.publish('wegirl:replies', JSON.stringify(command));
    logger.info(`[HR] Sync agent command sent: ${identifier}`);
  } else {
    logger.info(`[HR] @Human detected: ${identifier}, ignored`);
  }
}

/**
 * 处理私聊消息 - 入职绑定流程
 */
export async function handlePrivateMessage(
  context: PrivateMessageContext,
  redis: Redis,
  logger: any,
  instanceId: string
): Promise<void> {
  const { message, userId, userName, feishuOpenId, chatId, chatType } = context;

  if (!userId) {
    logger.warn('[HR] Empty userId in private message');
    return;
  }

  logger.info(`[HR] Private message from ${userId}: ${message?.substring(0, 50)}`);

  // 1. 检查是否是入职请求（但没有数据）
  if (isOnboardRequest(message) && !isOnboardFormat(message)) {
    logger.info(`[HR] Onboard request without data from ${userId}`);
    
    // 发送入职提示（标准 A2H 格式，msgType: message）
    const promptMsg = {
      flowType: 'A2H',
      source: 'hr',
      target: feishuOpenId || userId,  // 未绑定用户用 openId
      message: generateOnboardPrompt(userName),
      chatType: 'direct',
      msgType: 'message',  // 普通消息
      routingId: randomUUID(),
      timestamp: Date.now(),
    };

    await redis.publish('wegirl:replies', JSON.stringify(promptMsg));
    logger.info(`[HR] Onboard prompt sent to ${userId}`);
    return;
  }

  // 2. 检查是否是入职数据格式
  if (isOnboardFormat(message)) {
    logger.info(`[HR] Onboard format detected from ${userId}`);
    
    const data = parseOnboardData(message);

    if (!data.valid) {
      // 数据格式错误，发送错误提示（标准 A2H 格式）
      const errorMsg = {
        flowType: 'A2H',
        source: 'hr',
        target: feishuOpenId || userId,
        message: `❌ 信息格式错误：${data.error}\n\n请按以下格式重新发送：\n\`\`\`\n工号：xxx（只能包含小写字母、数字、-、_）\n姓名：xxx\n电话：xxx（选填）\n角色：xxx（选填）\n能力：xxx, xxx（选填）\n\`\`\``,
        chatType: 'direct',
        msgType: 'message',
        routingId: randomUUID(),
        timestamp: Date.now(),
      };
      await redis.publish('wegirl:replies', JSON.stringify(errorMsg));
      return;
    }

    // 检查 StaffID 是否被占用
    const existing = await redis.hgetall(`${KEY_PREFIX}staff:${data.staffId}`);
    if (existing && existing.id) {
      const conflictMsg = {
        flowType: 'A2H',
        source: 'hr',
        target: feishuOpenId || userId,
        message: `❌ StaffID "${data.staffId}" 已被占用，请选择其他 ID`,
        chatType: 'direct',
        msgType: 'message',
        routingId: randomUUID(),
        timestamp: Date.now(),
      };
      await redis.publish('wegirl:replies', JSON.stringify(conflictMsg));
      return;
    }

    // 3. 发送入职数据到 wegirl-service（带 payload 的 HR 命令）
    const onboardMsg = {
      flowType: 'A2H',
      source: 'hr',
      target: feishuOpenId || userId,  // 回复给该用户
      message: `✅ 入职申请已提交，正在处理...`,  // 可选提示
      chatType: 'direct',
      msgType: 'onboard_human',  // HR 命令类型
      payload: {
        staffId: data.staffId,
        name: data.name,
        phone: data.phone,
        role: data.role,
        capabilities: data.capabilities,
        feishuOpenId: feishuOpenId || userId,
      },
      routingId: randomUUID(),
      timestamp: Date.now(),
    };

    await redis.publish('wegirl:replies', JSON.stringify(onboardMsg));
    logger.info(`[HR] Onboard data sent for ${data.staffId}`);
    return;
  }

  // 3. 其他消息，忽略或转发
  logger.info(`[HR] Ignoring non-onboard message from ${userId}`);
}

function randomUUID(): string {
  return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}
