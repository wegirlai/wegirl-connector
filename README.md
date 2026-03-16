# WeGirl Connector

WeGirl 是 OpenClaw 的多 Agent 编排中枢插件，基于 Redis 实现跨实例 Agent 通信、任务调度和消息聚合。

---

## 📌 里程碑

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

## 🛠️ CLI 工具

### 基础命令

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

| 命令 | 说明 |
|------|------|
| `health` | 系统健康检查 |
| `stats` | 系统统计（Agent/Human/Task 数量）|
| `stream.status` | Stream 详细状态 |
| `stream.entries` | 查看 Stream 消息 |
| `agents` | 列出所有 Agent 和 Human |
| `send` | 发送消息（支持单/多 agent）|
| `task.create` | 创建任务 |
| `task.list` | 列出任务 |

---

## 📊 Redis 数据结构

| Key | 类型 | 用途 |
|-----|------|------|
| `wegirl:agents:{id}` | Hash | Agent 信息 |
| `wegirl:humans:{id}` | Hash | 人类用户信息 |
| `wegirl:capability:{cap}` | Set | 能力索引 |
| `wegirl:stream:instance:{id}` | Stream | 跨实例消息流 |
| `wegirl:task:{id}:results` | Hash | 多 agent 任务结果（临时）|
| `wegirl:forward` | Pub/Sub | 请求消息通道 |
| `wegirl:replies` | Pub/Sub | 回复消息通道 |

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
