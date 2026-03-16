let runtime = null;
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
// Redis publisher 全局存储
export function setWeGirlPublisher(pub) {
    publisher = pub;
}
export function getWeGirlPublisher() {
    return publisher;
}
//# sourceMappingURL=runtime.js.map