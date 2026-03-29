# WeGirl Connector

OpenClaw Gateway 插件 - 微妞 AI 多 Agent 消息路由中枢

## 功能

- **多 Agent 消息路由**: H2A (Human→Agent), A2A (Agent→Agent), A2H (Agent→Human)
- **Redis Stream 消费**: 消费 wegirl-service 发送的消息
- **统一 StaffId 抽象**: 人类和 Agent 统一使用 StaffId 标识
- **跨实例通信**: 支持多实例部署的消息路由
- **HR 入职管理**: 自动化 Agent/人类入职流程
- **replyTo 自动转发**: Agent 结果自动转发给指定目标
- **统一消息构建**: 共享 `buildMessage` 函数确保消息格式一致性

## 架构

```
Redis Stream ←→ WeGirl Connector ←→ OpenClaw Agents
                     ↓
              wegirl_send (Tool)
```

---

## 📌 里程碑

### v2.1.6 (2026-03-30) ⭐ Current

**Bug 修复 - 事件处理器热重载修复**:
- ✅ 添加 `resetEventHandlers()` 函数重置注册状态
- ✅ 修复热重载后 `before_tool_call`/`after_tool_call` 日志不显示的问题
- ✅ 解决全局变量缓存导致的重复注册跳过问题

详见 [MILESTONE-v2.1.6.md](./MILESTONE-v2.1.6.md)

---

### v2.1.5 (2026-03-29)

**调试增强 - Plugin Registered 事件**:
- ✅ 插件注册成功后发送 `plugin_registered` 事件
- ✅ 包含 instanceId、agentsRegistered、redisStatus
- ✅ 用于调试插件初始化时机和防重复注册验证

详见 [MILESTONE-v2.1.5.md](./MILESTONE-v2.1.5.md)

---

### v2.1.4 (2026-03-29)

**Bug 修复 - 防止事件处理器重复注册**:
- ✅ 添加 `handlersRegistered` 全局标记
- ✅ 解决 channel 多 account 导致的多次初始化问题
- ✅ 避免重复事件处理和日志输出

详见 [MILESTONE-v2.1.4.md](./MILESTONE-v2.1.4.md)

---

### v2.1.1 (2026-03-26)

**代码重构 - 统一消息构建**:
- ✅ 提取 `MessageBuilderOptions` 接口到 `utils.ts`
- ✅ 提取 `buildMessage` 函数到 `utils.ts`
- ✅ `send.ts` 和 `sessions-send.ts` 共享使用
- ✅ 确保所有消息格式一致性

详见 [MILESTONE-v2.1.1.md](./MILESTONE-v2.1.1.md)

---

### v2.1.0 (2026-03-26)

**replyTo 自动转发机制**:
- ✅ 支持 `replyTo` 自动转发（同步/异步模式）
- ✅ 支持多个 `replyTo` 目标（数组）
- ✅ 转发失败自动通知调用方
- ✅ 新增 `forwarding`/`forwarded` 返回状态
- ✅ 统一消息构建函数 `buildMessage`

详见 [MILESTONE-v2.1.0.md](./MILESTONE-v2.1.0.md)
- ✅ 支持 `replyTo` 自动转发（同步/异步模式）
- ✅ 支持多个 `replyTo` 目标（数组）
- ✅ 转发失败自动通知调用方
- ✅ 新增 `forwarding`/`forwarded` 返回状态
- ✅ 统一消息构建函数 `buildMessage`

详见 [MILESTONE-v2.1.0.md](./MILESTONE-v2.1.0.md)

---

### v2.0.39 (2026-03-21)

**与 wegirl-service 集成**:
- ✅ 职责分离：wegirl-connector 只发送，`wegirl-service` 处理业务逻辑
- ✅ `hr_manage` 参数与 `SessionsSendOptions` 对齐（`source`/`target`/`chatType` 等）
- ✅ 移除 HR agent 回复拦截
- ✅ 移除 `RepliesSubscriber`（移至 wegirl-service）

**协议对齐**:
- ✅ 统一使用 `source`/`target` 替代 `userId`
- ✅ 新增 `senderName`/`senderOpenId`/`groupId`/`routingId` 参数

详见 [MILESTONE-v2.0.39.md](./MILESTONE-v2.0.39.md)

---

### v2.0 (2026-03-21)

**架构升级**:
- ✅ 统一 StaffId 抽象（人类和 Agent 统一标识）
- ✅ 新接口语义：flowType/source/target
- ✅ `wegirl_send` 成为主接口
- ✅ H2A/A2A/A2H 消息流支持

详见 [MILESTONE-v2.0.md](./MILESTONE-v2.0.md)

---

**与 wegirl-service 集成**:
- ✅ 职责分离：wegirl-connector 只发送，`wegirl-service` 处理业务逻辑
- ✅ `hr_manage` 参数与 `SessionsSendOptions` 对齐（`source`/`target`/`chatType` 等）
- ✅ 移除 HR agent 回复拦截
- ✅ 移除 `RepliesSubscriber`（移至 wegirl-service）

**协议对齐**:
- ✅ 统一使用 `source`/`target` 替代 `userId`
- ✅ 新增 `senderName`/`senderOpenId`/`groupId`/`routingId` 参数

---

### v2.0.27-38 (2026-03-21)

**消息架构重构**:
- ✅ 统一 error 处理（deliver 统一发送）
- ✅ 统一返回值格式（`status`/`note`）
- ✅ `handleProcessMessage` 统一 publish，execute 返回 `{content: []}`
- ✅ Debug 日志优化

---

### v2.0 (2026-03-21)

**架构升级**:
- ✅ 统一 StaffId 抽象（人类和 Agent 统一标识）
- ✅ 新接口语义：flowType/source/target
- ✅ `wegirl_send` 成为主接口（原接口改为 `wegirl_send_v1` 废弃）
- ✅ 移除 V1 格式支持，仅保留 V2 格式

**消息流支持**:
- ✅ H2A (Human→Agent) - 人类向 Agent 发送消息
- ✅ A2A (Agent→Agent) - Agent 间通信
- ✅ A2H (Agent→Human) - Agent 向人类回复

**replyTo 路由设计**:
- ✅ 默认行为：`replyTo = source`（谁发消息，回复给谁）
- ✅ 显式指定：支持任务委派、客服转接、代理汇总、上级抄送等场景

详见 [replyTo 行为定义](#replyto-行为定义)

**HR 入职流程**:
- ✅ 未绑定人类使用 openId 作为临时 staffId
- ✅ `hr_manage` 工具处理入职登记
- ✅ 自动生成入职登记表单
- ✅ `create_staff` action 统一处理入职请求
- ✅ 入职消息格式标准化（工号/姓名/电话/角色/能力）

**Bug 修复**:
- ✅ replyTo 解析支持字符串 open_id
- ✅ 为所有 Agent 配置 anthropic auth profile
- ✅ 修复 isOnboardRequest/isOnboardFormat 空值检查

详见 [MILESTONE-v2.0.md](./MILESTONE-v2.0.md)

---

### v1.0.2 (2026-03-19)

**配置优化**:
- ✅ Redis 配置优先级（环境变量 > pluginConfig > 默认值）
- ✅ Event Handlers 支持 `write` 工具文件路径提取

---

### v1.0.1 (2026-03-19)

**Bug 修复**:
- ✅ Redis 连接配置修复
- ✅ HR Manage 工具新增 `sync_agents_to_redis` action

---

### v1.0 (2026-03-17)

**基础架构**:
- ✅ Agent 注册与心跳机制
- ✅ Redis Stream 跨实例通信
- ✅ Consumer Group 消费组管理

---

## 安装

```bash
cd /path/to/openclaw/extensions
git clone https://github.com/wegirlai/wegirl-connector.git
cd wegirl-connector
npm install
npm run build
```

## 配置

在 `openclaw.json` 中添加:

```json
{
  "plugins": {
    "entries": {
      "wegirl": {
        "enabled": true,
        "config": {
          "instanceId": "wegirl001",
          "redisUrl": "redis://10.8.0.1:6379",
          "redisPassword": "your-password",
          "redisDb": 1
        }
      }
    }
  }
}
```

## Tools

### `wegirl_send`

统一消息发送接口:

```javascript
// 基础用法
{
  flowType: "A2A",
  source: "scout",
  target: "hr",
  message: "列出花名册",
  replyTo: "human:tiger",  // 结果自动转发给 tiger
  routingId: "..."
}

// 多目标转发
{
  flowType: "A2A",
  source: "scout",
  target: "hr",
  message: "列出花名册",
  replyTo: ["tiger", "boss"],  // 结果发给多个人
  routingId: "..."
}

// 同步等待
{
  flowType: "A2A",
  source: "scout",
  target: "harvester",
  message: "抓取 example.com",
  timeoutSeconds: 60,  // 同步等待60秒
  routingId: "..."
}
```

**返回值**:
```javascript
// 有 replyTo
{ status: "forwarding", replyTo: ["tiger"], mode: "async" }

// 同步等待
{ status: "ok", response: { message: "...", payload: {...} }, mode: "sync" }

// 异步
{ status: "accepted", mode: "async" }
```

### `hr_manage`

HR Agent 专用工具（create_staff action）:

```javascript
{
  action: "create_staff",
  message: "用户消息内容",
  source: "ou_xxx",          // 用户ID (对应 SessionsSendOptions.source)
  target: "default",         // 目标ID (默认)
  chatType: "direct",        // 聊天类型: direct/group
  senderName: "用户名",      // 发送者显示名
  senderOpenId: "ou_xxx",    // 发送者 OpenId
  groupId: "chat_xxx",       // 群聊ID (可选)
  routingId: "routing_xxx"   // 路由追踪ID (可选)
}
```

详见 [MILESTONE-v2.0.md](./MILESTONE-v2.0.md) 完整版本历史。

## 核心模块

- `src/channel.ts` - Stream 消费和消息分发
- `src/core/send.ts` - 消息路由核心实现
- `src/core/types.ts` - 类型定义
- `src/sessions-send.ts` - Agent Session 发送

## 消息格式 (V2)

```json
{
  "flowType": "H2A",
  "source": "ou_xxx",
  "target": "hr",
  "message": "...",
  "chatType": "direct",
  "replyTo": "ou_xxx"
}
```

## License

MIT

---

## replyTo 行为定义

### 默认行为（replyTo = source）

| 场景 | 流向 | 说明 |
|------|------|------|
| H2A 默认 | `tiger → scout` | scout 回复给 tiger，正常交互 |
| A2A 默认 | `hr → scout` | scout 回复给 hr，任务反馈 |

### 显式指定场景

| 场景 | 流向 | replyTo | 说明 |
|------|------|---------|------|
| **任务委派** | `hr → scout` | `quartermaster` | hr 让 scout 分析，结果给 quartermaster 汇总 |
| **客服转接** | `support → engineer` | `user` | support 转技术问题给 engineer，但回复给 user |
| **代理汇总** | `user → scout` | `analyst` | scout 收集 URL，结果给 analyst 分析 |
| **上级抄送** | `staff → assistant` | `manager` | staff 让 assistant 做事，同时抄送 manager |

### 特殊值

- **`NO_REPLY`** - 不期望回复（广播通知场景）
- **数组** - 多个回复目标 `["user", "manager"]`

### 代码示例

```javascript
// 任务委派：hr 让 scout 收集，结果给 quartermaster
wegirl_send({
  flowType: "A2A",
  source: "hr",
  target: "scout",
  message: "收集 example.com 的所有 URL",
  replyTo: "quartermaster"  // 显式指定回复给 quartermaster
});

// 客服转接：support 把问题转给 engineer，但回复给 user
wegirl_send({
  flowType: "A2A",
  source: "support",
  target: "engineer",
  message: "用户遇到技术问题...",
  replyTo: "ou_user_openid"  // 回复给原始用户
});

// 广播通知：不需要回复
wegirl_send({
  flowType: "A2A",
  source: "hr",
  target: "all",
  message: "系统维护通知",
  replyTo: "NO_REPLY"
});
```
