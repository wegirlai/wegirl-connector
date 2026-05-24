# MILESTONE v1.3.7 - 竞态条件修复 + 编译加载

**日期**: 2026-05-24

---

## 变更摘要

### 1. 竞态条件修复

**问题**：`initRedis` 被连续调用两次（register + channel 初始化同时触发），`redisConnectPromise` 赋值前的竞态窗口导致两个调用都进入了内部 Promise，`syncAgentsFromLocal` 被执行了两次。

**日志现象**：
```
04:10:44 [sync] Found 12 wegirl agents in config (from bindings)  ← 第一次
04:10:48 [sync] Sync complete: 12 kept, 0 registered, 0 zombies removed
04:10:48 [sync] Found 12 wegirl agents in config (from bindings)  ← 第二次（重复！）
```

**修复**：
- 添加 `isSyncing` 同步锁变量
- `syncAgentsFromLocal` 执行前检查 `!hasSyncedAgents && !isSyncing`
- 进入时 `isSyncing = true`，finally 中释放
- 第二个调用检查到 `isSyncing` 为 true，直接跳过

### 2. 编译加载提醒

**问题**：OpenClaw gateway 加载的是 `dist/` 目录下的编译后 JS 代码，不是 `src/` 下的 TypeScript 源码。

**正确流程**：
```bash
cd /root/.openclaw/extensions/wegirl-connector
npx tsc          # 编译 TypeScript → dist/
openclaw gateway restart  # 重启加载新的 dist/
```

### 3. 配置初始化简化

- **移除** `initGlobalConfig()` 函数
- 配置统一由 `setGlobalConfig(ctxCfg)` 从 `context.cfg` 传入
- `getGlobalConfig()` 不再自动兜底加载文件
- 没传 `context.cfg` 时 warning

### 4. 格式判断清理

- `getLocalAgents` 移除 `isOpenllmFormat` / `isOpenclawFormat` 判断
- `hr-message-handler.ts` — `checkIsAgent` 统一用 `agents.list`
- `hr-manage-core.ts` — `checkAgentExists` 统一用 `agents.list`

---

## 影响文件

| 文件 | 变更 |
|------|------|
| `src/index.ts` | 添加 `isSyncing` 锁；移除 `initGlobalConfig` import；简化 `getLocalAgents` |
| `src/config.ts` | 移除 `initGlobalConfig()` |
| `src/hr-message-handler.ts` | 移除格式判断 |
| `src/hr-manage-core.ts` | 移除格式判断 |

---

## 兼容性

- 需要 `npx tsc` 编译后重启 gateway 生效
- 配置格式统一为 `bindings + agents.list`，openllm 的 `openllm.json` 已同步此格式
