# MILESTONE-v1.4.0.md - 自动清理 Worker + 并行消费架构

## 版本信息

- **版本**: 1.4.0
- **日期**: 2026-06-04
- **提交**: `v1.4.0: 自动清理 Worker + 并行消费架构`

## 核心功能

### 1. 🧹 Task Session 自动清理 Worker

**问题**: Agent 处理完带 `taskId` 的任务后，`.jsonl` session 文件会持续堆积，占用磁盘空间（如 scout 480 个 session 文件占用 134M）。

**方案**:
- 入队: `sessions-send.ts` dispatch 完成后，将 task session 推入 Redis ZSet 延迟队列
- 清理: `monitor.ts` 启动独立 Worker，每 30 秒扫描到期项
- 安全: 双重检查（文件 mtime ≥ 10 分钟 + sessions.json 存在性验证）

**实现细节**:
- 队列键: `wegirl:cleanup:sessions:{instanceId}`（按实例隔离）
- 队列项格式: `{sessionKey}|{agentId}`
- 最小保留: 10 分钟（`MIN_CLEANUP_AGE_MS = 10 * 60 * 1000`）
- 不删 sessions.json: 仅删除 `.jsonl` 文件，metadata 由 OpenClaw 自行 stale

### 2. ⚡ 多 Consumer 并行消费架构

**问题**: 单个 Stream Consumer 处理消息时可能遇到瓶颈，无法充分利用多核 CPU。

**方案**:
- 配置: `channels.wegirl.accounts.{accountId}.batchConsumers`（默认 1，最大 10）
- 隔离: 每个 Consumer 独立 Redis 连接，共享同一 Consumer Group
- 负载均衡: 同一 Consumer Group 内多个 Consumer 竞争消费，Redis 自动分配消息

### 3. 🔀 TaskId 自动生成 + Session 隔离

**问题**: 多 consumer 场景下，相同 `sessionKey` 的消息会被 collapse 到同一个 session，导致消息串扰。

**方案**:
- 自动生成: `consumerCount > 1` 且没有显式 `taskId` 时，自动生成 `auto:{uuid}`
- Session 隔离: taskId 存在时，生成 `agent:{agentId}:task:{taskId}` 作为独立 sessionKey
- 绕过 direct 模式的 collapse，确保每个任务有独立上下文

## 文件变更

| 文件 | 变更 | 说明 |
|------|------|------|
| `src/config.ts` | +24 行 | 新增 `getAccountBatchConsumers`、`getAgentSessionsDir` |
| `src/core/sessions-send.ts` | +43 行 | 多 consumer taskId 生成、清理入队 |
| `src/monitor.ts` | +265 行 | `startCleanupWorker` 完整清理逻辑 |
| `dist/*` | 自动编译 | TypeScript 编译输出 |

## 影响范围

- **OpenClaw Gateway**: 重启后生效（`openclaw gateway restart`）
- **wegirl-service**: 无影响（按现有协议消费）
- **Redis**: 新增 `wegirl:cleanup:sessions:{instanceId}` ZSet 键

## 验证方式

1. 启动 Gateway 后检查日志: `[WeGirl Cleanup:{instanceId}] Worker started`
2. 触发带 taskId 的任务后检查 Redis: `ZCARD wegirl:cleanup:sessions:{instanceId}`
3. 10 分钟后检查日志: `[WeGirl Cleanup:{instanceId}] Deleted {sessionId}.jsonl`

## 向后兼容

- ✅ 默认 `batchConsumers = 1`，行为不变
- ✅ 无 taskId 的单聊/群聊不受清理影响
- ✅ 所有变更均为**新增**，不修改现有 API/协议
