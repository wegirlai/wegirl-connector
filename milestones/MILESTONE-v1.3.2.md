# MILESTONE v1.3.2 — 移除事件驱动注册/注销

**发布日期**: 2026-05-24
**版本号**: 1.3.2
**标签**: `v1.3.2`

---

## 背景

wegirl-connector 有两套 agent 注册机制：

1. **初始化时 `syncAgentsFromLocal`** — 读取 `openclaw.json` 的 `bindings`，注册所有静态 agent，同时启动心跳
2. **事件驱动 `before_agent_start`** — 每个 agent 启动时触发，再次调用 `registerAgent`

`before_agent_start` 中的注册与初始化注册**功能重复**，但触发时机和覆盖范围不同：

| | `syncAgentsFromLocal` | `before_agent_start` |
|---|---|---|
| 触发 | 插件初始化一次 | 每个 agent 每次启动 |
| 来源 | `bindings` 配置 | 运行时事件 |
| 覆盖 | 有 wegirl binding 的静态 agent | 所有 agent（含动态 spawn） |
| 心跳 | ✅ 启动 | ✅ 启动 |

问题在于：
- 静态 agent 被注册了 **两次**（初始化 + 事件）
- 动态 agent 若无 wegirl binding，注册到 Redis 没有意义（外部消息不会路由给它）
- `agent_end` 中的 `unregisterAgent` 会在 **session 结束时** 删除 Redis staff，导致静态 agent 被误删

---

## 核心改动

### 1. `before_agent_start` 去掉 `registerAgent`

```typescript
// 之前
context.on('before_agent_start', async (event: any) => {
    const agentId = event?.agentId;
    const registry = getRegistry();
    if (agentId && registry) {
        await registry.registerAgent({ agentId, name: agentId, ... });
    }
    await persistEvent('before_agent_start', event, ctx);
});

// 现在
context.on('before_agent_start', async (event: any) => {
    // 静态 agent 已由 syncAgentsFromLocal + initRedis 注册
    // 动态 agent 若无 wegirl binding，无需注册
    await persistEvent('before_agent_start', event, ctx);
});
```

### 2. `agent_end` 去掉 `unregisterAgent`

```typescript
// 之前
context.on('agent_end', async (event: any) => {
    const agentId = event?.agentId;
    const registry = getRegistry();
    if (agentId && registry) {
        await registry.unregisterAgent(agentId);  // ❌ session 结束误删
    }
    await persistEvent('agent_end', event, ctx);
});

// 现在
context.on('agent_end', async (event: any) => {
    // 静态 agent 生命周期由 syncAgentsFromLocal 管理
    await persistEvent('agent_end', event, ctx);
});
```

---

## 注册流程图

### 之前（重复 + 误删）

```
插件初始化
  └── syncAgentsFromLocal ──► redis.hset(staff:hr) ──► 启动心跳 ✅
  └── registry.register() ──► redis.hset(staff:hr) ──► 启动心跳 ✅（重复）

hr agent 启动
  └── before_agent_start ──► registry.registerAgent() ──► redis.hset(staff:hr) ──► 启动心跳 ❌（重复）

hr agent session 结束
  └── agent_end ──► registry.unregisterAgent() ──► redis.del(staff:hr) ❌（误删）

下次 syncAgentsFromLocal
  └── 发现 hr 不在 Redis ──► 重新注册 ✅（修复）
```

### 现在（单一来源）

```
插件初始化
  └── syncAgentsFromLocal ──► redis.hset(staff:hr) ──► 启动心跳 ✅
  └── registry.register() ──► redis.hset(staff:hr) ──► 启动心跳 ✅（覆盖写，字段补全）

hr agent 启动/结束
  └── before_agent_start/agent_end ──► 仅 persistEvent ✅（无 Redis 操作）

心跳持续更新 lastHeartbeat
```

---

## 影响范围

- `src/event-handlers.ts` — 两个事件处理器简化
- 其他文件无改动

---

## 配套说明

- 动态 agent（`sessions_spawn`）若有 wegirl binding，需在 `openclaw.json` 中配置 binding，由 `syncAgentsFromLocal` 统一注册
- 无 wegirl binding 的动态 agent 不在 Redis 中注册，符合预期（外部消息不会路由到它们）
- `dist/` 已重新构建

---

## 相关 Commit

- `src/event-handlers.ts` — 移除 `before_agent_start` 的 `registerAgent` 和 `agent_end` 的 `unregisterAgent`
