# Changelog

## v1.3.4 — 移除 Registry 定时心跳

**发布日期**: 2026-05-24

### 🔄 变更

- **移除 `Registry` 定时心跳** — `heartbeat()`/`startHeartbeat()`/`heartbeatTimers` 全部移除
- **移除 `HEARTBEAT_INTERVAL` 常量** — 不再使用
- **`Registry` 退化为纯查询/管理工具** — 保留 `registerStaff`/`getStaff`/`findStaffByCapability` 等查询和注册方法，但不再维护定时心跳
- **initRedis 中不再启动心跳** — `syncAgentsFromLocal` 初始设置 `lastHeartbeat` 后，由 `wegirl-service` 通过消息流转判断在线状态

### 🛠 影响文件

- `src/registry.ts` — 移除心跳相关方法和定时器
- `src/index.ts` — 移除 initRedis 中的 `startHeartbeat()` 循环

---

## v1.3.3 — 移除 initRedis 中的重复注册循环

**发布日期**: 2026-05-24

### 🔄 变更

- **移除 `registry.register()` 循环** — `syncAgentsFromLocal` 已直接 `redis.hset` 完成所有字段写入，initRedis 中的 `registry.register()` 循环是重复覆盖写
- **`Registry` 改为纯心跳管理** — `startHeartbeat` 从 private 改为 public，initRedis 中遍历本地 agent 只启动定时心跳，不写 Hash
- **清理 `event-handlers.ts` 残留** — `getRegistry` 参数和 `Registry` import 已无用，全部移除

### 🛠 影响文件

- `src/index.ts` — initRedis 中 `register()` → `startHeartbeat()`
- `src/registry.ts` — `startHeartbeat` 改为 public
- `src/event-handlers.ts` — 移除 `getRegistry` 参数和 `Registry` import

---

## v1.3.2 — 移除事件驱动注册/注销

**发布日期**: 2026-05-24

### 🔄 变更

- **`before_agent_start` 去掉 `registerAgent`** — 静态 agent 的注册和心跳已由 `syncAgentsFromLocal` + initRedis 中的 `registry.register()` 完成，事件驱动注册造成重复
- **`agent_end` 去掉 `unregisterAgent`** — 避免 session 结束时误删静态 agent 的 Redis staff，生命周期改由 `syncAgentsFromLocal` 管理
- **动态 agent（`sessions_spawn`）** — 若无 wegirl binding，无需在 wegirl 中注册；有 binding 的已在 `syncAgentsFromLocal` 中覆盖

### 🛠 影响文件

- `src/event-handlers.ts`

---

## v1.3.1 — 同步字段补全 + 双格式检测修复

**发布日期**: 2026-05-23

### 🐛 修复

- **`syncAgentsFromLocal` 字段缺失** — 新注册 agent 时缺少 `maxConcurrent` 字段，导致 Registry 反序列化后 `maxConcurrent` 为 `undefined`
- **`toKeep` 分支字段补全** — 已存在 agent 更新心跳时，若缺少 `maxConcurrent` 自动补全为 `'3'`
- **双格式检测误匹配** — `getLocalAgents` / `checkIsAgent` / `checkAgentExists` 中 `agentIds.length === 1` 判断不充分，当 `agents` 同时包含 `defaults` 和 `list` 时误将 `defaults` / `list` 当作 agent id 同步到 Redis

### 🛠 影响文件

- `src/index.ts` — `getLocalAgents` 双格式判断 + `syncAgentsFromLocal` 字段补全
- `src/hr-message-handler.ts` — `checkIsAgent` 双格式判断
- `src/hr-manage-core.ts` — `checkAgentExists` 双格式判断

---

## v1.3.0 — 全局配置兼容性升级 (openllm / openclaw 双格式)

**发布日期**: 2026-05-23

### ✨ 新增

- **`getGlobalConfig()` 统一读取** — `src/index.ts`、`src/hr-manage-core.ts`、`src/hr-message-handler.ts` 全部改用 `getGlobalConfig()`，不再直接 `fs.readFileSync(openclaw.json)`
- **openllm 格式兼容** — 支持 `{agents: {kimi: {...}}}`（openllm）和 `{agents: {list: [...]}}`（openclaw）两种配置格式
- **`initGlobalConfig` 防重复加载** — `else` → `else if (!globalConfig)`，避免插件热重载时配置被覆盖

### 🔄 变更

- **`checkIsAgent` 查询顺序优化** — 优先查 Redis `wegirl:staff:{id}`，fallback 到全局配置，彻底脱离文件 I/O
- **`checkAgentExists` / `checkAccountIdInUse` 重构** — 从内存配置对象读取，支持两种 agents 结构
- **`getLocalAgents` 双格式解析** — 自动识别 openllm（Object keys）vs openclaw（`agents.list` 数组），避免误匹配
- **`getInstanceIdFromConfig` 路径扩展** — 同时支持 `config.plugins.entries.wegirl.config.instanceId` 和旧路径

### 🛠 影响范围

- `src/config.ts` — 防重复加载
- `src/hr-manage-core.ts` — create_agent 配置写入逻辑
- `src/hr-message-handler.ts` — 私聊/群聊 agent 身份校验
- `src/index.ts` — sync agents、instanceId 获取、list_staffs

---

## v1.2.0 — replyContentType 协议升级

**发布日期**: 2026-05-08

### ✨ 新增

- **`replyContentType` 字段** — 消息顶层新增 `replyContentType` 字段，取值 `text` | `md` | `json`，标记回复内容格式类型
- **`buildMessage` 改造** — `MessageBuilderOptions` 新增 `replyContentType` 参数，`buildMessage` 将其写入消息顶层，不再通过事后 `(msg as any).replyContentType` 追加
- **wegirl:forward 默认值** — `wegirl:forward` 消息 `replyContentType` 固定为 `'text'`，回复消息跟随传入值
- **JSON 模式注入** — `replyContentType === 'json'` 时自动注入 JSON_MODE prompt；若无 `responseSchema`，fallback 到 `{message: ""}`

### 🔄 变更

- `handleAgentReply` 中所有 Redis 消息（同步响应、群聊媒体/文本、单 agent 媒体/文本、错误回复、world stream）统一通过 `buildMessage({ replyContentType })` 构造
- `finalizeInboundContext` 的 `Metadata.expectJson` 改为由 `replyContentType === 'json'` 控制

### 🛠 配套

- `wegirl-service` 数据库 `service_messages` 表新增 `reply_content_type VARCHAR(8)` 字段（`md`/`json`），默认 `'md'`
- `event_handler.py` 三个入库点均传入 `replyContentType`

---

## v1.1.1 — world stream expectJson marker

**发布日期**: 2026-05-07

### 🐛 修复

- `service_messages.id` 列从 `VARCHAR(64)` 扩到 `VARCHAR(255)`，解决 `Data too long` 报错
- `handleAgentReply` 中 `from=world` 的消息发送到 `wegirl:stream:world` 时，metadata 添加 `expectJson` 标记

---
