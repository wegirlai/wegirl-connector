# MILESTONE-v2.3.0.md

## WeGirl Connector v2.3.0

### 发布日期
2026-04-03

### 重大变更

#### 🔥 移除 `human:` 前缀（Breaking Change）
- **不再使用 `human:` 前缀标识人类用户**
- **使用 Redis 查询自动判断目标类型**（通过 `wegirl:staff:{id}` 的 `type` 字段）
- **简化 target 格式**：`ou_xxx` 或 `source:xxx` 直接作为 target

**变更前:**
```typescript
// 旧格式
wegirl_send({
  target: "human:ou_4e02babe553966f5b9858d5a3196c10a",
  replyTo: "human:tiger"
});
```

**变更后:**
```typescript
// 新格式
wegirl_send({
  target: "ou_4e02babe553966f5b9858d5a3196c10a",
  replyTo: "tiger"
});
```

#### 🧬 Agent 性格与能力管理
- **新增 `update_agent_profile` action** - 更新 Agent 性格和能力
- **新增 `get_agent_profile` action** - 获取 Agent 详细档案
- **Redis 数据结构扩展**:
  - `wegirl:staff:{staffId}` - 存储 personality（JSON）、capabilities（JSON）
  - `wegirl:capability:{cap}` - 能力索引 Set
  - `wegirl:personality:{trait}` - 性格标签索引 Set

**档案结构:**
```json
{
  "staffId": "hr",
  "type": "agent",
  "name": "HR Agent",
  "personality": {
    "vibe": "守护型中二",
    "traits": ["细心", "唠叨", "温暖"],
    "emoji": "❤️‍🔥",
    "voice": "温暖",
    "style": "碎碎念式陪伴"
  },
  "capabilities": ["agent-management", "onboarding", "staff-sync"],
  "workspace": "/root/.openclaw/workspaces/hr"
}
```

#### 🔒 Consumer Group 隔离
- **每个 agent 独立的 consumer group**
- **命名格式**: `wegirl-consumers-${instanceId}-${accountId}`
- **消除 "Consumer group already exists" 警告**

#### 📤 Outbound 适配器
- **新增默认 outbound 配置**
- **解决**: `Outbound not configured for channel: wegirl` 错误
- **实现**: `sendText`, `sendCard`, `updateMessage` 方法

### 文件变更

| 文件 | 变更 |
|------|------|
| `src/tools.ts` | 移除 `human:` 前缀解析，简化 target 处理 |
| `src/index.ts` | 新增 `update_agent_profile`/`get_agent_profile` actions，修改 replyTo 处理 |
| `src/core/sessions-send.ts` | 添加 `replyTo: 'system:no_reply'` 防止转发循环 |
| `src/router.ts` | 使用 Redis 查询判断 target 类型 |
| `src/monitor.ts` | 独立 consumer group 命名 |
| `src/channel.ts` | 添加 outbound 适配器 |
| `src/protocol.ts` | 更新注释，移除 `human:xxx` 格式说明 |

### HR Manage 工具增强

**新增 Actions:**
- `get_agent_profile` - 获取 Agent 详细档案（性格、能力、工作空间）
- `update_agent_profile` - 更新 Agent 档案

**返回格式更新:**
```json
// list_staffs 现在返回 personality 和 capabilities
{
  "success": true,
  "agents": [{
    "accountId": "hr",
    "name": "HR Agent",
    "personalityVibe": "守护型中二",
    "capabilities": ["agent-management", "onboarding"]
  }]
}
```

### 兼容性

- **破坏性变更**: 移除 `human:` 前缀支持
- **升级路径**: 
  1. 更新所有 `target: "human:xxx"` → `target: "xxx"`
  2. 更新所有 `replyTo: "human:xxx"` → `replyTo: "xxx"`

### 性能优化
- 减少字符串前缀解析开销
- Redis 查询缓存 staff 类型信息

### Bug 修复
- 修复 "Consumer group already exists" 警告
- 修复 "Outbound not configured for channel: wegirl" 错误
- 修复转发消息缺少 `replyTo` 导致的错误

---

**Full Changelog**: 对比 v2.2.0...v2.3.0
