# MILESTONE v1.0.11

**发布日期**: 2025-07-02

## 核心变更

### messageId flowType 反向修正

**问题**: v1.0.10 引入 messageId 追踪时，Agent 回复生成的 messageId 使用了原始 `flowType`，导致消息方向标识错误。

**示例**:
```
问题场景：
- 人类发送消息 → flowType = "H2A" → messageId = "H2A_CNS_xxx" ✅
- Agent 回复 → 应该生成 "A2H_CNR_xxx" ❌ 但之前生成 "H2A_CNR_xxx"
```

**修复方案**:
1. 提前计算 `replyFlowType = reverseFlowType(flowType)`
2. 所有 `generateReplyMessageId()` 调用使用 `replyFlowType` 而非原始 `flowType`
3. 所有 `buildMessage()` 的 flowType 参数也使用 `replyFlowType`

**影响位置**（`src/core/sessions-send.ts`）:
- 同步响应路径 → `generateReplyMessageId(replyFlowType)`
- 群聊媒体消息 → `generateReplyMessageId(replyFlowType)` + `flowType: replyFlowType`
- 群聊文本消息 → `generateReplyMessageId(replyFlowType)` + `flowType: replyFlowType`
- 单聊媒体消息 → `generateReplyMessageId(replyFlowType)` + `flowType: replyFlowType`
- 单聊文本消息 → `generateReplyMessageId(replyFlowType)` + `flowType: replyFlowType`
- 错误消息 → `generateReplyMessageId(replyFlowType)`
- 日志输出 → `replyFlowType`

**修正后 ID 示例**:
```
H2A 流程：
  进入: "H2A_CNS_wegirl001_1751443200123-abc123"
  回复: "A2H_CNR_wegirl001_1751443200456-def456" ✅

A2A 流程：
  进入: "A2A_CNS_wegirl001_1751443200123-abc123"
  回复: "A2A_CNR_wegirl001_1751443200456-def456" ✅（A2A 反向仍是 A2A）
```

## 兼容性

- ✅ 向后兼容：仅修正内部标识，不影响外部行为
- ✅ 无破坏性变更

## 文件变更清单

| 文件 | 变更类型 | 说明 |
|------|----------|------|
| `src/core/sessions-send.ts` | 修改 | 使用 replyFlowType 替代 flowType 生成回复 messageId |
| `dist/core/sessions-send.*` | 重新编译 | TypeScript 编译输出 |
