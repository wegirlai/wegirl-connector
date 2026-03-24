let runtime = null;
let config = null;
export function setWeGirlRuntime(next) {
    runtime = next;
}
export function getWeGirlRuntime() {
    if (!runtime) {
        throw new Error("WeGirl runtime not initialized");
    }
    return runtime;
}
// PluginConfig 全局存储
export function setWeGirlConfig(next) {
    config = next;
}
export function getWeGirlConfig() {
    return config;
}
//# sourceMappingURL=runtime.js.map