/**
 * 消息流向类型
 */
export type FlowType = 'H2A' | 'A2A' | 'A2H';
/**
 * 聊天类型
 */
export type ChatType = 'direct' | 'group';
/**
 * StaffId - 统一标识符
 * 可以是 agent 或 human 的抽象 ID
 */
export type StaffId = string;
/**
 * 特殊 StaffId
 */
export declare const SPECIAL_STAFF: {
    readonly NO_REPLY: StaffId;
};
/**
 * wegirlSend 选项
 */
export interface WeGirlSendOptions {
    /** 流向类型 */
    flowType: FlowType;
    /** 来源 StaffId（必填） */
    source: StaffId;
    /** 目标 StaffId（必填） */
    target: StaffId;
    /** 消息内容 */
    message: string;
    /** 聊天类型（可选，默认 direct） */
    chatType?: ChatType;
    /** 群聊ID（chatType='group' 时必填） */
    groupId?: string;
    /**
     * 回复目标（可选）
     * - undefined: 使用默认值
     * - string: 单个目标
     * - string[]: 多个目标
     */
    replyTo?: StaffId | StaffId[];
    /** 任务ID（可选，如有则全程携带） */
    taskId?: string;
    /** 步骤ID（可选） */
    stepId?: string;
    /** 步骤总 Agent 数 */
    stepTotalAgents?: number;
    /** 路由追踪ID（可选） */
    routingId?: string;
    /**
     * 消息类型（可选，默认 'message'）
     * - 'message': 普通消息
     * - 'onboard_human': 入职命令
     * - 'sync_agent': 同步 agent 命令
     */
    msgType?: string;
    /**
     * 额外载荷（可选）
     * 用于 HR 命令等场景，传递结构化数据
     */
    payload?: Record<string, any>;
    /** 扩展元数据（可选） */
    metadata?: Record<string, any>;
    /**
     * 超时秒数（可选，默认 0）
     * - 0: 异步发送，立即返回
     * - >0: 同步等待，阻塞直到收到响应或超时
     * - 最大值: 300 (5分钟)
     */
    timeoutSeconds?: number;
}
/**
 * Staff 信息（从 Redis 查询）
 */
export interface StaffInfo {
    staffId: StaffId;
    type: 'agent' | 'human';
    name?: string;
    instanceId?: string;
    feishuUserId?: string;
    capabilities?: string[];
    status?: string;
}
/**
 * 发送结果
 */
export interface SendResult {
    success: boolean;
    routingId: string;
    local?: boolean;
    targetInstanceId?: string;
    error?: string;
    status?: 'ok' | 'timeout' | 'error';
    response?: {
        message: string;
        payload?: Record<string, any>;
    };
    duration?: number;
}
/**
 * Session 上下文
 */
export interface SessionContext {
    flowType: FlowType;
    source: StaffId;
    target: StaffId;
    chatType: ChatType;
    groupId?: string;
    replyTo: StaffId[];
    taskId?: string;
    stepId?: string;
    stepTotalAgents?: number;
    routingId: string;
}
//# sourceMappingURL=types.d.ts.map