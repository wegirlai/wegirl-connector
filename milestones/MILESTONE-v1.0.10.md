# MILESTONE v1.0.10

**发布日期**: 2025-07-02

## 核心变更

### 1. messageId 全链路追踪机制

**问题背景**: 消息在 wegirl_send → Agent → wegirl-connector 回复 的流转过程中缺乏统一标识，难以追踪和排查问题。

**解决方案**: 引入消息 ID 生成策略，贯穿整个消息生命周期。

#### ID 生成规则

| 阶段 | 前缀 | 含义 | 示例 |
|------|------|------|------|
| 转发 | `CNS` | Connector Send | `A2A_CNS_wegirl001_1751443200123-abc123` |
| 回复 | `CNR` | Connector Reply | `A2A_CNR_wegirl001_1751443200456-def456` |

**生成函数**:
```typescript
// 转发时生成（wegirl_send）
function generateSendMessageId(flowType: string): string {
  const instanceId = getCurrentInstanceId();
  const uuid = `${Date.now()}-${Math.random().toString(36).substring(2, 10)}`;
  return `${flowType}_CNS_${instanceId}_${uuid}`;
}

// 回复时生成（handleAgentReply）
function generateReplyMessageId(flowType: string): string {
  const instanceId = getCurrentInstanceId();
  const uuid = `${Date.now()}-${Math.random().toString(36).substring(2, 10)}`;
  return `${flowType}_CNR_${instanceId}_${uuid}`;
}
```

**流转流程**:
1. 用户发送消息 → 飞书 `message_id` 传入
2. wegirl_send → 生成 `{flowType}_CNS_{instanceId}_{uuid}`
3. processMessage → 保留 messageId
4. Agent 处理 → 生成回复
5. handleAgentReply → 生成新的 `{flowType}_CNR_{instanceId}_{uuid}`
6. 消息返回给用户

**影响文件**:
- `src/core/send.ts` - `wegirlSend` 函数添加 ID 生成和传递
- `src/core/sessions-send.ts` - `processMessage` 和 `handleAgentReply` 传递 messageId
- `src/core/types.ts` - `WeGirlSendOptions` 添加 `messageId` 字段
- `src/core/utils.ts` - `MessageBuilderOptions` 和 `buildMessage` 添加 messageId 支持
- `src/monitor.ts` - Stream 消费时传递 messageId

### 2. 配置合并增强

**问题背景**: `ragApiUrl` 等配置放在 `channels.wegirl` 段时无法被正确读取，只能放在 `plugins.entries.wegirl.config` 中。

**解决方案**: `getWeGirlPluginConfig` 函数现在会合并两个配置源，**channel 配置优先级更高**。

**配置读取优先级**（从高到低）:
1. `channels.wegirl.ragApiUrl` (channel 配置，最高优先级)
2. `plugins.entries.wegirl.config.ragApiUrl` (plugin 配置)
3. 环境变量
4. 默认值

**代码实现**:
```typescript
export function getWeGirlPluginConfig(): any {
  const cfg = getGlobalConfig();
  const pluginConfig = cfg?.plugins?.entries?.wegirl?.config || {};
  const channelConfig = cfg?.channels?.wegirl || {};
  
  // 合并：channel 配置覆盖 plugin 配置
  return {
    ...pluginConfig,
    ...channelConfig,
  };
}
```

**影响文件**:
- `src/config.ts` - `getWeGirlPluginConfig` 函数

## 兼容性

- ✅ 向后兼容：未传入 messageId 时自动生成
- ✅ 配置合并：原有配置无需修改
- ✅ 无破坏性变更

## 日志增强

所有相关日志现在会包含 messageId:
```
=====>[WeGirlSend] Options: {...}, sync=true, timeout=30s, messageId=A2A_CNS_wegirl001_1751443200123-abc123
[handleAgentReply] Processing reply: target=hr, text=..., mediaCount=0, originalMessageId=A2A_CNS_wegirl001_1751443200123-abc123
```

## 文件变更清单

| 文件 | 变更类型 | 说明 |
|------|----------|------|
| `src/config.ts` | 修改 | 配置合并逻辑 |
| `src/core/send.ts` | 修改 | messageId 生成和传递 |
| `src/core/sessions-send.ts` | 修改 | messageId 传递和回复 ID 生成 |
| `src/core/types.ts` | 修改 | 类型定义添加 messageId |
| `src/core/utils.ts` | 修改 | buildMessage 支持 messageId |
| `src/monitor.ts` | 修改 | Stream 消费传递 messageId |
| `dist/*` | 重新编译 | TypeScript 编译输出 |
