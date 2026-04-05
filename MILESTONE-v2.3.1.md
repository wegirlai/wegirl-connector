# MILESTONE-v2.3.1 - A2H 消息修复与 replyTo 优化

**发布日期**: 2026-04-05

**版本类型**: 补丁版本 (Patch)

---

## 修复内容

### 1. `hr_manage` 工具添加 `replyTo` 参数支持

**问题**: HR Agent 调用 `hr_manage` 时无法将结果转发给指定用户

**修复**:
- 在 `hr_manage` 参数 schema 中添加 `replyTo` 字段
- 更新工具描述，强调 `replyTo` 的重要性
- 修复主动回复逻辑，确保结果正确转发

**文件**: `src/index.ts`

---

### 2. 消息内容嵌入 `[REPLY_TO:xxx]` 标记

**问题**: Agent 无法从消息上下文中获取 `replyTo` 信息

**修复**:
- 在消息内容中嵌入 `[REPLY_TO:xxx]` 标记
- Agent 可以从消息内容中提取并传递给工具

**格式**:
```
[ROUTING_ID:xxx]
[REPLY_TO:tiger]
请列出公司花名册
```

**文件**: `src/core/sessions-send.ts`

---

### 3. `handleAgentReply` 修复 replyTo 传递问题

**问题**: `replyTo` 信息没有正确传递给 `handleAgentReply`

**修复**:
- 添加 `replyTo` 参数到 `handleAgentReply` 函数签名
- 优先使用显式传递的 `replyTo`，其次从 `originalMetadata` 获取

**文件**: `src/core/sessions-send.ts`

---

### 4. A2H 消息处理优化

**问题**: A2H 消息目标格式不正确，导致 wegirl-service 无法正确处理

**修复**:
- A2H 消息保持原始 `target`（如 `"tiger"`）
- 不再将 target 转换为 `source:openid` 格式
- 由 wegirl-service 负责查询 `feishu_userid`

**文件**: `src/core/send.ts`

---

### 5. 类型定义更新

**变更**:
- `StaffInfo` 接口添加 `feishuUserId` 字段（后续由 wegirl-service 使用）

**文件**: `src/core/types.ts`

---

## 依赖更新

### wegirl-service 配套修复

本次修复需要配合 wegirl-service 的以下更新：

1. **A2H 消息智能判断**: 通过 `routing_id` 判断使用 reply 模式还是主动发送
2. **MySQL 查询**: 通过 `target` 查询 `feishu_userid`
3. **飞书 API**: 使用 `userid`（不是 `openid`）发送消息

详见 wegirl-service 更新日志。

---

## 测试验证

### 测试场景 1: Scout -> HR -> Tiger

**步骤**:
1. 在 Scout 发送: "让hr列出公司花名册，回复给tiger"
2. Scout 转发消息给 HR，嵌入 `[REPLY_TO:tiger]`
3. HR 调用 `hr_manage` 并传递 `replyTo: "tiger"`
4. HR 主动发送结果给 tiger

**预期结果**: tiger 收到花名册消息

### 测试场景 2: 直接 A2H 消息

**步骤**:
1. 调用 `wegirl_send({flowType: "A2H", target: "tiger", ...})`
2. wegirl-service 接收消息并发送给 tiger

**预期结果**: tiger 收到消息

---

## 破坏性变更

无破坏性变更，所有修复向后兼容。

---

## 相关文档

- [README.md](./README.md)
- wegirl-service 更新日志

---

**提交**: [更新描述待填充]
