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
export function isOnboardRequest(message: string | undefined): boolean {
  if (!message || typeof message !== 'string') return false;
  const keywords = ['我要入职', '入职', '绑定', '注册', 'onboard', 'bind', 'register'];
  const lowerMsg = message.toLowerCase().trim();
  return keywords.some(kw => lowerMsg.includes(kw));
}

/**
 * 检查是否是入职数据格式
 */
export function isOnboardFormat(message: string | undefined): boolean {
  if (!message || typeof message !== 'string') return false;
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
    // 匹配 工号（支持 : 或 ：）- 只匹配工号部分（遇到空格或下一个关键字停止）
    const idMatch = line.match(/工号\s*[:：]\s*([a-z0-9_-]+)/i);
    if (idMatch && !staffId) {
      staffId = idMatch[1].trim();
      continue;
    }

    // 匹配姓名（支持 : 或 ：）- 匹配到下一个关键字或行尾
    const nameMatch = line.match(/姓名\s*[:：]\s*([^电话角色能力]+)/);
    if (nameMatch && !name) {
      name = nameMatch[1].trim();
      continue;
    }

    // 匹配电话/手机（支持 : 或 ：）- 匹配数字
    const phoneMatch = line.match(/(?:电话|手机|联系方式)\s*[:：]\s*(\d+)/);
    if (phoneMatch && !phone) {
      phone = phoneMatch[1].trim();
      continue;
    }

    // 匹配角色/职责（支持 : 或 ：）- 匹配到下一个关键字或行尾
    const roleMatch = line.match(/(?:角色|职责)\s*[:：]\s*([^能力]+)/);
    if (roleMatch && !role) {
      role = roleMatch[1].trim();
      continue;
    }

    // 匹配能力（支持 : 或 ：）- 匹配到行尾
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
 * 人事主管风格：专业、热情、有条理
 */
export function generateOnboardPrompt(userName?: string): string {
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
  } else {
    logger.info(`[HR] @Human detected: ${identifier}, ignored`);
  }
}

/**
 * 处理私聊消息 - 入职绑定流程
 * 返回消息对象，未处理返回 null
 */
export async function handlePrivateMessage(
  context: PrivateMessageContext,
  redis: Redis,
  logger: any,
  instanceId: string
): Promise<any | null> {
  const { message, source, target } = context;

  if (!source) {
    logger.warn('[HR] Empty userId in private message');
    return null;
  }

  logger.info(`[HR] Private message from ${source}: ${message?.substring(0, 50)}`);

  // 1. 检查是否是入职请求（但没有数据）
  if (isOnboardRequest(message) && !isOnboardFormat(message)) {
    logger.info(`[HR] Onboard request without data from ${source}`);

    // 返回入职登记表
    return {
      flowType: 'A2H',
      source: 'hr',
      target: source,
      message: generateOnboardPrompt(""),
      chatType: 'direct',
      msgType: 'message',
      routingId: randomUUID(),
      timestamp: Date.now(),
    };
  }

  // 2. 检查是否是入职数据格式
  console.log(`[HR] Checking onboard format for: ${message?.substring(0, 50)}`);
  console.log(`[HR] isOnboardFormat result: ${isOnboardFormat(message)}`);

  if (isOnboardFormat(message)) {
    logger.info(`[HR] Onboard format detected from ${source}`);

    const data = parseOnboardData(message);
    console.log(`[HR] parseOnboardData result:`, JSON.stringify(data));

    if (!data.valid) {
      // 返回错误消息
      return {
        flowType: 'A2H',
        source: 'hr',
        target: source,
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
        target: source,
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
      target: source,
      message: `收到新员工入职申请：${data.name} (${data.staffId})`,
      chatType: 'direct',
      msgType: 'onboard_human',
      routingId: randomUUID(),
      payload: {
        staffId: data.staffId,
        name: data.name,
        phone: data.phone,
        role: data.role,
        openId: source,
        capabilities: data.capabilities,
      },
      timestamp: Date.now(),
    };
  }

  // 3. 其他消息，未处理
  logger.info(`[HR] Ignoring non-onboard message from ${source}`);
  return null;
}

function randomUUID(): string {
  return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}