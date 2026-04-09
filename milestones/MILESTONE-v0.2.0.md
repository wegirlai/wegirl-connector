# WeGirl Connector v0.2.0 里程碑

## 发布日期
2026-03-17

## 核心功能

### wegirl_send 工具
- ✅ 统一消息发送接口
- ✅ 支持多种目标模式：
  - `agent:id` - 直接发送到指定 Agent
  - `human:id` - 发送到人类用户
  - `capability:name` - 按能力匹配 Agent
  - `workflow:id` - 发送到工作流
  - `broadcast` - 广播到所有 Agent

### 消息路由优化
- ✅ 基于 sessionKey 的智能路由解析
- ✅ 支持 wegirl 频道消息派发到对应 Agent
- ✅ 改进会话匹配逻辑

### 跨服务通信
- ✅ Redis Stream 消息消费
- ✅ 与 wegirl-service 双向通信
- ✅ 支持群聊和私聊场景

## 技术架构

```
OpenClaw Gateway
        │
        ├── wegirl_send() 工具
        │       └── 写入 Redis
        │
        └── Redis Stream 消费者
                │
                ▼
        派发到对应 Agent Session
```

## 使用示例

### 发送给指定 Agent
```typescript
await wegirl_send({
  target: "agent:scout",
  message: "帮我收集 example.com 的所有 URL"
});
```

### 按能力匹配
```typescript
await wegirl_send({
  target: "capability:url-discovery:least-load",
  message: "抓取这些 URL",
  context: { urls: [...] }
});
```

## API 变更

### 新增 Tools
- `wegirl_send` - 统一消息发送
- `wegirl_register` - Agent 自注册
- `wegirl_query` - 查询在线 Agent

### 修改文件
- `src/sessions-send.ts` - 实现 wegirl_send 核心逻辑
- `src/channel.ts` - 优化 sessionKey 路由

## 配置

```yaml
channels:
  wegirl:
    redisUrl: redis://localhost:6379/1
    streamKey: wegirl:messages
    consumerGroup: wegirl-consumers
```

## 已知问题
- 需要保持与 wegirl-service 的 sessionKey 格式一致

## 下一步
- [ ] 支持消息确认机制（ack）
- [ ] 添加消息重试逻辑
- [ ] 实现 Agent 负载均衡
