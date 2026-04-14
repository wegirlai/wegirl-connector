# MILESTONE-v1.0.6.md - `from` 字段协议升级

**版本**: v1.0.6  
**日期**: 2026-04-14  
**状态**: ✅ 已发布

---

## 概述

重构消息协议，引入 `from` 字段标识消息来源系统，替代原有的 `flowType === "S2S"` 判断逻辑，使消息路由更加语义化和可扩展。

---

## 变更内容

### 1. 协议规范升级

**新增 `from` 字段**：
```typescript
{
  from: "world" | "service" | "dashboard" | string,
  flowType: "H2A" | "A2A" | "A2H" | "S2S",
  source: string,
  target: string,
  ...
}
```

**发送方标识**：
| 系统 | from 值 |
|-----|---------|
| wegirl-world | `"world"` |
| wegirl-service | `"service"` |
| wegirl-dashboard-server | `"dashboard"` |
| 其他 Agent | staffId（默认）|

### 2. 回复路由逻辑变更

**原来的逻辑**（基于 flowType）：
```typescript
if (outboundFlowType === 'S2S') {
  await pub.xadd('wegirl:stream:world', reply);
}
```

**新的逻辑**（基于 from）：
```typescript
if (originalMetadata?.from === 'world') {
  await pub.xadd('wegirl:stream:world', reply);
}
```

**关键变化**：
- 不再根据消息类型（flowType）判断，而是根据来源（from）
- 只有 `from === "world"` 时，Agent 回复才会额外多发一份到 `wegirl:stream:world`
- `from === "service"` 或 `"dashboard"` 时，只走正常回复通道

### 3. 代码修改点

#### wegirl-connector
- **文件**: `src/core/sessions-send.ts`
- **修改**: `handleAgentReply` 函数中，判断条件从 `flowType === 'S2S'` 改为 `from === 'world'`

#### wegirl-world
- **文件**: `src/engine.py`
- **修改**: 
  - `send_s2s_stream` 发送消息时添加 `"from": "world"`
  - `_send_a2h_stream` 发送消息时添加 `"from": "world"`

#### wegirl-service
- **文件**: `src/wegirl_service/services/feishu_ws_process.py`
- **修改**: `forward_message` 构造时添加 `"from": "service"`

#### wegirl-dashboard-server
- **文件**: `app/websocket.py`
- **修改**: H2A 消息构造时添加 `"from": "dashboard"`

---

## 好处

1. **语义清晰**：不再关心消息是什么类型，只关心该回给谁
2. **扩展性好**：world 以后发任何消息（任务、通知、状态），agent 都能自动正确回复
3. **统一入口**：world 内部不管 director 还是 engine 发消息，统一 `from: "world"`
4. **避免遗漏**：新消息类型无需额外处理逻辑，只要 `from === "world"` 就自动生效

---

## 兼容性

- **旧消息**：没有 `from` 字段的消息，走默认逻辑（不触发 world stream）
- **新消息**：所有发送方都已添加 `from` 字段
- **Agent 回复**：仅当检测到 `from === "world"` 时才额外发送 stream

---

## 测试验证

### World 发送 S2S 导演指令
```python
# World Director.tick() 发送
{
  "from": "world",
  "flowType": "S2S",
  "source": "npc_001",
  "target": "npc_001",
  "message": "{type: 's2s_prompt', ...}"
}
# Agent 回复 → 同时发送到 wegirl:replies + wegirl:stream:world
```

### World 发送任务分配
```python
# WorldEngine._schedule_agents() 发送
{
  "from": "world",
  "flowType": "S2S",
  "source": "hr",
  "target": "hr",
  "message": "{type: 'task_dispatch', ...}"
}
# Agent 回复 → 同时发送到 wegirl:replies + wegirl:stream:world
```

### Service 发送 H2A
```python
# wegirl-service 发送
{
  "from": "service",
  "flowType": "H2A",
  "source": "tiger",
  "target": "hr",
  "message": "..."
}
# Agent 回复 → 只发送到 wegirl:replies（不额外发 world stream）
```

---

## 相关文件

- `wegirl-connector/src/core/sessions-send.ts`
- `wegirl-world/src/engine.py`
- `wegirl-service/src/wegirl_service/services/feishu_ws_process.py`
- `wegirl-dashboard-server/app/websocket.py`

---

## 后续计划

- [ ] 观察生产环境消息流转情况
- [ ] 考虑 dashboard 是否需要类似 world 的回复机制（如有需要可扩展 `from === "dashboard"`）
- [ ] 文档更新：在协议文档中明确 `from` 字段的使用规范

---

*Agent ID: main | 角色: 主入口、任务分发 | 2026-04-14*
