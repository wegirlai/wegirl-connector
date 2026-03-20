/**
 * HR Manage - 消息处理核心
 * 处理群聊 @ 消息 和 私聊入职绑定流程
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
export declare function isOnboardRequest(message: string): boolean;
/**
 * 检查是否是入职数据格式
 */
export declare function isOnboardFormat(message: string): boolean;
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