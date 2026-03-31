interface SessionsSendOptions {
    /** 消息内容 */
    message: string;
    /** 来源 StaffId */
    source: string;
    /** 目标 StaffId（agent accountId） */
    target: string;
    /** 聊天类型 */
    chatType: string;
    /** 群聊ID（chatType='group' 时必填） */
    groupId?: string;
    /** 路由追踪ID */
    routingId?: string;
    /** 任务ID */
    taskId?: string;
    /** 步骤ID */
    stepId?: string;
    /** 步骤总 Agent 数 */
    stepTotalAgents?: number;
    /** 消息类型 */
    msgType?: string;
    /** 额外载荷 */
    payload?: Record<string, any>;
    /** 元数据 */
    metadata?: any;
    /** 回复目标 */
    replyTo?: string;
    /** 来源类型: inner (wegirlSend调用) / outer (startAccount调用) */
    fromType?: 'inner' | 'outer';
    cfg: any;
    channel: string;
    log?: any;
}
/**
 * 发送消息到 Agent (使用 dispatchReplyWithBufferedBlockDispatcher)
 *
 * 标准流程:
 * 1. resolveAgentRoute → 确定 agent 和 sessionKey
 * 2. finalizeInboundContext → 构建 ctxPayload
 * 3. createReplyPrefixOptions → 获取前缀选项 + onModelSelected
 * 4. dispatchReplyWithBufferedBlockDispatcher → 发送并处理回复
 * 5. deliver(payload) → 处理 Agent 回复（含 Redis 同步、转发、群聊聚合等）
 */
export declare function wegirlSessionsSend(options: SessionsSendOptions): Promise<void>;
export {};
//# sourceMappingURL=sessions-send.d.ts.map