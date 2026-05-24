# MILESTONE v1.3.6 - 心跳 key 简化 + 注册逻辑清理

**日期**: 2026-05-24

---

## 变更摘要

### 1. 心跳 key 简化

将原来分散的两个 key 合并为单一 TTL key：

- **移除**: `wegirl:instance:{id}:heartbeat` (TTL String)
- **移除**: `wegirl:instance:{id}` (元数据 Hash)
- **新增**: `wegirl:heartbeat:{instanceId}` (TTL String, EX 90)

**设计原因**:
- 元数据 Hash 实际上从未被查询过，心跳检测只需要判断 "实例是否存活"
- `EXISTS wegirl:heartbeat:{id}` 是最简洁的检测方式：key 存在 = 存活，key 过期消失 = 挂了
- 减少 Redis key 数量，降低维护复杂度

### 2. wegirl-service 心跳检测逻辑更新

- 扫描 `wegirl:instance:*:staff` 获取所有实例
- 对每个实例检查 `EXISTS wegirl:heartbeat:{instanceId}`
- key **不存在** → 该实例挂了 → 遍历实例 staff 集合，批量标记所有 `type=agent && status=online` 为 offline
- 同步更新 Redis (`wegirl:staff:{id}`) 和 MySQL (`Agent.status`)

### 3. 清理 connector 端冗余注册/心跳逻辑

- **移除** `Registry` 类中的注册方法：`registerStaff`、`registerAgent`、`registerHuman`、`register`
- **移除** `Registry` 类中的 `cleanupExpiredStaff`（心跳检测完全由 service 端负责）
- **移除** `WeGirlTools.register()` 方法（旧式 `agents:` key 注册）
- **移除** `index.ts` 中 `Registry` 实例的创建和引用
- 保留 `Registry` 的查询方法（`getStaff`、`findStaffByCapability` 等）和注销方法（`unregisterStaff`），供 `syncAgentsFromLocal` 清理僵尸 agent 使用

### 4. `syncAgentsFromLocal` 成为唯一注册入口

现在 **只有这一个地方** 做三件事：
1. 清理僵尸 agent（`toRemove`）
2. 注册新 agent（`toRegister`）
3. 写入实例心跳（`SET wegirl:heartbeat:{instanceId} ... EX 90`）

---

## 影响文件

| 文件 | 变更 |
|------|------|
| `src/index.ts` | 心跳 key 改为 `wegirl:heartbeat:`；移除 Registry import 和实例创建 |
| `src/registry.ts` | 移除注册方法和 cleanupExpiredStaff，保留查询/注销 |
| `src/tools.ts` | 移除 `register()` 方法；`query()`/`broadcast()` 统一使用 `staff:` key |
| `src/event-handlers.ts` | 更新注释说明注册统一由 syncAgentsFromLocal 完成 |
| `wegirl-service/service.py` | `_heartbeat_check_loop` 改为 EXISTS 检查 |

---

## 兼容性

- Redis key 变更不影响已有 staff 数据（`wegirl:staff:{id}` 和 `wegirl:instance:{id}:staff` 保持不变）
- wegirl-service 重启后自动检测旧实例缺失心跳并标记 offline
- connector 重启后（gateway 重启）自动写入新心跳 key
