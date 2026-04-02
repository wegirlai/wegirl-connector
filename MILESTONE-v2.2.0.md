# MILESTONE-v2.2.0.md

## WeGirl Connector v2.2.0

### 发布日期
2026-04-02

### 重大架构变更

#### 🏗️ 独立 Stream 架构（Feishu Mode）
- **每个 agent 拥有独立的 Redis Stream**
  - 格式：`wegirl:stream:{instanceId}:{accountId}`
  - 示例：`wegirl:stream:instance-local:hr`
- **天然顺序消费**：单 Stream + 单消费者组 = 严格顺序保证
- **物理隔离**：消息直接写入目标 agent 的 Stream，无广播浪费

#### 🧹 移除冗余并发控制
- **删除内存队列**：`agentQueues`、`agentProcessing` Map
- **删除 Session Lock 机制**：`waitForSessionLock`、`hasSessionLock`
- **简化调用链**：`wegirlSessionsSend` 直接调用 `processMessage`
- **代码精简**：减少 ~110 行，从 ~600 行降至 ~490 行

### 架构对比

#### 之前（v2.1.x）：全局 Stream + 多消费者组
```
所有消息 → wegirl:stream:global:instance1
                              ├── 消费者组1 (hr) → 过滤丢弃非 hr 消息
                              ├── 消费者组2 (scout) → 过滤丢弃非 scout 消息
                              └── 消费者组3 (analyst) → 过滤丢弃非 analyst 消息
```
- 问题：一条消息被读取 N 次（N = agent 数量）

#### 现在（v2.2.0）：独立 Stream
```
消息 for hr → wegirl:stream:instance1:hr      → hr 消费
消息 for scout → wegirl:stream:instance1:scout  → scout 消费
消息 for analyst → wegirl:stream:instance1:analyst → analyst 消费
```
- 优势：消息只被目标 agent 读取一次

### 并发安全验证

#### 测试场景
- 同时发送 3 条消息给同一 agent
- 消息包含阻塞式任务（crawl.py 执行）

#### 测试结果
| Routing ID | 接收时间 | 间隔 |
|------------|----------|------|
| test-crawl-001 | 00:55:19 | - |
| test-crawl-002 | 00:55:49 | +30s |
| test-crawl-003 | 00:56:15 | +26s |

#### 结论
- OpenClaw 内部自动串行化处理
- 单 session 内不会真正并发
- 去掉内存队列后仍安全

### 技术细节

#### Stream 消费代码
```typescript
// 每个 agent 独立的消费循环
const streamKey = `wegirl:stream:${instanceId}:${accountId}`;
const consumerGroup = `wegirl-consumers-${instanceId}`;

while (!abortSignal?.aborted) {
  const result = await redis.xreadgroup(
    'GROUP', consumerGroup, consumerName,
    'BLOCK', 5000,
    'COUNT', 1,        // 每次只读 1 条，保证顺序
    'STREAMS', streamKey, '>'
  );
  
  // 处理消息...
  await processMessage(msg);
  await redis.xack(streamKey, consumerGroup, id);
}
```

#### 简化后的调用链
```typescript
// wegirl_send → 本地/跨实例判断
//  ├─ 跨实例 → 写入目标 Stream
//  └─ 本地 → wegirlSessionsSend → processMessage
//       └─ dispatchReplyWithBufferedBlockDispatcher
```

### 文件变更
- `src/core/sessions-send.ts` - 移除内存队列和锁机制
- `src/monitor.ts` - 独立 Stream 消费逻辑

### 破坏性变更
- **无**：完全向后兼容
- 消息格式不变
- API 不变

### 性能提升
- 减少无效消息读取（N 倍 → 1 倍）
- 降低 Redis 负载
- 简化代码维护

---

**Full Changelog**: 对比 v2.1.8...v2.2.0
