# MILESTONE-v1.0.3

## 版本信息
- **版本号**: v1.0.3
- **发布日期**: 2026-04-09
- **变更类型**: 稳定性优化与日志改进

## 主要变更

### 1. 消息去重机制 (sessions-send.ts)
- **问题**: 在某些情况下，消息可能被重复发送
- **解决**: 添加消息去重缓存机制
  - 使用 `Set` 缓存最近发送的消息 ID（最多 1000 条）
  - 基于消息 ID 和内容哈希进行去重检查
  - 对群聊和单聊消息分别进行去重

### 2. 日志格式优化 (event-handlers.ts)
- **改进**: 所有日志添加 `instanceId` 前缀
- **效果**: 便于在多实例环境中追踪和调试
- **影响范围**: 
  - Agent 注册/注销日志
  - 事件处理日志（message_received, message_sent 等）
  - Tool 调用日志（before_tool_call, after_tool_call）

### 3. 消息处理语义优化 (monitor.ts)
- **变更**: 从 at-most-once 改为 at-least-once 语义
- **处理顺序调整**:
  ```
  旧流程: 处理消息 → 确认消息 (XACK)
  新流程: 确认消息 (XACK) → 处理消息
  ```
- **优势**:
  - 防止 Agent 处理卡住时消息一直 pending
  - 即使处理失败，消息也不会无限重试
  - 提升系统整体吞吐量

## 技术细节

### 消息去重实现
```typescript
const sentMessageIds = new Set<string>();
const MAX_CACHE_SIZE = 1000;

function isDuplicateMessage(messageId: string): boolean {
  if (sentMessageIds.has(messageId)) return true;
  sentMessageIds.add(messageId);
  // LRU 淘汰策略
  if (sentMessageIds.size > MAX_CACHE_SIZE) {
    const firstKey = sentMessageIds.values().next().value;
    sentMessageIds.delete(firstKey);
  }
  return false;
}
```

### At-Least-Once 语义
```typescript
// 先确认消息
await redis.xack(streamKey, consumerGroup, id);

// 再处理消息（即使失败也不阻塞）
try {
  await wegirlSessionsSend({...});
} catch (processErr) {
  // 记录错误但不阻塞
  log?.error?.(`Processing failed:`, processErr.message);
}
```

## 兼容性
- **向下兼容**: 完全兼容 v1.0.2
- **API 变更**: 无破坏性变更
- **配置变更**: 无需修改配置

## 升级指南
```bash
# 1. 拉取最新代码
git pull origin main

# 2. 重新构建
npm run build

# 3. 重启 OpenClaw Gateway
openclaw gateway restart
```

## 测试建议
1. 验证消息不再重复发送
2. 检查日志中是否正确显示 instanceId
3. 测试 Agent 卡住时消息是否正常流转

## 相关提交
- 消息去重: `src/core/sessions-send.ts`
- 日志优化: `src/event-handlers.ts`
- 处理语义: `src/monitor.ts`
