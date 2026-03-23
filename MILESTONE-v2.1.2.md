# MILESTONE-v2.1.2.md

## WeGirl Connector v2.1.2

### 发布日期
2026-03-23

### 新功能

#### 🏷️ fromType 字段标记
在 `forwardMsg` 和 `replyMessage` 消息中添加 `fromType` 字段，用于标识消息来源：

- **`fromType: 'inner'`** - 标记为内部工具调用（wegirl_send/hr_manage）

**作用:**
- 便于下游服务（如 wegirl-monitor）区分消息来源
- 支持更精细的消息路由和处理策略
- 便于调试和追踪消息流向

**影响的消息类型:**
1. `wegirl:forward` 频道消息（H2A）
2. `wegirl:replies` 频道消息（A2H）

### 技术细节

**修改文件:**
- `src/core/sessions-send.ts` - 添加 `fromType: 'inner'` 到 forwardMsg 和 replyMessage
- `src/core/send.ts` - 添加 `fromType: 'inner'` 到 replyMessage

**消息格式示例:**
```json
{
  "flowType": "H2A",
  "source": "ou_xxx",
  "target": "hr",
  "message": "...",
  "msgType": "message",
  "fromType": "inner",
  "metadata": { ... }
}
```

### 兼容性
- 完全向后兼容
- 新增字段不影响现有功能
- 下游服务可选择性使用

---

**Full Changelog**: 对比 v2.1.1...v2.1.2
