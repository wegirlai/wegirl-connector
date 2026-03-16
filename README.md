# WeGirl Connector v2.0

## 概述

WeGirl Connector 是 OpenClaw 的多 Agent 编排中枢插件，提供跨实例 Agent 通信、能力匹配、工作流编排和人类用户队列管理。

## 架构

```
┌─────────────────────────────────────────────────────────────┐
│                    wegirl (Redis 中枢)                       │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐    │
│  │ 全局目录  │  │ 能力匹配  │  │ 工作流    │  │ 消息路由  │    │
│  │ 心跳管理  │  │ 负载均衡  │  │ 状态机    │  │ 跨实例转发│    │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘    │
└─────────────────────────────────────────────────────────────┘
                              │
        ┌─────────────────────┼─────────────────────┐
        │                     │                     │
   ┌────▼────┐          ┌────▼────┐          ┌────▼────┐
   │OpenClaw │◄─Redis──►│OpenClaw │◄─Redis──►│OpenClaw │
   │ 实例A   │          │ 实例B   │          │ 实例C   │
   └─────────┘          └─────────┘          └─────────┘
```

## 功能特性

- **Agent 注册与发现**：启动时自动注册，心跳保活
- **智能路由**：支持直接寻址、能力匹配、工作流路由
- **跨实例通信**：基于 Redis Stream 的可靠消息传递
- **人类用户队列**：离线/忙碌时入队，上线时推送
- **监控审计**：消息镜像和流转追踪

## 安装

```bash
cd /root/.openclaw/extensions/wegirl-connector
npm install
npm run build
```

## 配置

在 `openclaw.json` 中添加：

```json
{
  "plugins": {
    "wegirl-connector": {
      "redisUrl": "redis://localhost:6379",
      "redisPassword": "your-password",
      "redisDb": 0,
      "keyPrefix": "wegirl:"
    }
  }
}
```

## 工具使用

### 1. wegirl_send - 发送消息

```javascript
// 发送给其他 Agent
{
  "tool": "wegirl_send",
  "params": {
    "target": "agent:zhongshu",
    "message": "请审议这个方案",
    "options": {
      "priority": "high",
      "waitForReply": false
    }
  }
}

// 按能力匹配
{
  "tool": "wegirl_send",
  "params": {
    "target": "capability:code_review:least-load",
    "message": "请审查这段代码",
    "context": {
      "requirements": {
        "language": "typescript",
        "focus": "security"
      }
    }
  }
}

// 工作流路由
{
  "tool": "wegirl_send",
  "params": {
    "target": "workflow:approval-flow:2",
    "message": "提交审批",
    "context": {
      "workflowId": "approval-flow",
      "step": 2
    }
  }
}

// 发给人类用户
{
  "tool": "wegirl_send",
  "params": {
    "target": "human:zhangsan",
    "message": "请审批这个采购申请",
    "options": {
      "priority": "urgent"
    }
  }
}
```

### 2. wegirl_register - 注册 Agent

```javascript
{
  "tool": "wegirl_register",
  "params": {
    "agentInfo": {
      "agentId": "bingbu",
      "name": "兵部",
      "capabilities": ["code", "review", "deploy"],
      "maxConcurrent": 3,
      "supportedModels": ["gpt-4", "claude-3"]
    }
  }
}
```

### 3. wegirl_query - 查询信息

```javascript
// 查询在线 Agent
{
  "tool": "wegirl_query",
  "params": {
    "queryType": "agents"
  }
}

// 按能力查询
{
  "tool": "wegirl_query",
  "params": {
    "queryType": "capabilities",
    "filter": {
      "capability": "code_review",
      "strategy": "least-load"
    }
  }
}

// 查询人类用户
{
  "tool": "wegirl_query",
  "params": {
    "queryType": "humans",
    "filter": {
      "capability": "财务审批",
      "requireOnline": true
    }
  }
}
```

## Target 格式

| 格式 | 示例 | 说明 |
|------|------|------|
| agent:id | `agent:zhongshu` | 直接发给指定 Agent |
| human:id | `human:zhangsan` | 发给指定人类用户 |
| capability:name:strategy | `capability:code:least-load` | 按能力匹配，策略可选 |
| workflow:id:step | `workflow:flow:2` | 工作流路由到指定步骤 |
| broadcast | `broadcast` | 广播给所有在线 Agent |

## 消息协议

```json
{
  "metadata": {
    "msgId": "uuid",
    "traceId": "uuid",
    "timestamp": 1234567890,
    "priority": "normal",
    "version": "1.0"
  },
  "from": {
    "type": "agent",
    "agentId": "xxx",
    "instanceId": "xxx"
  },
  "to": {
    "type": "agent",
    "agentId": "xxx"
  },
  "type": "request",
  "payload": {
    "content": "消息内容"
  },
  "routing": {
    "mode": "agent",
    "agentId": "xxx"
  }
}
```

## Redis 数据结构

| Key | 类型 | 说明 |
|-----|------|------|
| `wegirl:agents:{agentId}` | Hash | Agent 信息 |
| `wegirl:humans:{userId}` | Hash | 人类用户信息 |
| `wegirl:capability:{cap}` | Set | 拥有该能力的 Agent 集合 |
| `wegirl:instance:{id}:agents` | Set | 实例下的 Agent 集合 |
| `wegirl:pending:{userId}` | ZSet | 人类用户待办队列 |
| `wegirl:messages` | Stream | 跨实例消息流 |
| `wegirl:instance:{id}` | Pub/Sub | 实例私有频道 |

## Gateway 方法

```bash
# 查询最近事件
openclaw wegirl.recent --limit 10

# 查询统计
openclaw wegirl.stats

# 健康检查
openclaw wegirl.health

# 重新连接 Redis
openclaw wegirl.reconnect

# 查询 Agent 列表
openclaw wegirl.agents

# 查询待办队列
openclaw wegirl.pending --userId zhangsan
```

## 开发计划

- [x] 消息协议定义
- [x] Agent 注册/心跳
- [x] 能力匹配路由
- [x] 跨实例消息传递
- [x] 人类用户队列
- [ ] 工作流状态机（进行中）
- [ ] 消息可靠投递（ACK 机制）
- [ ] 监控 Dashboard

## 注意事项

1. 所有 Agent 必须使用 `wegirl_send` 进行跨 Agent 通信
2. SOUL.md 中应约束 Agent 使用 wegirl 工具
3. Redis 连接断开会自动重连，但消息可能丢失
4. 跨实例通信依赖共享 Redis 实例
# wegirl
