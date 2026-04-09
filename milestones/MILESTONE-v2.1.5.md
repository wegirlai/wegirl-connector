# MILESTONE-v2.1.5.md - WeGirl Connector v2.1.5

## 发布日期
2026-03-29

## 版本概述
添加插件注册成功事件，用于调试和监控插件初始化时机。

---

## 核心改进

### 1. Plugin Registered 事件

**修改**: `src/index.ts`

在插件注册成功且 Redis 连接就绪后，发送 `plugin_registered` 事件到 `wegirl:events`：

```typescript
// 发送插件注册成功事件到 wegirl:events
if (redisClient && redisClient.status === 'ready') {
  const eventData = {
    id: randomUUID(),
    type: 'plugin_registered',
    timestamp: Date.now().toString(),
    payload: JSON.stringify({
      instanceId: INSTANCE_ID,
      agentsRegistered: localAgents.length,
      redisStatus: redisClient.status,
      timestamp: new Date().toISOString()
    }),
    sessionId: 'global',
    userId: 'system',
    instanceId: INSTANCE_ID,
  };
  await redisClient.publish('wegirl:events', JSON.stringify(eventData));
}
```

**用途**:
- 监控插件初始化时机
- 验证防重复注册机制是否生效
- 统计注册 Agent 数量

---

## 文件变更

| 文件 | 变更类型 | 说明 |
|------|----------|------|
| `src/index.ts` | 修改 | 添加 plugin_registered 事件发送 |

---

## 兼容性

- ✅ 向后兼容：外部接口不变
- ✅ 不影响现有功能
- ✅ 需要配合 wegirl-monitor v2.x 查看事件

---

## 测试建议

1. 重启 OpenClaw Gateway
2. 检查 wegirl-monitor 是否收到 `plugin_registered` 事件
3. 验证事件内容包含 instanceId、agentsRegistered、redisStatus
4. 发送多条消息，确认插件只注册一次

---

## 相关提交

```bash
git add src/index.ts
git commit -m "v2.1.5: add plugin_registered event for debugging

- Send plugin_registered event to wegirl:events after registration
- Include instanceId, agentsRegistered, redisStatus in payload
- Help debug plugin initialization timing"
```
