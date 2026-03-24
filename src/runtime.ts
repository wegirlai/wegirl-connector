// src/runtime.ts - PluginRuntime 管理
import type { PluginRuntime } from "openclaw/plugin-sdk";
import type { PluginConfig } from "./types.js";

let runtime: PluginRuntime | null = null;
let config: PluginConfig | null = null;

export function setWeGirlRuntime(next: PluginRuntime) {
  runtime = next;
}

export function getWeGirlRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("WeGirl runtime not initialized");
  }
  return runtime;
}

// PluginConfig 全局存储
export function setWeGirlConfig(next: PluginConfig) {
  config = next;
}

export function getWeGirlConfig(): PluginConfig | null {
  return config;
}
