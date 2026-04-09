# MILESTONE-v2.1.6.md

## WeGirl Connector v2.1.6

### 发布日期
2026-03-30

### 修复内容

#### 🐛 Bug Fixes
- **修复事件处理器热重载后不重新注册的问题**: 添加 `resetEventHandlers()` 函数，在插件注册前重置注册状态
  - 问题：插件热重载后全局变量 `handlersRegistered` 仍为 `true`，导致 `before_tool_call`/`after_tool_call` 等事件处理器被跳过
  - 解决：新增 `resetEventHandlers()` 函数，在 `register()` 中调用，强制重新注册事件处理器
  - 影响：解决了重启后 tool call 日志不显示的问题

### 技术细节

**问题描述:**
OpenClaw Gateway 重启或插件热重载后，`before_tool_call` 和 `after_tool_call` 事件日志不再输出。日志显示 `Event handlers already registered, skipping`。

**根本原因:**
`event-handlers.ts` 中的全局变量 `handlersRegistered` 在模块加载时初始化为 `false`，第一次注册后设为 `true`。但插件热重载时模块被重新加载，而全局变量仍保持 `true`（Node.js 模块缓存），导致事件处理器被跳过。

**修复方案:**
1. 添加 `resetEventHandlers()` 导出函数:
```typescript
export function resetEventHandlers(): void {
  handlersRegistered = false;
}
```

2. 修改 `registerEventHandlers()` 支持强制重新注册:
```typescript
export function registerEventHandlers(ctx: EventHandlerContext, force: boolean = false): void {
  if (handlersRegistered && !force) {
    logger.debug('[WeGirl] Event handlers already registered, skipping');
    return;
  }
  handlersRegistered = true;
  // ... 注册事件处理器
}
```

3. 在 `index.ts` 的 `register()` 中调用 `resetEventHandlers()`:
```typescript
resetEventHandlers();
registerEventHandlers({
  context,
  logger,
  // ...
});
```

### 文件变更
- `src/event-handlers.ts` - 添加 `resetEventHandlers()` 函数和 `force` 参数
- `src/index.ts` - 导入并调用 `resetEventHandlers()`

### 兼容性
- 完全向后兼容
- 无需配置变更
- 无需数据库迁移

---

**Full Changelog**: 对比 v2.1.5...v2.1.6
