# MILESTONE v1.3.1 — 同步字段补全 + 双格式检测修复

**发布日期**: 2026-05-23
**版本号**: 1.3.1
**标签**: `v1.3.1`

---

## 背景

在排查 Redis staff 字段完整性时发现两个问题：

### 问题 1：`syncAgentsFromLocal` 字段缺失

`Registry.registerStaff` 写入的完整字段包含 `maxConcurrent`，但 `syncAgentsFromLocal` 中直接 `redis.hset` 时漏写了 `maxConcurrent`：

```typescript
// Registry.registerStaff 写入的字段（完整）
staffId, type, instanceId, name, capabilities, maxConcurrent, status, lastHeartbeat, load:activeTasks, load:pendingTasks

// syncAgentsFromLocal 写入的字段（缺失 maxConcurrent）
staffId, type, instanceId, role, name, capabilities, status, lastHeartbeat, load:activeTasks, load:pendingTasks
```

这导致通过 `syncAgentsFromLocal` 新注册的 agent 在 Redis 中缺少 `maxConcurrent`，`Registry.getStaff()` 反序列化后 `maxConcurrent` 为 `undefined`。

### 问题 2：双格式检测误匹配

OpenClaw 配置格式为：
```json
{
  "agents": {
    "defaults": { ... },
    "list": [ { "id": "main" }, ... ]
  }
}
```

旧代码用 `agentIds.length === 1 && agentIds[0] === 'list'` 来判断是否为 openclaw 格式，但当 `agents` 同时有 `defaults` 和 `list` 两个 key 时，`length === 1` 为 false，代码走 `else` 分支误将 `defaults` 和 `list` 当作 openllm 格式的 agent id，导致 Redis 中出现 `wegirl:staff:defaults` 和 `wegirl:staff:list` 这两个错误 staff。

---

## 核心改动

### 1. syncAgentsFromLocal 字段补全

新注册 agent 时添加 `maxConcurrent: '3'`：

```typescript
await redis.hset(`${KEY_PREFIX}staff:${accountId}`, {
  staffId: accountId,
  type: 'agent',
  instanceId: instanceId,
  role: '-',
  name: agentName,
  capabilities: agentCapabilities.join(','),
  maxConcurrent: '3',        // ← 新增
  status: 'online',
  lastHeartbeat: Date.now().toString(),
  'load:activeTasks': '0',
  'load:pendingTasks': '0'
});
```

### 2. toKeep 分支字段补全

已存在 agent 更新心跳时，若缺少 `maxConcurrent` 自动补全：

```typescript
const updates: Record<string, string> = {
  lastHeartbeat: Date.now().toString(),
  status: 'online'
};
if (staffData.maxConcurrent === undefined || staffData.maxConcurrent === '') {
  updates.maxConcurrent = '3';
}
await redis.hset(`${KEY_PREFIX}staff:${accountId}`, updates);
```

### 3. 双格式检测统一修复

三个文件统一使用以下判断逻辑：

```typescript
const isOpenclawFormat = Array.isArray(config.agents?.list);
const isOpenllmFormat = config.agents 
  && typeof config.agents === 'object' 
  && !Array.isArray(config.agents) 
  && !isOpenclawFormat;
```

**涉及文件**:
- `src/index.ts` — `getLocalAgents`
- `src/hr-message-handler.ts` — `checkIsAgent`
- `src/hr-manage-core.ts` — `checkAgentExists`

---

## 验证结果

运行检查脚本验证当前 Redis 中所有 12 个 agent 的字段完整性：

```
[CHECK] quartermaster: ✅ maxConcurrent=3, role=-, load:active=true, ...
[CHECK] kmsdev:        ✅ maxConcurrent=3, role=-, load:active=true, ...
[CHECK] wegirl001:     ✅ maxConcurrent=3, role=-, load:active=true, ...
...
[SUMMARY] OK=12, Zombies=0, Missing=0
```

所有 agent 字段完整，无僵尸 staff，无缺失 staff。

---

## 配套说明

- 本次改动**纯插件侧**，无需升级 `wegirl-service`
- 已清理 Redis 中的错误 staff（`defaults`、`list`、`cto`）
- `dist/` 已重新构建（`npm run build`）

---

## 相关 Commit

- `src/index.ts` — `syncAgentsFromLocal` 字段补全 + `getLocalAgents` 双格式判断
- `src/hr-message-handler.ts` — `checkIsAgent` 双格式判断
- `src/hr-manage-core.ts` — `checkAgentExists` 双格式判断
