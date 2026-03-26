import type { FlowType, ChatType, StaffId, WeGirlSendOptions, SessionContext } from './types.js';
/**
 * 生成唯一ID
 */
export declare function generateId(): string;
/**
 * 验证选项
 */
export declare function validateOptions(options: WeGirlSendOptions): void;
/**
 * 获取默认 replyTo
 */
export declare function getDefaultReplyTo(flowType: FlowType, chatType: ChatType, source: StaffId, target: StaffId): StaffId[];
/**
 * 解析 replyTo
 */
export declare function resolveReplyTo(replyTo: StaffId | StaffId[] | undefined, flowType: FlowType, chatType: ChatType, source: StaffId, target: StaffId): StaffId[];
/**
 * 创建 Session 上下文
 */
export declare function createSessionContext(options: WeGirlSendOptions, routingId: string): SessionContext;
/**
 * 创建 Session Key
 */
export declare function createSessionKey(target: StaffId, chatType: ChatType, groupId?: string): string;
/**
 * 根据 flowType 推断 source/target 类型
 */
export declare function inferEntityType(flowType: FlowType, role: 'source' | 'target'): 'agent' | 'human';
/**
 * 检查是否为 NO_REPLY
 */
export declare function isNoReply(replyTo: StaffId[]): boolean;
/**
 * 消息构建选项
 */
export interface MessageBuilderOptions {
    flowType: string;
    source: string;
    target: string;
    message: string;
    chatType: string;
    groupId?: string;
    routingId: string;
    msgType?: string;
    fromType?: string;
    metadata?: Record<string, any>;
    timeoutSeconds?: number;
}
/**
 * 构建标准消息
 */
export declare function buildMessage(opts: MessageBuilderOptions, baseMetadata?: Record<string, any>): any;
//# sourceMappingURL=utils.d.ts.map