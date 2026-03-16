// src/runtime.ts - PluginRuntime 管理
import type { PluginRuntime } from "openclaw/plugin-sdk";

let runtime: PluginRuntime | null = null;
let publisher: any = null;

export function setWeGirlRuntime(next: PluginRuntime) {
  runtime = next;
}

export function getWeGirlRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("WeGirl runtime not initialized");
  }
  return runtime;
}

// Redis publisher 全局存储
export function setWeGirlPublisher(pub: any) {
  publisher = pub;
}

export function getWeGirlPublisher(): any {
  return publisher;
}
