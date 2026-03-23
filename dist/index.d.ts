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
export default plugin;
export { getAccount, hasAccount, accountsCache };
//# sourceMappingURL=index.d.ts.map