# MILESTONE-v1.0.4.md

## 版本 v1.0.4 (2026-04-11)

### 概述
本次更新重点优化了 HR Tool 的稳定性，简化 create_agent 流程，并增强了错误处理机制。

### 主要变更

#### 1. 工具名统一 (Breaking Change)
- **变更**: `hr_manage` → `hr`
- **原因**: 简化工具名称，更符合直觉
- **影响**: HR Agent 的 SOUL.md 需要更新工具调用名称

#### 2. 删除 sync_agents_to_redis
- **删除原因**: 
  - 该功能会导致 HR Agent 在列出花名册时尝试同步数据
  - 同步失败会导致 OpenClaw 崩溃重启
- **替代方案**: 直接重启 OpenClaw 加载新配置

#### 3. create_agent 流程简化
**之前流程**:
1. 检查 agentName
2. 检查 accountId
3. 创建目录
4. 创建文件
5. 更新 openclaw.json
6. 注册到 Redis
7. 发布到 Stream

**现在流程**:
1. 检查 agentName
2. 检查 accountId
3. 创建目录
4. 创建文件
5. 更新 openclaw.json
6. **重启 OpenClaw** ← 直接生效

**优势**:
- 不需要维护 Redis 数据一致性
- 创建后立即生效
- 避免复杂的状态同步

#### 4. 不再创建的文件
- ~~`auth.json`~~
- ~~`models.json`~~

**原因**: OpenClaw 会自动处理认证和模型配置

#### 5. list_staffs 错误处理增强
**问题**: Redis 中存在非 hash 类型的 key（如 `:position`, `:capability:`）时，`hgetall` 会报错

**解决方案**:
- 严格过滤 key：只保留 `wegirl:staff:xxx` 格式（3 部分）
- 检查 key 类型：调用 `hgetall` 前先检查是否为 hash
- 单个 key 错误隔离：try-catch 包裹每个 key 的处理

#### 6. 执行错误处理
**问题**: 调用不存在的 action 或 Redis 错误会导致工具返回异常，OpenClaw 崩溃

**解决方案**:
- 添加 try-catch 包裹整个 execute 函数
- 返回格式化的错误信息而不是抛出异常

### 文件变更

| 文件 | 变更 |
|------|------|
| `src/index.ts` | 工具名 `hr_manage` → `hr`，删除 `sync_agents_to_redis`，添加 `create_agent`，增强错误处理 |
| `src/hr-manage-core.ts` | 简化 `create_agent` 流程，删除 Redis 注册和 Stream 发布，改为重启 OpenClaw |

### 升级指南

1. **更新 HR Agent 的 SOUL.md**:
```javascript
// 旧代码
hr_manage({ action: "list_staffs", ... })

// 新代码
hr({ action: "list_staffs", ... })
```

2. **删除 `sync_agents_to_redis` 调用**:
```javascript
// 删除这段代码
hr({ action: "sync_agents_to_redis", ... })
```

3. **重启 OpenClaw**:
```bash
openclaw gateway restart
```

### 已知限制

- `create_agent` 重启 OpenClaw 时可能会导致当前会话中断
- 重启期间其他消息可能无法处理

### 后续优化方向

1. **热重载**: 考虑使用 OpenClaw 的 hot-reload 机制，避免完全重启
2. **异步重启**: 将重启操作放入后台，立即返回创建结果
3. **批量创建**: 支持一次创建多个 agent，然后统一重启

### 测试建议

1. 测试 `list_staffs` 在 Redis 为空时的表现
2. 测试 `create_agent` 创建后的自动重启
3. 测试重启后新 agent 是否能正常接收消息
