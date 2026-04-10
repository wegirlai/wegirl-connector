interface MonitorParams {
    accountId: string;
    instanceId: string;
    cfg: any;
    abortSignal?: AbortSignal;
    log?: any;
}
/**
 * 监控 WeGirl Redis Stream（每个 agent 独立）
 * 监听 wegirl:stream:${instanceId}:${accountId}
 *
 * ⚠️ 设计原则：
 * 1. 此函数从 Stream 接收消息
 * 2. 调用 wegirlSessionsSend 完成实际的 act（Agent 处理）
 * 3. 处理成功后才 ACK 消息（at-least-once 语义）
 * 4. 如果处理失败，消息保留在 pending 列表中，可被重新消费
 */
export declare function monitorWeGirlProvider(params: MonitorParams): Promise<void>;
export {};
//# sourceMappingURL=monitor.d.ts.map