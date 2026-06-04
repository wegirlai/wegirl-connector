/**
 * 获取全局配置
 */
export declare function getGlobalConfig(): any;
/**
 * 设置全局配置
 * 用于 startAccount 等场景直接传入 cfg
 */
export declare function setGlobalConfig(cfg: any): void;
/**
 * 获取 wegirl 插件配置
 *
 * 合并 plugins.entries.wegirl.config 和 channels.wegirl 的配置，
 * channel 配置优先级更高（覆盖 plugin 配置）。
 * 这样 ragApiUrl 等配置无论写在 plugin 还是 channel 段都能被正确读取。
 */
export declare function getWeGirlPluginConfig(): any;
/**
 * 获取 Redis 配置
 */
export declare function getRedisConfig(): {
    url: string;
    password?: string;
    db: number;
};
/**
 * 获取 RAG API 配置
 */
export declare function getRagApiConfig(): {
    url: string;
    timeout: number;
};
/**
 * 获取实例 ID
 */
export declare function getInstanceId(): string;
/**
 * 获取 account 的 batchConsumers 配置
 * 配置位置：channels.wegirl.accounts.{accountId}.batchConsumers
 */
export declare function getAccountBatchConsumers(cfg: any, accountId: string): number;
/**
 * 获取 Agent 的 sessions 目录路径
 * 从 cfg.agents.{agentId}.agentDir 推导，兼容 macOS/Linux
 */
export declare function getAgentSessionsDir(cfg: any, agentId: string): string;
export declare function loadOpenClawConfig(): any;
//# sourceMappingURL=config.d.ts.map