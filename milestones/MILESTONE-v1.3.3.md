# MILESTONE v1.3.3 — 移除 initRedis 中的重复注册循环

**发布日期**: 2026-05-24
**版本号**: 1.3.3
**标签**: `v1.3.3`

---

## 背景

wegirl-connector 的 agent 注册经历了从**三重冗余**到**单一来源**的清理：

### v1.3.2 之前的三重注册

```
插件初始化
  ├── syncAgentsFromLocal ──► redis.hset(staff:hr)          ✅ 初始注册
  ├── registry.register()   ──► redis.hset(staff:hr)          ❌ 重复覆盖
  └── before_agent_start   ──► registry.registerAgent()     ❌ 重复覆盖
```

### v1.3.2 去掉 before_agent_start 后

```
插件初始化
  ├── syncAgentsFromLocal ──► redis.hset(staff:hr)          ✅ 初始注册
  └── registry.register()   ──► redis.hset(staff:hr)        ❌ 仍重复
```

`registry.register()` 循环仍然**重复写 Hash**，因为 `syncAgentsFromLocal` 已经直接 `redis.hset` 写入了所有字段（`staffId`/`type`/`name`/`capabilities`/`maxConcurrent`/`status`/`lastHeartbeat`/`load:*`）。

`registry.register()` 再走一遍 `flattenObject(RegistryEntry)` 写同样的 key，完全是多余的。

---

## 核心改动

### 1. initRedis 中去掉 `registry.register()` 循环

```typescript
// 之前（重复覆盖）
const localAgents = await getLocalAgents(logger);
for (const agent of localAgents) {
    if (agent?.accountId) {
        await registry!.register({
            staffId: agent.accountId,
            name: agent.name || agent.accountId,
            type: 'agent',
            instanceId: INSTANCE_ID
        });
    }
}

// 现在（只启动心跳）
const localAgents = await getLocalAgents(logger);
for (const agent of localAgents) {
    if (agent?.accountId) {
        registry!.startHeartbeat(agent.accountId, INSTANCE_ID);
    }
}
```

### 2. Registry.startHeartbeat 改为 public

```typescript
// 之前
private startHeartbeat(staffId: string, instanceId: string): void { ... }

// 现在
startHeartbeat(staffId: string, instanceId: string): void { ... }
```

### 3. 清理 event-handlers.ts 残留

`before_agent_start`/`agent_end` 已去掉 registry 调用，`getRegistry` 参数和 `Registry` import 变成死代码：

```typescript
// 移除
import type { Registry } from './registry.js';       // ❌ 不再使用

interface EventHandlerContext {
    getRegistry: () => Registry | null;             // ❌ 不再使用
}

const { getRegistry } = ctx;                         // ❌ 不再使用
```

---

## 最终注册流程

```
插件初始化
  ├── syncAgentsFromLocal
  │     ├── toKeep:    redis.hset(heartbeat)          ✅ 更新心跳
  │     ├── toRegister: redis.hset(all fields)         ✅ 初始注册
  │     └── toRemove:   cleanupAgentFromRedis()       ✅ 清理僵尸
  └── registry = new Registry(...)
        └── startHeartbeat() for each agent             ✅ 定时心跳（30s）

Agent 启动/结束
  └── before_agent_start / agent_end
        └── persistEvent() only                       ✅ 无 Redis 操作

心跳持续运行
  └── 每 30s: redis.hset(lastHeartbeat, status:online)  ✅ 防止被 wegirl-service 标记 offline
```

---

## 影响文件

| 文件 | 改动 |
|------|------|
| `src/index.ts` | `registry.register()` → `registry.startHeartbeat()` |
| `src/registry.ts` | `startHeartbeat` private → public |
| `src/event-handlers.ts` | 移除 `getRegistry` 参数和 `Registry` import |

---

## 配套说明

- `dist/` 已重新构建（`npm run build`）
- 向后兼容：Redis Hash 字段不变，只是去掉了重复写

---

## 相关 Commit

- `src/index.ts` — initRedis 中 `register()` 改为 `startHeartbeat()`
- `src/registry.ts` — `startHeartbeat` 改为 public
- `src/event-handlers.ts` — 移除 `getRegistry` 和 `Registry` import
