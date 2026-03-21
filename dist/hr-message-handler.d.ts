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
import type Redis from 'ioredis';
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
export declare function checkIsAgent(identifier: string, redis: Redis, logger: any): Promise<boolean>;
/**
 * 检查是否是入职请求
 */
export declare function isOnboardRequest(message: string | undefined): boolean;
/**
 * 检查是否是入职数据格式
 */
export declare function isOnboardFormat(message: string | undefined): boolean;
/**
 * 解析入职数据（Human 入职）
 */
export interface OnboardData {
    staffId: string;
    name: string;
    phone?: string;
    role?: string;
    capabilities?: string[];
    valid: boolean;
    error?: string;
}
export declare function parseOnboardData(message: string): OnboardData;
/**
 * 生成入职提示文案（针对 Human）
 * 人事主管风格：专业、热情、有条理
 */
export declare function generateOnboardPrompt(userName?: string): string;
/**
 * 处理群聊 @ 消息
 */
export declare function handleMentionMessage(context: MentionContext, redis: Redis, logger: any, instanceId: string): Promise<void>;
/**
 * 处理私聊消息 - 入职绑定流程
 */
export declare function handlePrivateMessage(context: PrivateMessageContext, redis: Redis, logger: any, instanceId: string): Promise<void>;
//# sourceMappingURL=hr-message-handler.d.ts.map