# MILESTONE-v2.1.1.md

## 版本: v2.1.1
## 日期: 2026-03-26
## 标题: 代码重构 - 统一消息构建

---

## 变更概述

将 `buildMessage` 函数和 `MessageBuilderOptions` 接口提取到 `utils.ts`，实现代码共享和统一。

---

## 动机

之前的实现中：
- `sessions-send.ts` 内部定义了 `buildMessage` 函数
- `send.ts` 中 A2H 消息构建没有使用统一函数
- 多处重复的消息结构定义

这导致：
- 代码重复
- 消息格式不一致的风险
- 维护困难

---

## 变更内容

### 1. 新增共享模块 `src/core/utils.ts`

```typescript
export interface MessageBuilderOptions {
  flowType: string;
  source: string;
  target: string;
  message: string;
  chatType: string;
  groupId?: string;
  routingId: string;
  msgType?: string;
  fromType?: string;
  metadata?: Record<string, any>;
  timeoutSeconds?: number;
}

export function buildMessage(opts: MessageBuilderOptions): any {
  return {
    flowType: opts.flowType,
    source: opts.source,
    target: opts.target,
    message: opts.message,
    chatType: opts.chatType,
    groupId: opts.groupId,
    routingId: opts.routingId,
    msgType: opts.msgType || 'message',
    fromType: opts.fromType || 'inner',
    timeoutSeconds: opts.timeoutSeconds || 0,
    timestamp: Date.now(),
    metadata: {
      ...opts.metadata,
      processedAt: Date.now(),
    }
  };
}
```

### 2. 更新 `src/core/sessions-send.ts`

- 删除本地定义的 `MessageBuilderOptions` 接口
- 删除本地定义的 `buildMessage` 函数
- 从 `utils.ts` 导入

```typescript
import { buildMessage, type MessageBuilderOptions } from './utils.js';
```

### 3. 更新 `src/core/send.ts`

- 从 `utils.ts` 导入 `buildMessage`
- A2H 消息构建改用 `buildMessage`

```typescript
// 之前
const replyMessage = {
  flowType: 'A2H',
  source: ctx.source,
  target: ctx.target,
  // ... 手动构建
};

// 之后
const replyMessage = buildMessage({
  flowType: 'A2H',
  source: ctx.source,
  target: ctx.target,
  message: options.message,
  chatType: ctx.chatType,
  // ...
});
```

---

## 影响

### 功能影响
- 无功能变更
- 无破坏性变更
- 纯代码重构

### 维护改善
- 单一数据源：消息结构定义在一个地方
- 易于修改：修改一处，全局生效
- 代码复用：避免重复定义

---

## 文件变更

| 文件 | 变更类型 | 说明 |
|------|----------|------|
| `src/core/utils.ts` | 新增 | 添加 `MessageBuilderOptions` 和 `buildMessage` |
| `src/core/sessions-send.ts` | 修改 | 删除本地定义，导入共享模块 |
| `src/core/send.ts` | 修改 | 导入共享模块，A2H 使用 `buildMessage` |

---

## 后续计划

- [ ] 将更多通用函数提取到 `utils.ts`
- [ ] 考虑添加消息格式验证
- [ ] 考虑添加消息版本控制

---

*完成时间: 2026-03-26*
*负责人: 微妞CTO*
