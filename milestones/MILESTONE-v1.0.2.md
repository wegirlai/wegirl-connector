# MILESTONE-v1.0.2.md

## WeGirl Connector v1.0.2

**发布日期**: 2026-03-19

---

## 修复内容

### Redis 配置优先级优化

**问题**: 
- 插件在初始化时尝试连接 `127.0.0.1:6379`（默认值）
- 即使配置了 `10.8.0.1:6379`，也先尝试连接 localhost 导致错误日志

**解决方案**:
- 增加配置优先级：**环境变量 > pluginConfig > 默认值**
- 支持的环境变量：
  - `REDIS_URL` - 完整的 Redis URL
  - `REDIS_HOST` + `REDIS_PORT` - 分开配置
  - `REDIS_PASSWORD` - 密码
  - `REDIS_DB` - 数据库编号

**代码变更** (`src/index.ts`):
```typescript
// 优先从环境变量读取，其次 pluginConfig，最后默认值
const db = (parseInt(process.env.REDIS_DB || '') || config.redisDb) ?? 1;
const password = process.env.REDIS_PASSWORD || config.redisPassword;

// 构建 Redis URL
let url: string;
if (process.env.REDIS_URL) {
  url = process.env.REDIS_URL;
} else if (process.env.REDIS_HOST) {
  const host = process.env.REDIS_HOST;
  const port = process.env.REDIS_PORT || '6379';
  url = `redis://${host}:${port}`;
} else {
  url = config.redisUrl || 'redis://localhost:6379';
}
```

---

### Event Handlers 改进

**问题**: 
- `write` 工具的文件路径未被正确提取

**解决方案**:
- 将 `write` 工具纳入文件路径提取逻辑

**代码变更** (`src/event-handlers.ts`):
```typescript
// 提取文件路径（针对 read/edit/write 工具）
if (toolName === 'read' || toolName === 'edit' || toolName === 'write') {
  target = params.file_path || params.path || params.filePath || params.newText || 'N/A';
}
```

---

## 配置建议

### 推荐配置方式 (openclaw.json)

将 Redis 配置提取到 channel 级别，避免每个 agent 重复配置：

```json
{
  "channels": {
    "wegirl": {
      "enabled": true,
      "redisUrl": "redis://10.8.0.1:6379",
      "redisPassword": "your-password",
      "redisDb": 1,
      "accounts": {
        "analyst": { "enabled": true },
        "harvester": { "enabled": true },
        "hr": { "enabled": true }
      }
    }
  }
}
```

### 备选：环境变量配置

在启动 Gateway 前设置环境变量：

```bash
export REDIS_HOST=10.8.0.1
export REDIS_PORT=6379
export REDIS_PASSWORD=microsoul**
export REDIS_DB=1

openclaw gateway start
```

---

## 测试结果

| 测试项 | 结果 |
|--------|------|
| 环境变量配置 | ✅ 优先读取 |
| Plugin config 配置 | ✅ 次优先级 |
| 默认 localhost | ✅ 最后 fallback |
| 密码脱敏日志 | ✅ URL 中的密码被隐藏 |
| 无重复连接错误 | ✅ 无 `127.0.0.1:6379` 错误 |

---

## 相关提交

- Redis 配置优先级: `feat: improve Redis configuration priority with env vars support`
- Event handlers 改进: `feat: include write tool in file path extraction`

---

## 升级指南

1. 更新代码：`git pull`
2. 重新构建：`npm run build`
3. 优化配置：将 Redis 配置从 `plugins.entries.wegirl.config` 移到 `channels.wegirl`
4. 重启 Gateway：`openclaw gateway restart`

---

## 相关文档

- [README.md](./README.md)
- [MILESTONE-v1.0.1.md](./MILESTONE-v1.0.1.md)
