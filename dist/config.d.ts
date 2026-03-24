/**
 * 初始化全局配置
 * 在插件启动时调用一次
 */
export declare function initGlobalConfig(cfg?: any): void;
/**
 * 获取全局配置
 * 如果未初始化，会自动加载
 */
export declare function getGlobalConfig(): any;
/**
 * 设置全局配置
 * 用于 startAccount 等场景直接传入 cfg
 */
export declare function setGlobalConfig(cfg: any): void;
/**
 * 获取 wegirl 插件配置
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
 * 获取实例 ID
 */
export declare function getInstanceId(): string;
export declare function loadOpenClawConfig(): any;
//# sourceMappingURL=config.d.ts.map