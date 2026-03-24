import type { PluginContext } from './types.js';
declare let accountsCache: Map<string, any>;
/**
 * 获取 account 信息
 */
declare function getAccount(staffId: string): any | undefined;
/**
 * 检查 account 是否存在
 */
declare function hasAccount(staffId: string): boolean;
declare const plugin: {
    id: string;
    name: string;
    description: string;
    register(context: PluginContext): void;
};
/**
 * 注册 agent 就绪状态
 * 由 channel.ts 的 startAccount 调用
 */
export declare function registerAgentReady(accountId: string, sessionKey: string, logger?: any): void;
/**
 * 注销 agent 就绪状态
 * 由 channel.ts 的 stopAccount 调用
 */
export declare function unregisterAgentReady(accountId: string, logger?: any): void;
/**
 * 获取 agent 的 session key
 */
export declare function getAgentSessionKey(accountId: string): string | undefined;
export default plugin;
export { getAccount, hasAccount, accountsCache };
//# sourceMappingURL=index.d.ts.map