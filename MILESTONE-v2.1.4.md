# MILESTONE-v2.1.4.md - WeGirl Connector v2.1.4

## 发布日期
2026-03-29

## 版本概述
防止事件处理器重复注册，解决因 channel 多 account 导致的多次初始化问题。

---

## 核心改进

### 1. 事件处理器防重复注册

**修改**: `src/event-handlers.ts`

添加全局标记，确保事件处理器只注册一次：

```typescript
// 全局标记，防止重复注册事件处理器
let handlersRegistered = false;

export function registerEventHandlers(ctx: EventHandlerContext): void {
  // 防止重复注册
  if (handlersRegistered) {
    logger.debug('[WeGirl] Event handlers already registered, skipping');
    return;
  }
  handlersRegistered = true;
  
  // ... 注册事件处理器
}
```

**问题背景**:
- wegirl-connector 同时作为 plugin 和 channel 被加载
- channel 有 6 个 accounts (analyst, archivist, harvester, hr, quartermaster, scout)
- 每次 feishu 有新消息，channel 重新解析，导致 `register` 函数被多次调用
- 事件处理器重复注册，造成重复事件处理

**解决方案**:
- 添加 `handlersRegistered` 全局标记
- 首次注册后设置标记，后续调用直接跳过
- 使用 `logger.debug` 记录跳过日志

---

## 文件变更

| 文件 | 变更类型 | 说明 |
|------|----------|------|
| `src/event-handlers.ts` | 修改 | 添加 `handlersRegistered` 全局标记防止重复注册 |

---

## 兼容性

- ✅ 向后兼容：外部接口不变
- ✅ 不影响正常的事件处理流程
- ✅ 仅防止重复注册，不修改事件处理逻辑

---

## 测试建议

1. 重启 OpenClaw Gateway
2. 发送多条 feishu 消息
3. 检查日志中 `[WeGirl] Event handlers registered` 只出现一次
4. 验证 `[WeGirl] Event handlers already registered, skipping` 出现在后续消息中
5. 确认 events 消息正常推送，无重复

---

## 相关提交

```bash
git add src/event-handlers.ts
git commit -m "v2.1.4: 防止事件处理器重复注册

- 添加 handlersRegistered 全局标记
- 解决 channel 多 account 导致的多次初始化问题
- 使用 debug 日志记录跳过信息"
```
