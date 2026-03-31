# MILESTONE-v2.1.8.md

## WeGirl Connector v2.1.8

### 发布日期
2026-03-31

### 修复

#### 🐛 修复跨实例消息发送格式问题
- **Stream 格式修复**: 统一跨实例消息发送格式，将完整消息作为 JSON 字符串放入 `data` 字段
- **Stream Key 修复**: 修复发送端和消费端 Stream key 不一致问题 (`stream:instance:` → `stream:global:`)
- **消费端兼容性**: 确保消费端能正确解析 `data` 字段中的消息内容

#### 🔧 代码重构
- **使用标准 API**: `sessions-send.ts` 改用 `dispatchReplyWithBufferedBlockDispatcher` 标准流程
  - SDK 自动管理块缓冲和打字指示器
  - 代码从 ~600 行简化为 ~400 行
  - 与 Twitch/Zalo 等插件保持一致的行为
- **保留所有功能**: 在 `deliver` 回调中完整保留
  - Redis 同步等待响应回写
  - replyTo 多目标转发（支持媒体）
  - 群聊多 agent 聚合（支持媒体）
  - 错误处理和通知

### 技术细节

**Stream 消息格式统一:**
```typescript
// 发送端
const streamEntries = ['data', JSON.stringify(messageData)];
await redis.xadd(
  `wegirl:stream:global:${targetInstanceId}`, 
  'MAXLEN', '~', 5000,
  '*', 
  ...streamEntries
);

// 消费端
const fieldMap: Record<string, string> = {};
for (let i = 0; i < fields.length; i += 2) {
  fieldMap[fields[i]] = fields[i + 1];
}
if (fieldMap.data) {
  const data = JSON.parse(fieldMap.data);
  // 处理消息...
}
```

**标准流程实现:**
```typescript
// 1. resolveAgentRoute → 确定 agent 和 sessionKey
// 2. finalizeInboundContext → 构建 ctxPayload
// 3. createReplyPrefixOptions → 获取前缀选项 + onModelSelected
// 4. dispatchReplyWithBufferedBlockDispatcher → 发送并处理回复
// 5. deliver(payload) → 处理 Agent 回复
```

### 文件变更
- `src/core/send.ts` - 修复 Stream 消息格式和 key
- `src/core/sessions-send.ts` - 改用 `dispatchReplyWithBufferedBlockDispatcher` 标准流程

### 兼容性
- 完全向后兼容
- 修复后的消息格式与消费端期望一致
- 支持跨实例消息投递

---

**Full Changelog**: 对比 v2.1.7...v2.1.8
