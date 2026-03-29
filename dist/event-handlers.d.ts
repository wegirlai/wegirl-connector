import type { PluginContext, PluginConfig } from './types.js';
import type Redis from 'ioredis';
import type { Registry } from './registry.js';
interface EventHandlerContext {
    context: PluginContext;
    logger: any;
    pluginConfig?: PluginConfig;
    getRedisClient: () => Redis | null;
    getRegistry: () => Registry | null;
    instanceId: string;
}
/**
 * 重置事件处理器注册状态（用于插件热重载后重新注册）
 */
export declare function resetEventHandlers(): void;
/**
 * 注册所有 OpenClaw 事件处理器
 */
export declare function registerEventHandlers(ctx: EventHandlerContext, force?: boolean): void;
export {};
//# sourceMappingURL=event-handlers.d.ts.map