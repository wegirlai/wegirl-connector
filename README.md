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
