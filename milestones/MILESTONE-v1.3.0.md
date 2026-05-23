# MILESTONE v1.3.0 — 全局配置兼容性升级

**发布日期**: 2026-05-23
**版本号**: 1.3.0
**标签**: `v1.3.0`

---

## 背景

OpenClaw 生态同时存在两种配置格式：
- **openclaw**: `{agents: {list: [{id, name}]}, bindings: [...]}`
- **openllm**: `{agents: {kimi: {...}}, plugins: {entries: {wegirl: {config: ...}}}}`

wegirl-connector 之前直接 `fs.readFileSync(path.join(OPENCLAW_HOME, 'openclaw.json'))` 读取配置，这导致：
1. 在 openllm 格式下解析失败
2. 插件热重载时 `initGlobalConfig` 会覆盖已加载的内存配置
3. `checkIsAgent` 等高频操作产生不必要的磁盘 I/O

---

## 核心改动

### 1. 全局配置统一接口

所有模块统一使用 `getGlobalConfig()`（来自 `src/config.ts`）：

```typescript
// 之前
const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

// 现在
const config = getGlobalConfig();
```

**涉及文件**:
- `src/index.ts` — `getInstanceIdFromConfig`, `getLocalAgents`
- `src/hr-manage-core.ts` — `checkAgentExists`, `checkAccountIdInUse`, `executeCreateAgent`
- `src/hr-message-handler.ts` — `checkIsAgent`

### 2. 双格式兼容

支持同时识别两种 `agents` 结构：

```typescript
// openllm 格式: { agents: { kimi: {...} } }
if (config.agents && typeof config.agents === 'object' && !Array.isArray(config.agents)) {
  return !!config.agents[agentName];
}

// openclaw 格式: { agents: { list: [...] } }
return config.agents?.list?.some((a) => a.id === agentName || a.name === agentName) || false;
```

### 3. 防重复加载

`initGlobalConfig` 增加保护：

```typescript
if (cfg) {
  globalConfig = cfg;
} else if (!globalConfig) {  // ← 新增保护
  globalConfig = loadConfigFromFile();
}
```

避免插件热重载或多次初始化时把已解析的内存配置覆盖回文件旧值。

### 4. checkIsAgent 查询顺序

优先 Redis，fallback 配置：

```typescript
// 1. 优先查 Redis
const staffData = await redis.hgetall(`${KEY_PREFIX}staff:${identifier}`);
if (staffData && staffData.type === 'agent') return true;

// 2. 从全局配置查
const config = getGlobalConfig();
// ...
```

Redis 命中时零磁盘 I/O，性能更优。

---

## 测试要点

| 场景 | 预期 |
|------|------|
| openclaw 格式下 `list_staffs` | 正常列出 agents |
| openllm 格式下 `list_staffs` | 正常列出 agents（从 Object keys） |
| 插件热重载 | `initGlobalConfig` 不覆盖已有配置 |
| `checkIsAgent('hr')` | 先查 Redis，再查配置 |
| `create_agent` | 写入配置时兼容两种格式 |

---

## 配套说明

- 本次改动**纯插件侧**，无需升级 `wegirl-service` 或 `wegirl-sdk`
- `dist/` 已重新构建（`npm run build`）
- 向后兼容：openclaw 格式行为不变

---

## 相关 Commit

- `config.ts` — `else if (!globalConfig)` 防重复加载
- `hr-manage-core.ts` — 全局配置 + 双格式兼容
- `hr-message-handler.ts` — Redis 优先 + 全局配置 fallback
- `index.ts` — `getLocalAgents` 双格式 + `getInstanceIdFromConfig` 路径扩展
