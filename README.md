# WeGirl Connector

WeGirl 是 OpenClaw 的多 Agent 编排中枢插件，基于 Redis 实现跨实例 Agent 通信、任务调度和消息聚合。

---

## 📌 里程碑

### v1.0.1 (2026-03-19) ⭐ Current

**Bug 修复**:
- ✅ Redis 连接配置修复（优先从 plugin config 读取）
- ✅ Redis 连接非阻塞（CLI 命令不再卡住）

**新功能**:
- ✅ HR Manage 工具新增 `sync_agents_to_redis` action
- ✅ Event handlers 日志优化（显示文件路径）

详见 [MILESTONE-v1.0.1.md](./MILESTONE-v1.0.1.md)

---

### Milestone 1: 基础架构 (v1.0)

**核心功能**：
- ✅ Agent 注册与心跳机制（30秒心跳，90秒超时）
- ✅ 能力索引（capability indexing）
- ✅ Redis Stream 跨实例通信
- ✅ Consumer Group 消费组管理
- ✅ 基础 CLI 工具

**技术实现**：
```
Agent ──→ Redis (Hash: wegirl:agents:{id})
           ├─ Stream: wegirl:stream:instance:{id}
           ├─ Set: wegirl:capability:{cap}
           └─ Consumer Group: wegirl-consumers
```

**关键文件**：
- `src/protocol.ts` - 消息协议定义
- `src/registry.ts` - Agent 注册管理
- `src/queue.ts` - 待办队列

---

### Milestone 2: 消息派发重构 (v2.0)

**问题**：原始实现直接调用 `runtime.sessionsSend`，但在 Gateway 启动时 runtime 不可用。

**解决方案**：使用 `runtime.channel.reply.dispatchReplyFromConfig`

**实现细节**：
```typescript
// 正确路由解析
const route = runtime.channel.routing.resolveAgentRoute({
  cfg, channel, accountId, peer: { kind: chatType, id: chatId }
});

// 构建消息信封
const body = runtime.channel.reply.formatAgentEnvelope({...});
const inboundCtx = runtime.channel.reply.finalizeInboundContext({...});

// 派发消息
await runtime.channel.reply.dispatchReplyFromConfig({
  ctx: inboundCtx, cfg, dispatcher, replyOptions
});
```

**新增功能**：
- ✅ `wegirl:forward` - 请求消息通道（带 routingId/agentId/sessionKey）
- ✅ `wegirl:replies` - 回复消息通道（带 duration/status/error）
- ✅ 完整的消息字段（workflowId, error 预留字段）

**关键提交**：`6f17fb2` - feat: 完善 wegirlSessionsSend 消息派发流程

---

### Milestone 3: 群聊多 Agent 聚合 (v2.1) ⭐ Current

**需求场景**：
```
群里：@Scout @Analyst 分析这个网站
      ├─ Scout: 抓取 URL
      └─ Analyst: SEO 分析
      
期望：聚合两个 agent 的结果，统一回复到群里
```

**设计决策**：

| 方案 | 优缺点 |
|------|--------|
| Coordinator Agent | 需要维护 coordinator，复杂度高 |
| **wegirl 聚合** ✅ | 无需 coordinator，直接在 deliver 回调中聚合 |

**实现机制**：

```typescript
// 调用时传入任务参数
await wegirlSessionsSend({
  message: "分析 example.com",
  chatType: "group",        // 群聊触发
  taskId: "task_xxx",       // 任务标识
  agentCount: 2,            // 总共 2 个 agent
  currentAgentId: "scout",  // 当前 agent
});

// deliver 回调中自动聚合
deliver: async (payload, info) => {
  if (chatType === "group" && taskId && agentCount > 1) {
    // 1. 记录结果到 Redis
    await redis.hset(`wegirl:task:${taskId}:results`, agentId, text);
    
    // 2. 检查是否全部完成
    const results = await redis.hgetall(`wegirl:task:${taskId}:results`);
    
    // 3. 全部完成则聚合回复
    if (Object.keys(results).length === agentCount) {
      const aggregated = aggregateGroupResults(results);
      await redis.publish("wegirl:replies", aggregated);
    }
  }
}
```

**关键字段**：

```typescript
interface SessionsSendOptions {
  // ...原有字段
  taskId?: string;           // 多 agent 任务标识
  agentCount?: number;       // 总 agent 数
  currentAgentId?: string;   // 当前 agent 标识
}
```

**测试验证**：
```
✅ 消息1: agent1 处理 → Task progress: 1/2 completed
✅ 消息2: agent2 处理 → Task progress: 2/2 completed
✅ 触发聚合: All agents completed, aggregating results
✅ 统一回复: Aggregated reply published to wegirl:replies
```

**关键提交**：`3f041b9` - feat: 群聊多 agent 聚合功能

---

## 🔄 通信模式

### Agent → Agent (A2A)

Agent 之间的直接通信，无需人类介入。

**典型场景**：
```
Quartermaster: "@Scout 发现 example.com 的所有 URL"
     ↓
Scout: 完成爬取 → 回复 URL 列表
     ↓
Quartermaster: "@Harvester 抓取这些内容"
     ↓
Harvester: 完成抓取 → 回复内容片段
```

**特点**：
- 实时、同步通信
- 可跨实例（通过 Redis Stream）
- 支持能力匹配路由（`capability:url-discovery:least-load`）
- 消息包含完整上下文（routingId, sessionKey, agentId）

**消息通道**：
- 请求：`wegirl:forward` → Redis Stream → Agent
- 回复：Agent → `wegirl:replies` Pub/Sub → 调用方

---

### Agent → Human (A2H)

Agent 向人类用户发起任务或请求审批。

**典型场景**：
```
Scout: "发现 50 个 URL，请审批哪些需要抓取"
     ↓
Human (tiger): 查看任务 → 审批 "approve all"
     ↓
Scout: 收到审批结果 → 继续执行
```

**特点**：
- 异步、非阻塞
- 用户离线时任务进入待办队列（`wegirl:pending:{userId}`）
- 支持优先级、过期时间、审批流程
- 用户上线时通过通知推送

**消息通道**：
- 创建任务：Agent → Redis Hash (`wegirl:task:{id}`) + ZSet 索引
- 状态更新：Human → `wegirl:task:decision` → Agent 监听
- 待办通知：Cron/Heartbeat 检查 → 推送给在线用户

**与 A2A 的区别**：

| 维度 | A2A (Agent→Agent) | A2H (Agent→Human) |
|------|-------------------|-------------------|
| 响应时间 | 秒级（实时） | 分钟/小时级（异步） |
| 可靠性 | 即发即走 | 持久化 + 待办队列 |
| 交互方式 | 一问一答 | 审批/选择/评论 |
| 失败处理 | 重试/降级 | 任务挂起 + 提醒 |

---

## 🏗️ 架构设计

### 私聊 vs 群聊处理流程

```
┌─────────────────────────────────────────────────────────────┐
│                         消息进入                              │
└──────────────────┬──────────────────────────────────────────┘
                   │
         ┌─────────▼─────────┐
         │   chatType 判断    │
         └─────────┬─────────┘
                   │
    ┌──────────────┼──────────────┐
    ▼              ▼              ▼
┌────────┐    ┌────────┐    ┌─────────────┐
│ 私聊    │    │ 群单 agent│   │ 群多 agent   │
│ (p2p)  │    │ @0或@1  │   │ @N (N>1)    │
└────┬───┘    └────┬───┘    └──────┬──────┘
     │             │               │
     ▼             ▼               ▼
标准单 agent     单 agent         Redis 记录
session 路由    （带群上下文）     结果聚合
                                 统一回复
```

### 消息流向

```
私聊:  User ──→ wegirlSessionSend ──→ Agent ──→ 回复 User

群聊:  Group ──→ wegirlSessionSend ──┬─→ Agent1 ──┐
                                    ├─→ Agent2 ──┼─→ 聚合 ──→ 回复群
                                    └─→ AgentN ──┘
```

---

## 🚀 快速开始

### 安装

```bash
git clone https://github.com/wegirlai/wegirl-connector.git
cd wegirl-connector
npm install
npm run build
```

### OpenClaw 配置

```json
{
  "channels": {
    "wegirl": {
      "enabled": true,
      "dmPolicy": "open"
    }
  },
  "plugins": {
    "entries": {
      "wegirl": {
        "enabled": true,
        "config": {
          "instanceId": "wegirl001",
          "redisPassword": "your-password",
          "redisDb": 1
        }
      }
    }
  }
}
```

---

## 🛠️ Tools

### `hr_manage` - Agent 管理工具

HR Agent 专用的 Agent 管理工具，支持创建、查询、删除和同步 Agents。

**Actions**:

| Action | 参数 | 说明 |
|--------|------|------|
| `create_agent` | `agentName`, `accountId?`, `instanceId?`, `capabilities?`, `role?` | 创建新 Agent |
| `list_agents` | - | 列出所有已注册的 Agents |
| `get_agent` | `accountId` | 获取单个 Agent 详情 |
| `delete_agent` | `accountId` | 从 Redis 删除 Agent |
| `sync_agents_to_redis` | - | 同步本地 Agents 到 Redis |

**示例**:

```json
// 列出所有 agents
{"action": "list_agents"}

// 同步 agents 到 Redis
{"action": "sync_agents_to_redis"}

// 创建新 agent
{
  "action": "create_agent",
  "agentName": "sales",
  "capabilities": ["sales", "crm"],
  "role": "销售专员"
}
```

---

## 🛠️ CLI 工具

### Agent → Agent (A2A)

```bash
# 直接发给指定 Agent
wegirl-cli send --target agent:scout --message "分析 https://example.com"

# 按能力匹配（自动选择负载最低的 Agent）
wegirl-cli send --target "capability:url-discovery:least-load" --message "发现 URL"

# 广播给所有在线 Agent
wegirl-cli send --target broadcast --message "系统维护通知"

# 多 Agent 群聊（聚合回复）
wegirl-cli send \
  --target agent:scout,agent:analyst \
  --message "分析 example.com" \
  --chatType group \
  --chatId oc_xxx
```

### Agent → Human (A2H)

```bash
# 创建任务（人类审批型）
wegirl-cli task.create \
  --userId tiger \
  --type url_review \
  --title "审批 example.com 的 URL" \
  --description "发现 50 个 URL，请审批" \
  --priority high

# 查看某人的待办
wegirl-cli pending --userId tiger

# 列出某人的任务
wegirl-cli task.list --userId tiger --status pending

# 审批任务
wegirl-cli task.decide \
  --taskId task_xxx \
  --decision approve \
  --decisionBy tiger \
  --message "全部通过"

# 注册人类用户（带能力标签）
wegirl-cli human.register \
  --userId tiger \
  --name "Tiger" \
  --capabilities "url-review,content-approval"
```

### 监控与调试

```bash
# 健康检查
wegirl-cli health

# Stream 状态
wegirl-cli stream.status --instanceId wegirl001

# 发送消息（单 agent）
wegirl-cli send --target agent:scout --message "分析这个网站"

# 发送消息（多 agent 群聊）
wegirl-cli send \
  --target agent:scout,agent:analyst \
  --message "分析 example.com" \
  --chatType group \
  --chatId oc_xxx
```

### 完整 CLI 文档

| 命令 | 类型 | 说明 |
|------|------|------|
| `send` | A2A | 发送消息给 Agent（支持单/多/广播/能力匹配）|
| `task.create` | A2H | 创建人类任务 |
| `task.list` | A2H | 列出任务 |
| `task.decide` | A2H | 审批任务 |
| `pending` | A2H | 查看待办数量 |
| `human.register` | A2H | 注册人类用户 |
| `health` | 系统 | 健康检查 |
| `stats` | 系统 | 系统统计（Agent/Human/Task）|
| `stream.status` | 系统 | Stream 详细状态 |
| `agents` | 系统 | 列出所有 Agent 和 Human |

---

## 📊 Redis 数据结构

### A2A (Agent → Agent)

| Key | 类型 | 用途 |
|-----|------|------|
| `wegirl:agents:{id}` | Hash | Agent 注册信息（状态、能力、心跳）|
| `wegirl:capability:{cap}` | Set | 能力索引（拥有某能力的 Agent 集合）|
| `wegirl:stream:instance:{id}` | Stream | 跨实例消息流（MAXLEN ~5000）|
| `wegirl:forward` | Pub/Sub | A2A 请求消息广播 |
| `wegirl:replies` | Pub/Sub | A2A 回复消息广播 |
| `wegirl:task:{id}:results` | Hash | 多 agent 任务结果（临时，1h TTL）|

### A2H (Agent → Human)

| Key | 类型 | 用途 |
|-----|------|------|
| `wegirl:humans:{id}` | Hash | 人类用户信息（能力、偏好、在线状态）|
| `wegirl:task:{id}` | Hash | 任务详情（类型、状态、审批信息）|
| `wegirl:tasks:{userId}:by_status` | ZSet | 用户任务按状态索引（score=时间戳）|
| `wegirl:pending:{userId}` | ZSet | 待办队列（按优先级+时间排序）|

### 数据流向图

```
A2A:
  Agent A ──→ wegirl:forward (Pub/Sub)
                 ↓
            wegirl:stream (Stream)
                 ↓
  Agent B ←─── wegirl:replies (Pub/Sub)

A2H:
  Agent ──→ wegirl:task:{id} (Hash)
              + wegirl:tasks:{userId}:by_status (ZSet)
              + wegirl:pending:{userId} (ZSet)
                 ↓
  Human ◄─── 待办通知（Heartbeat/Cron）
                 ↓
  Human ──→ wegirl:task:decision (Pub/Sub) ──→ Agent
```

---

## 🔧 开发

```bash
# 开发模式
npm run dev

# 构建
npm run build

# 运行测试
npm test
```

---

## 📜 许可证

MIT

---

## 🔗 相关项目

- [OpenClaw](https://github.com/openclaw/openclaw) - AI Agent 运行时
- [ClawHub](https://clawhub.com) - Agent 技能市场
