/**
 * HR Manage - 消息处理核心
 * 处理群聊 @ 消息，判断是 agent 还是人类，发送命令到 wegirl-service
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
/**
 * 检查 identifier 是否是 agent
 * 优先级：openclaw.json > Redis
 */
export declare function checkIsAgent(identifier: string, redis: Redis, logger: any): Promise<boolean>;
/**
 * 处理群聊 @ 消息
 * 判断被@的是 agent 还是人类，发送相应命令到 wegirl:replies
 */
export declare function handleMentionMessage(context: MentionContext, redis: Redis, logger: any, instanceId: string): Promise<void>;
/**
 * 处理私聊消息
 * 直接发送入职/更新人类命令
 */
export declare function handlePrivateMessage(userId: string, userName: string | undefined, feishuOpenId: string | undefined, redis: Redis, logger: any, instanceId: string): Promise<void>;
//# sourceMappingURL=hr-message-handler.d.ts.map