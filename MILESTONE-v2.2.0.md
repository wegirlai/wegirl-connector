# MILESTONE-v2.2.0

## 发布日期
2026-04-02

## 版本概述
重构为飞书模式：每个 agent 独立监听自己的 Redis Stream，顺序消费消息

## 重大架构变更

### 1. 独立 Stream 架构 ✅

**之前（v2.1.x）**:
```
wegirl:stream:global:instanceId  ← 所有消息写入同一个 stream
    └── 多个消费者竞争读取 → 并发冲突
```

**现在（v2.2.0）**:
```
wegirl:stream:instanceId:analyst     ← analyst 专属 stream
wegirl:stream:instanceId:harvester   ← harvester 专属 stream  
wegirl:stream:instanceId:picmaker    ← picmaker 专属 stream
    └── 每个 agent 独立消费 → 顺序处理，无并发冲突
```

### 2. 飞书模式实现 ✅

参考飞书插件架构，实现 `monitorWeGirlProvider`：

```typescript
// gateway.startAccount 为每个 account 启动独立 monitor
async startAccount(ctx) {
  return monitorWeGirlProvider({
    accountId,
    instanceId,
    cfg: ctx.cfg,
    abortSignal: ctx.abortSignal,
    log: ctx.log
  });
}

// monitor 函数：长期运行，顺序消费
async function monitorWeGirlProvider(params) {
  const { accountId, instanceId, abortSignal } = params;
  const streamKey = `wegirl:stream:${instanceId}:${accountId}`;
  
  // 1. 创建 Redis 连接
  const redis = new Redis({...});
  await redis.connect();
  
  // 2. 创建消费者组
  await redis.xgroup('CREATE', streamKey, consumerGroup, '$', 'MKSTREAM');
  
  // 3. 顺序消费循环（直到 abortSignal 触发）
  while (!abortSignal?.aborted) {
    const messages = await redis.xreadgroup(
      'GROUP', consumerGroup, consumerName,
      'BLOCK', 5000, 'COUNT', 1,  // 每次只读 1 条
      'STREAMS', streamKey, '>'
    );
    
    for (const message of messages) {
      // 4. 调用 wegirlSessionsSend 处理消息
      await wegirlSessionsSend({...message, fromType: 'outer'});
      
      // 5. 确认消息
      await redis.xack(streamKey, consumerGroup, message.id);
    }
  }
  
  await redis.quit();
}
```

### 3. wegirl-service 发送端同步修改 ✅

```python
# forward_to_redis_stream 函数修改
def forward_to_redis_stream(redis_url, instance_id, message):
    # 根据 target agent 构建独立的 stream key
    target_agent = message.get('target', 'unknown')
    stream_key = f"wegirl:stream:{instance_id}:{target_agent}"
    
    # XADD 到对应 agent 的 stream
    message_id = r.xadd(
        stream_key,
        {"data": json.dumps(message)},
        maxlen=10000
    )
```

## 技术细节

### Stream Key 格式

```
wegirl:stream:{instanceId}:{accountId}

示例:
- wegirl:stream:wegirl001:analyst
- wegirl:stream:wegirl001:harvester
- wegirl:stream:wegirl001:picmaker
```

### 消费者组设计

```
消费者组名: wegirl-consumers-{instanceId}
消费者名: {accountId}-{timestamp}

示例:
- 组: wegirl-consumers-wegirl001
- 消费者: analyst-1775066069035
```

### 消息处理流程

```
1. 飞书消息 → wegirl-service
2. wegirl-service 根据 target agent 选择 stream
3. XADD 到 wegirl:stream:instanceId:target
4. wegirl-connector monitor 读取消息
5. 调用 wegirlSessionsSend → dispatchReplyWithBufferedBlockDispatcher
6. Agent 处理 → 回复写入 wegirl:replies
7. wegirl-service 转发回复到飞书
```

## 优势

| 特性 | v2.1.x (全局 Stream) | v2.2.0 (独立 Stream) |
|------|---------------------|---------------------|
| **并发度** | 高（多消费者竞争） | 低（单消费者顺序） |
| **消息顺序** | 可能乱序 | 严格顺序 |
| **隔离性** | 相互影响 | 完全隔离 |
| **故障恢复** | 复杂 | 独立（一个 agent 失败不影响其他） |
| **资源占用** | 一个 Redis 连接 | 多个 Redis 连接（每个 agent） |

## 文件变更

### 新增文件
- `src/monitor.ts` - 独立的 monitor 实现

### 修改文件
- `src/channel.ts` - 添加 `gateway.startAccount` 调用 `monitorWeGirlProvider`
- `src/core/sessions-send.ts` - 保持 `dispatchReplyWithBufferedBlockDispatcher`
- `dist/*` - 编译后的文件

### wegirl-service 配合修改
- `src/wegirl_service/services/feishu_ws_process.py` - `forward_to_redis_stream` 使用独立 stream key

## 已知限制

1. **Redis 连接数增加**: 每个 agent 需要一个独立连接（N 个 agents = N 个连接）
2. **内存占用**: 每个 monitor 长期运行，占用一定内存
3. **健康检查**: 目前依赖 OpenClaw 的 channel health-monitor

## 回滚方案

如需回滚到 v2.1.x 架构：
1. 恢复 `src/channel.ts` 使用简单的 keep-alive loop
2. 移除 `src/monitor.ts`
3. 恢复 `src/index.ts` 的全局 stream 消费
4. 恢复 wegirl-service 的全局 stream key

## 测试验证

```bash
# 1. 检查所有 agent 的 monitor 已启动
grep "Starting monitor" /root/.openclaw/logs/openclaw.log

# 2. 发送测试消息
cd /root/wegirl-service
venv/bin/python -c "
import redis
r = redis.Redis(host='10.8.0.1', port=6379, db=1, password='microsoul**')
r.xadd('wegirl:stream:wegirl001:picmaker', {'data': '...'})
"

# 3. 检查消息被处理
grep "picmaker.*Processing" /root/.openclaw/logs/openclaw.log
```

## 后续计划

- [ ] 优化 Redis 连接池复用
- [ ] 添加 monitor 健康检查指标
- [ ] 支持动态 agent 注册/注销
