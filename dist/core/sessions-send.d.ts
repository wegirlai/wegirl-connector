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
    /** 来源类型: inner (wegirlSend调用) / outer (startAccount调用) */
    fromType?: 'inner' | 'outer';
    cfg: any;
    channel: string;
    log?: any;
}
/**
 * 发送消息到 Agent
 *
 * 流程:
 * 1. 获取 PluginRuntime
 * 2. 使用 resolveAgentRoute 查找 agent
 * 3. 构建 inbound context（设置 OriginatingChannel 用于回复路由）
 * 4. 调用 dispatchReplyFromConfig 发送消息给 Agent
 * 5. Gateway 自动处理 Agent 回复的路由
 */
export declare function wegirlSessionsSend(options: SessionsSendOptions): Promise<void>;
export {};
//# sourceMappingURL=sessions-send.d.ts.map