interface SessionsSendOptions {
    message: string;
    cfg: any;
    channel: string;
    accountId: string;
    from: string;
    chatId: string;
    chatType: string;
    log?: any;
    taskId?: string;
    agentCount?: number;
    currentAgentId?: string;
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