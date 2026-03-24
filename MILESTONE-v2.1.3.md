# MILESTONE-v2.1.3.md - WeGirl Connector v2.1.3

## 发布日期
2026-03-24

## 版本概述
全局配置管理优化，消除重复配置加载，提升性能和一致性。

---

## 核心改进

### 1. 全局配置管理模块 (config.ts)

**新增文件**: `src/config.ts`

统一配置管理，避免各模块重复加载配置文件：

```typescript
// 初始化全局配置（插件启动时调用）
initGlobalConfig()

// 设置全局配置（startAccount 传入 cfg 时使用）
setGlobalConfig(cfg)

// 获取全局配置（所有模块统一使用）
getGlobalConfig()

// 获取 wegirl 插件配置
getWeGirlPluginConfig()

// 获取 Redis 配置
getRedisConfig()
```

**优势**:
- ✅ 配置只加载一次，避免重复 I/O
- ✅ 所有模块共享同一配置对象
- ✅ 统一配置访问接口

### 2. startAccount 配置优化

**修改**: `src/channel.ts`

OpenClaw 调用 `startAccount` 时传入的 `ctx.cfg` 直接设置为全局配置：

```typescript
gateway: {
  startAccount: async (ctx: any) => {
    const { cfg: ctxCfg, accountId, abortSignal, log, setStatus } = ctx;
    
    // 如果 OpenClaw 传入了 cfg，直接设置到全局变量
    if (ctxCfg) {
      setGlobalConfig(ctxCfg);
      log.info(`[WeGirl Channel]<${id}> Global config set from startAccount ctx.cfg`);
    }
    
    // 后续代码统一使用 getGlobalConfig()
    const fullCfg = getGlobalConfig() || {};
  }
}
```

### 3. wegirlSessionsSend 直接使用 cfg

**修改**: `src/core/sessions-send.ts`

删除重新构建 `cfg` 的代码，直接使用传入的配置对象：

```typescript
// Before: 重新构建 cfg
const cfg = {
  ...originalCfg,
  models: {
    mode: 'merge' as const,
    provider: 'kimi-coding',
    modelId: 'k2p5',
  },
};

// After: 直接使用传入的 cfg
const { message, cfg, channel, ... } = options;
// 直接使用 cfg，不重新构建
```

### 4. 各模块统一使用全局配置

**修改文件**:
- `src/index.ts` - 使用 `initGlobalConfig()` 初始化
- `src/channel.ts` - 使用 `getGlobalConfig()` 和 `getWeGirlPluginConfig()`
- `src/tools.ts` - 使用 `getGlobalConfig()`
- `src/core/send.ts` - 使用 `getGlobalConfig()`, `getWeGirlPluginConfig()`, `getRedisConfig()`

### 5. Bug 修复: replyTo 数组解析

**修改**: `src/channel.ts`

修复 `replyTo` 可能是数组时解析错误的问题：

```typescript
// 修复：replyTo 可能是数组或字符串，统一转换为字符串
const replyToRaw = data.replyTo;
const replyTo = Array.isArray(replyToRaw) 
  ? (replyToRaw[0] || '')
  : (replyToRaw || '');
```

---

## 文件变更

| 文件 | 变更类型 | 说明 |
|------|----------|------|
| `src/config.ts` | 新增 | 全局配置管理模块 |
| `src/index.ts` | 修改 | 使用 `initGlobalConfig()` 初始化 |
| `src/channel.ts` | 修改 | 使用全局配置，修复 replyTo 解析 |
| `src/tools.ts` | 修改 | 使用 `getGlobalConfig()` |
| `src/core/send.ts` | 修改 | 使用全局配置函数 |
| `src/core/sessions-send.ts` | 修改 | 直接使用传入的 cfg |

---

## 兼容性

- ✅ 向后兼容：外部接口不变
- ✅ `startAccount` 仍可使用传入的 `ctx.cfg` 覆盖全局配置
- ✅ 其他模块自动使用更新后的全局配置

---

## 测试建议

1. 重启 OpenClaw Gateway，验证配置正确加载
2. 发送 H2A/A2A/A2H 消息，验证消息路由正常
3. 检查日志中 `[WeGirl Config]` 相关输出
4. 验证 `replyTo` 为数组时的消息回复

---

## 相关提交

```bash
git add src/config.ts
git add src/index.ts src/channel.ts src/tools.ts
git add src/core/send.ts src/core/sessions-send.ts
git commit -m "v2.1.3: 全局配置管理优化

- 新增 config.ts 统一管理配置
- startAccount 直接使用 ctx.cfg 设置全局变量
- wegirlSessionsSend 直接使用传入的 cfg
- 各模块统一使用 getGlobalConfig()
- 修复 replyTo 数组解析问题"
```
