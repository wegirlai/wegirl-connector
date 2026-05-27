# MILESTONE-v1.3.8.md

**版本**: v1.3.8  
**日期**: 2025-07-08  
**作者**: Connectordev  

---

## 变更摘要

**`wegirl:stream:world` 消息 flowType 精简为单字母**:
- `wegirl:replies`（Pub/Sub）的 `flowType` 保持完整 `replyFlowType`（如 `A2H`）
- 仅 `wegirl:stream:world`（Redis Stream）的 `flowType` 改为首字母（如 `A`）
- `messageId` 生成格式保持原样（`{flowType}_CNR_{instanceId}_{uuid}`）

---

## 改动详情

### 1. `src/core/sessions-send.ts` — `handleAgentReply` 单 agent 回复路径

原代码:
```typescript
const replyMessage = buildMessage({
  flowType: replyFlowType,  // "A2H" / "H2A" / "A2A"
  // ...
});
await pub.xadd('wegirl:stream:world', '*', 'data', JSON.stringify(replyMessage));
```

改为:
```typescript
const replyMessage = buildMessage({
  flowType: replyFlowType.charAt(0),  // "A" / "H"
  // ...
});
await pub.xadd('wegirl:stream:world', '*', 'data', JSON.stringify(replyMessage));
```

### 2. 影响范围

- **仅** `originalMetadata?.from === 'world'` 的场景
- **仅** `wegirl:stream:world` Stream 写入
- **不影响**: `wegirl:replies` Pub/Sub 发布、同步响应 Redis LPUSH、群聊消息

---

## 目的

减少 world stream 消息体积，下游消费者（NPC、Dashboard）可通过首字母快速判断消息流向类型，无需解析完整字符串。

---

## 验证

- [x] `npm run build` 编译通过
- [x] TypeScript 类型检查通过
