# MILESTONE-v2.1.0.md

## 版本: v2.1.0
## 日期: 2026-03-26
## 标题: replyTo 自动转发机制

---

## 新增功能

### 1. replyTo 自动转发机制

当 `wegirl_send` 包含 `replyTo` 参数时：

| 模式 | timeoutSeconds | 行为 |
|------|---------------|------|
| 同步 | >0 | 等待目标 Agent 完成，结果发给调用方，同时转发给 replyTo |
| 异步 | 0 或不传 | 立即返回，目标 Agent 完成后转发给 replyTo |

**转发特点：**
- 转发始终使用异步模式（timeoutSeconds=0）
- 支持多个 replyTo 目标（数组）
- 转发失败会通知调用方

### 2. 多目标转发

```javascript
// 单个
wegirl_send({
  target: "hr",
  message: "列出花名册",
  replyTo: "tiger"
});

// 多个
wegirl_send({
  target: "hr",
  message: "列出花名册",
  replyTo: ["tiger", "boss", "manager"]
});
```

### 3. 返回值更新

| 场景 | 返回值 |
|------|--------|
| 有 replyTo | `{ status: 'forwarding'/'forwarded', replyTo: [...] }` |
| 无 replyTo + 同步 | `{ status: 'ok', response: '...' }` |
| 无 replyTo + 异步 | `{ status: 'accepted' }` |

---

## 技术实现

### deliver 回调改造

```typescript
// 1. 同步模式：写入 Redis（供调用方获取）
if (awaitResponse && responseRoutingId) {
  await redis.lpush(`wegirl:response:${responseRoutingId}`, ...);
  // 继续执行转发
}

// 2. 转发给所有 replyTo 目标
for (const replyToTarget of validReplyToList) {
  await wegirlSend({
    target: replyToTarget,
    message: text,
    timeoutSeconds: 0  // 始终异步
  });
}

// 3. 汇总失败通知
if (failedTargets.length > 0) {
  await wegirlSend({
    target: source,
    message: `转发给 [${failedNames}] 失败`
  });
}
```

### 统一消息构建函数

```typescript
buildMessage({
  flowType,
  source,
  target,
  message,
  routingId,
  timeoutSeconds,  // 统一携带
  metadata
});
```

---

## 使用场景

### 场景 1：让 hr 列出花名册给 tiger

```javascript
// scout 调用
await wegirl_send({
  flowType: "A2A",
  source: "scout",
  target: "hr",
  message: "列出花名册",
  replyTo: "human:tiger",  // hr 完成后自动发给 tiger
  routingId: msg.routingId
});

// 返回给 scout: { status: 'forwarding', replyTo: 'tiger' }
// tiger 收到: 花名册内容
```

### 场景 2：多目标通知

```javascript
await wegirl_send({
  target: "analyst",
  message: "分析完成",
  replyTo: ["manager", "boss"],  // 同时通知两人
  routingId: msg.routingId
});
```

### 场景 3：同步等待结果

```javascript
const result = await wegirl_send({
  target: "harvester",
  message: "抓取 example.com",
  timeoutSeconds: 60  // 同步等待
});

// result: { status: 'ok', response: '抓取内容' }
```

---

## 兼容变更

- **无破坏性变更**：不传 replyTo 时行为不变
- **返回值格式**：新增 `forwarding`/`forwarded` 状态
- **内部实现**：统一使用 `buildMessage` 构建消息

---

## 后续计划

- [ ] 支持转发链（workflow 模式）
- [ ] 支持转发超时配置
- [ ] 支持转发重试机制

---

*完成时间: 2026-03-26*
*负责人: 微妞CTO*
