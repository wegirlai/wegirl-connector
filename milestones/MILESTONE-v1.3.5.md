# MILESTONE v1.3.5 — 实例级别心跳

**发布日期**: 2026-05-24
**版本号**: 1.3.5
**标签**: `v1.3.5`

---

## 背景

之前的心跳机制：
- wegirl-connector 为每个 agent 维护独立的 `lastHeartbeat`
- wegirl-service 每 30s 遍历所有 agent，逐个检查 `lastHeartbeat`
- 超过 90s 未更新的 agent 标记 offline

问题：
- 一个 OpenClaw 实例下通常有多个 agent
- 实例存活 = 所有 agent 都存活；实例挂掉 = 所有 agent 都挂掉
- 逐个 agent 心跳是冗余操作，N 个 agent 产生 N 次 hset + N 次检查

---

## 核心改动

### wegirl-connector 端

#### 1. 去掉 agent 级别 `lastHeartbeat`

```typescript
// toKeep 分支（之前）
const updates = {
  lastHeartbeat: Date.now().toString(),  // ❌ 移除
  status: 'online'
};

// toKeep 分支（现在）
const updates = {
  status: 'online'
};
```

```typescript
// 新注册 agent（之前）
await redis.hset(`wegirl:staff:${accountId}`, {
  ...,
  lastHeartbeat: Date.now().toString(),  // ❌ 移除
  ...
});

// 新注册 agent（现在）
await redis.hset(`wegirl:staff:${accountId}`, {
  ...,  // 无 lastHeartbeat
  ...
});
```

#### 2. 新增实例级别心跳

```typescript
// syncAgentsFromLocal 最后统一设置
await redis.set(`wegirl:instance:${instanceId}:heartbeat`, Date.now().toString());
```

### wegirl-service 端

#### 心跳检测改为实例级别

```python
# 之前：遍历每个 agent
agent_ids = await redis.smembers("wegirl:staff:by-type:agent")
for staff_id in agent_ids:
    data = await redis.hgetall(f"wegirl:staff:{staff_id}")
    last_hb = int(data.get("lastHeartbeat"))
    # ... 逐个检查

# 现在：检查实例心跳
instance_keys = await redis.keys("wegirl:instance:*:heartbeat")
for instance_key in instance_keys:
    instance_id = instance_key.split(":")[-2]
    last_hb = int(await redis.get(instance_key))
    if elapsed > 90000:
        # 实例离线：批量标记该实例下所有 agent
        agent_ids = await redis.smembers(f"wegirl:instance:{instance_id}:staff")
        for staff_id in agent_ids:
            if data.get("status") == "online":
                offline_agents.append((staff_id, "instance heartbeat stale"))
```

---

## 最终注册流程

```
插件初始化
  └── syncAgentsFromLocal
        ├── toKeep:    redis.hset(status:online)           ✅ 更新状态
        ├── toRegister: redis.hset(all fields except heartbeat) ✅ 初始注册
        ├── toRemove:   cleanupAgentFromRedis()              ✅ 清理僵尸
        └── 最后:       redis.set(instance:{id}:heartbeat)   ✅ 实例心跳

心跳检测（wegirl-service）
  └── 每 30s: 检查 wegirl:instance:*:heartbeat
        ├── 实例在线 → 跳过
        └── 实例离线 → 批量标记该实例下所有 agent offline
```

---

## 影响文件

| 项目 | 文件 | 改动 |
|------|------|------|
| wegirl-connector | `src/index.ts` | `syncAgentsFromLocal` 去掉 agent `lastHeartbeat`，增加实例心跳 |
| wegirl-service | `src/wegirl_service/service.py` | `_heartbeat_check_loop` 改为实例级别检测 |

---

## 配套说明

- wegirl-connector `dist/` 已重新构建
- wegirl-service 需要重启以生效心跳检测逻辑变更

---

## 相关 Commit

- `src/index.ts` — 实例心跳 + 去掉 agent lastHeartbeat
- `wegirl-service/src/wegirl_service/service.py` — 心跳检测改为实例级别
