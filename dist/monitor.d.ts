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
 */
export declare function monitorWeGirlProvider(params: MonitorParams): Promise<void>;
export {};
//# sourceMappingURL=monitor.d.ts.map