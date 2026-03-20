let runtime = null;
let config = null;
let publisher = null;
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
// Redis publisher 全局存储
export function setWeGirlPublisher(pub) {
    publisher = pub;
}
export function getWeGirlPublisher() {
    return publisher;
}
//# sourceMappingURL=runtime.js.map