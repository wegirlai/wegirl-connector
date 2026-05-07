# MILESTONE-v1.1.1

## 版本: v1.1.1
**日期**: 2026-05-07
**提交**: `67e452f`

---

## 变更摘要

### 1. world Stream 消息添加 expectJson 标记

**文件**: `src/core/sessions-send.ts`

**问题**: world 发送的消息如果带有 `responseSchema`，需要让接收端知道期望 JSON 格式回复。此前 world stream 消息没有携带此标记，导致接收 Agent 可能以普通文本格式回复，world 无法正确解析。

**修复**:
- 在 `handleAgentReply` 中，当 `from === 'world'` 时，向 `wegirl:stream:world` 发送的消息额外添加 `expectJson` 标记
- `expectJson` 的值基于原始消息的 `responseSchema` 是否存在：`!!originalMetadata?.responseSchema`
- 这样 world 端可以据此决定是否需要对回复做 JSON 解析

```typescript
const worldMessage = {
  ...replyMessage,
  metadata: {
    ...replyMessage.metadata,
    expectJson: !!originalMetadata?.responseSchema,
  }
};
await pub.xadd('wegirl:stream:world', '*', 'data', JSON.stringify(worldMessage));
```

---

### 2. cleanupExpiredStaff 迁移注释

**文件**: `src/registry.ts`

**问题**: `cleanupExpiredStaff` 函数之前是心跳超时检测的主要实现，但实际上不可靠——当 connector 自身停止后，该函数无法再执行清理。

**说明**:
- 添加明确注释：心跳超时检测已迁移到 **wegirl-service (Python 后端)** 实现
- `cleanupExpiredStaff` 仅作为辅助（如正常关闭时清理），不再承担主要检测职责
- 避免后续开发者误以为客户端 cleanup 足以处理所有超时场景

```typescript
// ⚠️ 注意：主要的心跳超时检测已迁移到 wegirl-service (Python 后端) 实现。
// 客户端 cleanup 仅作为辅助（如正常关闭时清理），不可靠，因为 connector
// 自身停止后无法执行此函数。
```

---

## 影响范围

| 模块 | 影响 | 说明 |
|------|------|------|
| world → Agent → world 回复链路 | ✅ 增强 | 回复消息携带 expectJson，world 可正确解析 JSON |
| 心跳超时检测 | 📋 文档 | 明确后端负责，客户端辅助 |
| 其他消息流 | ❌ 无 | H2A/A2A/A2H 不受影响 |

---

## 兼容性

- ✅ 完全向后兼容
- ✅ 不涉及接口变更
- ✅ 仅增强 metadata 和添加注释

---

## 相关提交

- `67e452f` v1.1.1: world stream expectJson marker + cleanup注释
