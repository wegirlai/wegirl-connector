// src/config.ts - 全局配置管理
import { readFileSync } from 'fs';
import { join } from 'path';
// 全局配置缓存
let globalConfig = null;
let configLoadTime = 0;
const CONFIG_CACHE_TTL = 5000; // 5秒缓存
/**
 * 从 openclaw.json 加载配置
 */
function loadConfigFromFile() {
    try {
        const configPath = join(process.env.HOME || '/root', '.openclaw', 'openclaw.json');
        const content = readFileSync(configPath, 'utf-8');
        return JSON.parse(content);
    }
    catch (err) {
        console.error('[WeGirl Config] Failed to load config:', err.message);
        return null;
    }
}
/**
 * 初始化全局配置
 * 在插件启动时调用一次
 */
export function initGlobalConfig(cfg) {
    if (cfg) {
        globalConfig = cfg;
    }
    else {
        globalConfig = loadConfigFromFile();
    }
    configLoadTime = Date.now();
    console.log('[WeGirl Config] Global config initialized');
}
/**
 * 获取全局配置
 * 如果未初始化，会自动加载
 */
export function getGlobalConfig() {
    if (!globalConfig) {
        initGlobalConfig();
    }
    return globalConfig;
}
/**
 * 设置全局配置
 * 用于 startAccount 等场景直接传入 cfg
 */
export function setGlobalConfig(cfg) {
    globalConfig = cfg;
    configLoadTime = Date.now();
    console.log('[WeGirl Config] Global config set from external source');
}
/**
 * 获取 wegirl 插件配置
 *
 * 合并 plugins.entries.wegirl.config 和 channels.wegirl 的配置，
 * channel 配置优先级更高（覆盖 plugin 配置）。
 * 这样 ragApiUrl 等配置无论写在 plugin 还是 channel 段都能被正确读取。
 */
export function getWeGirlPluginConfig() {
    const cfg = getGlobalConfig();
    const pluginConfig = cfg?.plugins?.entries?.wegirl?.config || {};
    const channelConfig = cfg?.channels?.wegirl || {};
    // 合并：channel 配置覆盖 plugin 配置
    return {
        ...pluginConfig,
        ...channelConfig,
    };
}
/**
 * 获取 Redis 配置
 */
export function getRedisConfig() {
    const pluginCfg = getWeGirlPluginConfig();
    return {
        url: pluginCfg?.redisUrl || 'redis://localhost:6379',
        password: pluginCfg?.redisPassword,
        db: pluginCfg?.redisDb ?? 1,
    };
}
/**
 * 获取 RAG API 配置
 */
export function getRagApiConfig() {
    const pluginCfg = getWeGirlPluginConfig();
    return {
        url: pluginCfg?.ragApiUrl || 'http://localhost:4001',
        timeout: pluginCfg?.ragApiTimeout || 10000,
    };
}
/**
 * 获取实例 ID
 */
export function getInstanceId() {
    const pluginCfg = getWeGirlPluginConfig();
    return pluginCfg?.instanceId || 'instance-local';
}
// 兼容旧接口：loadOpenClawConfig
export function loadOpenClawConfig() {
    return getGlobalConfig();
}
//# sourceMappingURL=config.js.map