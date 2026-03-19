# MILESTONE-v1.0.1.md

## WeGirl Connector v1.0.1

**发布日期**: 2026-03-19  
**代码**: `1de7ec9`

---

## 主要更新

### 🔧 Bug 修复

#### Redis 连接配置修复 (`src/channel.ts`)
- **问题**: `startAccount` 中只从 `account` 读取 `redisUrl`，未从 plugin config 读取
- **修复**: 优先从 `cfg?.plugins?.entries?.wegirl?.config?.redisUrl` 读取
- **影响**: 现在正确连接到配置的 Redis 地址（如 `10.8.0.1:6379`）

#### Redis 连接非阻塞 (`src/channel.ts`)
- **问题**: 连接等待阻塞 CLI 命令（如 `openclaw status` 卡住 10 秒）
- **修复**: 改为异步等待，`connectPromise` 不阻塞 channel 注册
- **影响**: CLI 命令现在即时返回

---

### ✨ 新功能

#### HR Manage 工具增强 (`src/index.ts`)
- **新增 Action**: `sync_agents_to_redis`
- **用途**: 手动同步本地 OpenClaw agents 到 Redis
- **返回**: `{ kept, removed, registered }` 统计信息

**示例用法**:
```json
{
  "action": "sync_agents_to_redis"
}
```

**完整 Actions 列表**:
| Action | 描述 |
|--------|------|
| `create_agent` | 创建新 agent |
| `list_agents` | 列出所有 agents |
| `get_agent` | 获取单个 agent |
| `delete_agent` | 删除 agent |
| `sync_agents_to_redis` | 同步 agents 到 Redis |

---

### 🔍 改进

#### Event Handlers 日志优化 (`src/event-handlers.ts`)
- **改进前**: `before_tool_call - read (command: cat file.txt)`
- **改进后**: `before_tool_call - read (target: /path/to/file.txt)`
- **逻辑**: 
  - `read`/`edit` 工具 → 显示文件路径
  - 其他工具 → 显示 command

---

## 配置示例

### openclaw.json

```json
{
  "channels": {
    "wegirl": {
      "enabled": true,
      "accounts": {
        "analyst": {
          "redisUrl": "redis://10.8.0.1:6379",
          "redisPassword": "your-password",
          "redisDb": 1,
          "enabled": true
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
          "redisUrl": "redis://10.8.0.1:6379",
          "redisPassword": "your-password",
          "redisDb": 1
        }
      }
    }
  },
  "bindings": [
    {
      "agentId": "analyst",
      "match": {
        "channel": "wegirl",
        "accountId": "analyst"
      }
    }
  ]
}
```

---

## 文件变更

```
src/channel.ts        | 70 ++++++++++++++++++++++++++++++------------
src/event-handlers.ts | 26 +++++++++++++---
src/index.ts          | 34 ++++++++++++++++++--
14 files changed, 208 insertions(+), 66 deletions(-)
```

---

## 已知问题

无

---

## 下一步

- [ ] 添加更多 agent 管理功能
- [ ] 完善工作流状态机
- [ ] 集成测试
