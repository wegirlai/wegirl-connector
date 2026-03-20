# WeGirl Connector

OpenClaw Gateway 插件 - 微妞 AI 多 Agent 消息路由中枢

## 功能

- **多 Agent 消息路由**: H2A (Human→Agent), A2A (Agent→Agent), A2H (Agent→Human)
- **Redis Stream 消费**: 消费 wegirl-service 发送的消息
- **统一 StaffId 抽象**: 人类和 Agent 统一使用 StaffId 标识
- **跨实例通信**: 支持多实例部署的消息路由

## 架构

```
Redis Stream ←→ WeGirl Connector ←→ OpenClaw Agents
                     ↓
              wegirl_send (Tool)
```

---

## 📌 里程碑

### v2.0 (2026-03-21) ⭐ Current

**架构升级**:
- ✅ 统一 StaffId 抽象（人类和 Agent 统一标识）
- ✅ 新接口语义：flowType/source/target
- ✅ `wegirl_send` 成为主接口（原接口改为 `wegirl_send_v1` 废弃）
- ✅ 移除 V1 格式支持，仅保留 V2 格式

**消息流支持**:
- ✅ H2A (Human→Agent) - 人类向 Agent 发送消息
- ✅ A2A (Agent→Agent) - Agent 间通信
- ✅ A2H (Agent→Human) - Agent 向人类回复

**HR 入职流程**:
- ✅ 未绑定人类使用 openId 作为临时 staffId
- ✅ `hr_manage` 工具处理入职登记
- ✅ 自动生成入职登记表单

**Bug 修复**:
- ✅ replyTo 解析支持字符串 open_id
- ✅ 为所有 Agent 配置 anthropic auth profile

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
{
  flowType: "H2A",  // 或 "A2A", "A2H"
  source: "ou_human_openid",
  target: "hr",
  message: "我要入职",
  chatType: "direct"
}
```

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
