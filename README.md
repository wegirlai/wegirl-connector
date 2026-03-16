# WeGirl Connector v2.0

WeGirl 是 OpenClaw 的多 Agent 编排中枢插件，基于 Redis 实现跨实例 Agent 通信、能力匹配、任务调度和 Stream 监控。

## 功能特性

- **Agent 管理**：注册、心跳、能力索引、在线状态
- **智能路由**：直接寻址、能力匹配（least-load/round-robin/random）、广播
- **跨实例通信**：基于 Redis Stream 的可靠消息传递（MAXLEN ~5000 自动清理）
- **任务队列**：人类用户待办任务管理（创建、审批、完成）
- **Stream 监控**：实时查看 Stream 状态、Consumer Group、Pending 消息
- **CLI 工具**：完整的命令行管理工具

## 安装

```bash
# 克隆仓库
git clone https://github.com/wegirlai/wegirl-connector.git
cd wegirl-connector

# 安装依赖
npm install

# 编译 TypeScript
npm run build

# 链接 CLI 工具（可选）
npm link
```

## OpenClaw 配置

在 `openclaw.json` 中添加：

```json
{
  "channels": {
    "wegirl": {
      "enabled": true,
      "dmPolicy": "open",
      "accounts": {
        "default": {
          "enabled": true,
          "redisUrl": "redis://localhost:6379",
          "redisPassword": "your-password",
          "redisDb": 1
        }
      }
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

## CLI 工具

WeGirl 提供完整的 CLI 管理工具 `wegirl-cli`（23 个命令）：

### 系统状态

```bash
# 健康检查
wegirl-cli health

# 连接测试
wegirl-cli test

# 系统统计（Redis 内存、Agent/Human/Task 数量）
wegirl-cli stats
```

### Stream 监控

```bash
# 查看 Stream 完整状态
wegirl-cli stream.status --instanceId wegirl001

# 查看所有 Consumers
wegirl-cli stream.consumers --instanceId wegirl001

# 查看最新消息（--reverse 倒序，--count 指定数量）
wegirl-cli stream.entries --instanceId wegirl001 --count 10 --reverse

# 清空 Stream（危险操作，需 --force 确认）
wegirl-cli stream.clear --instanceId wegirl001 --force
```

### Agent 管理

```bash
# 列出所有 Agents 和 Humans
wegirl-cli agents

# 按状态/能力筛选 Agents
wegirl-cli agent.list --status online --capability url-discovery

# 获取单个 Agent 详情
wegirl-cli agent.get --agentId scout
```

### Human 管理

```bash
# 注册人类用户
wegirl-cli human.register --userId tiger --name "Tiger" --capabilities "url-review,content-approval"

# 注销人类用户
wegirl-cli human.unregister --userId tiger
```

### 任务管理

```bash
# 创建任务
wegirl-cli task.create --userId tiger --type url_review --title "审查 example.com" --description "详细描述" --priority high

# 列出任务
wegirl-cli task.list --userId tiger --status pending --limit 10

# 获取任务详情
wegirl-cli task.get --taskId task_xxx

# 更新任务状态
wegirl-cli task.update --taskId task_xxx --status approved

# 审批任务（approve/reject）
wegirl-cli task.decide --taskId task_xxx --decision approve --decisionBy tiger --message "同意"

# 删除任务
wegirl-cli task.delete --taskId task_xxx

# 查看待办数量
wegirl-cli pending --userId tiger
```

### 发送消息

```bash
# 发送给 Human（创建 Task）
wegirl-cli send --target human:tiger --message "请审批" --from scout

# 发送给 Agent（通过 Stream，支持跨实例）
wegirl-cli send --target agent:scout --message "请分析 https://example.com/" --from tiger --channel feishu --accountId scout-notifier --chatId oc_xxx --chatType direct
```

### 其他查询

```bash
# 能力统计
wegirl-cli capability.stats

# 最近事件
wegirl-cli event.recent --limit 10 --type agent_start

# 事件统计
wegirl-cli event.stats
```

## OpenClaw Tool 使用

### wegirl_send - 发送消息

```javascript
// 发送给其他 Agent
{
  "tool": "wegirl_send",
  "params": {
    "target": "agent:scout",
    "message": "请分析这个网站"
  }
}

// 按能力匹配
{
  "tool": "wegirl_send",
  "params": {
    "target": "capability:url-discovery:least-load",
    "message": "发现 URL"
  }
}

// 发给人类用户
{
  "tool": "wegirl_send",
  "params": {
    "target": "human:tiger",
    "message": "请审批这个申请"
  }
}

// 广播
{
  "tool": "wegirl_send",
  "params": {
    "target": "broadcast",
    "message": "系统维护通知"
  }
}
```

### Target 格式

| 格式 | 示例 | 说明 |
|------|------|------|
| `agent:id` | `agent:scout` | 直接发给指定 Agent |
| `human:id` | `human:tiger` | 发给指定人类用户（创建 Task）|
| `capability:name:strategy` | `capability:code:least-load` | 按能力匹配，策略：least-load/round-robin/random |
| `broadcast` | `broadcast` | 广播给所有在线 Agent |

## Redis 数据结构

| Key | 类型 | 说明 |
|-----|------|------|
| `wegirl:agents:{agentId}` | Hash | Agent 信息（状态、能力、心跳等）|
| `wegirl:humans:{userId}` | Hash | 人类用户信息 |
| `wegirl:capability:{cap}` | Set | 拥有该能力的 Agent 集合 |
| `wegirl:task:{taskId}` | Hash | 任务详情 |
| `wegirl:tasks:{userId}:by_status` | ZSet | 用户任务按状态索引 |
| `wegirl:stream:instance:{id}` | Stream | 跨实例消息流（MAXLEN ~5000）|

## 消息流向

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   Agent A   │────►│  Redis      │────►│   Agent B   │
│ (Instance 1)│     │  Stream     │     │ (Instance 2)│
└─────────────┘     └─────────────┘     └─────────────┘
                            │
                            ▼
                    ┌─────────────┐
                    │ Consumer    │
                    │ Group       │
                    │ (wegirl-   │
                    │ consumers)  │
                    └─────────────┘
```

## 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `REDIS_URL` | Redis 连接地址 | `redis://localhost:6379` |
| `REDIS_PASSWORD` | Redis 密码 | - |
| `REDIS_DB` | Redis 数据库 | `1` |
| `OPENCLAW_INSTANCE_ID` | 实例 ID | `instance-local` |

## 开发

```bash
# 开发模式（自动编译）
npm run dev

# 运行测试
npm test

# 构建
npm run build
```

## 许可证

MIT

## 相关项目

- [OpenClaw](https://github.com/openclaw/openclaw) - AI Agent 运行时
- [ClawHub](https://clawhub.com) - Agent 技能市场
