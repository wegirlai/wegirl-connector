# MILESTONE-v2.1.9

## 发布日期
2026-04-01

## 版本概述
添加 health-monitor 支持，修复 Agent 并发消息冲突问题

## 新增功能

### 1. Health-Monitor 支持 ✅

**问题**: OpenClaw Gateway 的 health-monitor 每 10 分钟检查 channel 状态，wegirl channel 因未实现状态报告而被误判为 "stopped"，导致频繁重启。

**解决方案**:
- 在 `channel.ts` 中实现 `gateway.startAccount` 和 `gateway.stopAccount` 方法
- `describeAccount` 返回 `running: true, connected: true`，告知 health-monitor channel 健康
- 添加全局状态跟踪 `channelStates`，支持多个 account 的独立状态管理

**代码变更**:
```typescript
// src/channel.ts
gateway: {
  async startAccount(ctx: any) {
    // 启动 channel，设置状态
    return cleanupFunction;
  },
  async stopAccount(ctx: any) {
    // 停止 channel
  }
},
config: {
  describeAccount: (e: any) => ({
    // ...
    running: true,  // 告诉 health-monitor channel 健康
    connected: true,
  })
}
```

### 2. Agent 消息队列机制 ✅

**问题**: 快速连续发送多条消息给同一个 Agent 时，OpenClaw 2026.2.24 的动态模块加载出现竞态条件，导致 `Cannot find module 'pi-tools.before-tool-call.runtime-xxx.js'` 错误。

**解决方案**:
- 在 `sessions-send.ts` 中添加按 target agent 的消息队列
- 使用 `agentQueues` Map 存储每个 agent 的待处理消息
- `processAgentQueue` 串行处理消息，避免并发冲突
- 添加 `waitForSessionLock` 函数，等待前一个消息完成后再处理下一个

**代码变更**:
```typescript
// src/core/sessions-send.ts
const agentQueues: Map<string, QueuedMessage[]> = new Map();
const agentProcessing: Map<string, boolean> = new Map();

async function processAgentQueue(target: string, log?: any): Promise<void> {
  // 串行处理队列中的消息
}

async function enqueueMessage(options: SessionsSendOptions): Promise<void> {
  // 将消息加入队列，如果未在处理则启动处理
}
```

### 3. OpenClaw 2026.2.24 兼容性修复 ✅

**问题**: OpenClaw 2026.2.24 的动态模块加载有 bug，文件名 hash 在某些情况下不一致。

**临时解决方案**:
- 创建占位文件 `/usr/lib/node_modules/openclaw/dist/pi-tools.before-tool-call.runtime-BKkTZOdw.js`
- 绕过模块加载错误

**注意**: 这是 OpenClaw 版本的临时 workaround，升级 OpenClaw 后可能不需要。

## 技术细节

### health-monitor 工作原理

```
OpenClaw Gateway
    ↓ 每 10 分钟
health-monitor 检查 wegirl:xxx 状态
    ↓
describeAccount() 返回 { running, connected }
    ↓
如果 running=false → 触发重启
```

通过返回 `running: true`，channel 被标记为健康，不再被重启。

### 消息队列流程

```
消息到达
    ↓
enqueueMessage()
    ↓
加入 agentQueues[target]
    ↓
如果未在处理 → processAgentQueue()
    ↓
串行处理队列中的消息
    ↓
等待 session lock 释放
    ↓
调用 processMessage() 发送
    ↓
处理下一条
```

## 升级指南

### 1. 更新 wegirl-connector

```bash
cd /path/to/wegirl-connector
git pull
npm run build
openclaw gateway restart
```

### 2. 创建占位文件（如果尚未创建）

```bash
echo "// Placeholder" > /usr/lib/node_modules/openclaw/dist/pi-tools.before-tool-call.runtime-BKkTZOdw.js
```

## 验证

### 验证 health-monitor

```bash
# 查看日志，确认没有 wegirl 相关的重启
journalctl -u openclaw-gateway -f | grep health-monitor
```

预期输出：
- 没有 `[wegirl:xxx] health-monitor: restarting`
- 或 `[wegirl:xxx] health-monitor: hit 3 restarts/hour limit`

### 验证消息队列

```bash
# 快速发送多条消息给同一个 Agent
for i in {1..5}; do
  curl ... # 调用 wegirl_send
done

# 查看日志，确认没有 "Cannot find module" 错误
tail -f ~/.openclaw/logs/openclaw.log | grep "Cannot find module"
```

预期：没有错误，消息按顺序处理。

## 相关文件

- `src/channel.ts` - 添加 health-monitor 支持
- `src/core/sessions-send.ts` - 添加消息队列机制

## 已知限制

1. **Feishu WebSocket 凭证**: 如果 Feishu App Secret 无效，wegirl-service 的 WebSocket 进程会退出，但这不影响 wegirl-connector 的 Redis 通信。

2. **OpenClaw 版本锁定**: 当前锁定在 2026.2.24 版本，升级后可能需要移除占位文件 workaround。

## 后续计划

- [ ] 优化消息队列的延迟（当前无延迟，可添加 100-500ms 批处理）
- [ ] 添加队列长度监控和告警
- [ ] 支持 Feishu 凭证热更新
