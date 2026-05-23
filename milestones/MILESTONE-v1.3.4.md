# MILESTONE v1.3.4 — 移除 Registry 定时心跳

**发布日期**: 2026-05-24
**版本号**: 1.3.4
**标签**: `v1.3.4`

---

## 背景

wegirl-connector 的 agent 注册流程经历了以下清理：

| 版本 | 改动 | 心跳 |
|------|------|------|
| v1.3.1 | 修复字段缺失 + 双格式检测 | `syncAgentsFromLocal` 初始注册 + `registry.register()` 重复覆盖 + `before_agent_start` 重复覆盖 |
| v1.3.2 | 移除事件驱动注册/注销 | `syncAgentsFromLocal` 初始注册 + `registry.register()` 重复覆盖 |
| v1.3.3 | 移除 initRedis 中 `registry.register()` | `syncAgentsFromLocal` 初始注册 + `registry.startHeartbeat()` 定时心跳 |
| v1.3.4 | 移除 `registry.startHeartbeat()` | `syncAgentsFromLocal` 初始注册 **（无定时心跳）** |

定时心跳的核心逻辑：
- 每 30s 更新 Redis 中 `lastHeartbeat` 字段
- `wegirl-service` 心跳检测器每 30s 扫描，超过 90s 未更新标记 offline

但 `syncAgentsFromLocal` 初始化时已设置 `lastHeartbeat`，agent 实际处理消息时 `wegirl-service` 不需要依赖这个字段判断在线——OpenClaw 实例存活即 agent 存活。

---

## 核心改动

### 1. 移除 Registry 心跳相关全部代码

```typescript
// 移除以下方法和属性
- heartbeatTimers: Map<string, NodeJS.Timeout>
- heartbeat(staffId, load?)
- startHeartbeat(staffId, instanceId)
- registerStaff() 中的 startHeartbeat 调用
- unregisterStaff() 中的 heartbeatTimers 清理
- destroy() 中的 heartbeatTimers 清理
- HEARTBEAT_INTERVAL 常量
```

### 2. initRedis 中不再启动心跳

```typescript
// 之前
registry = new Registry(redisClient, INSTANCE_ID, logger);
for (const agent of localAgents) {
    registry!.startHeartbeat(agent.accountId, INSTANCE_ID);
}

// 现在
registry = new Registry(redisClient, INSTANCE_ID, logger);
// 无额外操作，syncAgentsFromLocal 已完成初始注册
```

---

## Registry 保留的方法

| 方法 | 用途 |
|------|------|
| `registerStaff()` | 注册 staff 到 Redis（含索引更新） |
| `registerAgent()` | 向后兼容 wrapper |
| `registerHuman()` | 向后兼容 wrapper |
| `register()` | 简化 wrapper |
| `unregisterStaff()` | 从 Redis 删除 staff（含索引清理） |
| `getStaff()` | 查询单个 staff |
| `findStaffByCapability()` | 按能力查找 staff |
| `getInstanceStaff()` | 获取实例下所有 staff |
| `getOnlineStaff()` | 获取所有在线 staff |
| `cleanupExpiredStaff()` | 清理过期 staff（辅助，由 wegirl-service 主控） |
| `flattenObject()` / `unflattenObject()` | 序列化工具 |

---

## 最终注册流程

```
插件初始化
  └── syncAgentsFromLocal
        ├── toKeep:    redis.hset(heartbeat + status)    ✅ 更新心跳
        ├── toRegister: redis.hset(all fields)           ✅ 初始注册
        └── toRemove:   cleanupAgentFromRedis()          ✅ 清理僵尸

Agent 启动/结束
  └── before_agent_start / agent_end
        └── persistEvent() only                        ✅ 无 Redis 操作

Registry 存活
  └── 提供查询和注册 API（无定时心跳）
```

---

## 影响文件

| 文件 | 改动 |
|------|------|
| `src/registry.ts` | 移除 heartbeat()、startHeartbeat()、heartbeatTimers、HEARTBEAT_INTERVAL |
| `src/index.ts` | 移除 initRedis 中的 startHeartbeat() 循环 |

---

## 配套说明

- `dist/` 已重新构建（`npm run build`）
- `wegirl-service` 心跳检测器仍然运行，但 agent 初始 `lastHeartbeat` 由 `syncAgentsFromLocal` 设置，后续由消息处理自然更新（如果 `wegirl-service` 有消息触发更新的话）
- 如需恢复心跳，可在 `syncAgentsFromLocal` 的 `toKeep` 分支中增加定期更新逻辑

---

## 相关 Commit

- `src/registry.ts` — 移除心跳相关方法和定时器
- `src/index.ts` — 移除 initRedis 中的 startHeartbeat() 循环
