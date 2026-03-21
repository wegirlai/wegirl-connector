# MILESTONE v2.0 - WeGirl Connector

**发布日期**: 2026-03-21  
**版本号**: v2.0.0  
**代号**: HR 入职流程完善版

---

## 概述

v2.0 是 wegirl-connector 的重大版本更新，重点完善了 HR 入职流程，统一了消息格式，并增强了系统的健壮性。

---

## 主要变更

### 1. HR 入职流程完善

#### 新增/修改 Action
- `process_message` → `create_staff` 重命名，语义更清晰
- 统一入职消息格式：
  ```
  工号: xxx（只能包含小写字母、数字、-、_）
  姓名: xxx
  电话: xxx（选填）
  角色: xxx（选填）
  能力: xxx, xxx（选填）
  ```

#### 入职流程自动化
- 用户发送"我要入职" → HR 自动发送入职登记表
- 用户填写入职信息 → 自动解析并发送给 CTO (default agent)
- 入职消息格式标准化为 V2 格式：
  ```javascript
  {
    flowType: 'A2A',
    source: 'hr',
    target: 'default',
    message: '收到新员工入职申请：...',
    msgType: 'onboard_human',
    payload: { staffId, name, phone, role, capabilities, ... }
  }
  ```

#### HR Agent 人格优化
- SOUL.md 更新：明确 HR 作为"人事主管"的身份
- 入职提示改为人事主管风格：专业、热情、有条理
- 强调边界感：技术问题找 CTO，HR 只负责协调

### 2. 消息格式标准化

#### V2 格式统一
所有通过 `wegirl:replies` 发送的消息统一使用 V2 格式：
```javascript
{
  flowType: 'H2A' | 'A2A' | 'A2H',
  source: string,        // 发送者 StaffId
  target: string,        // 接收者 StaffId
  message: string,       // 消息内容
  chatType: 'direct' | 'group',
  groupId?: string,      // 群聊时必填
  routingId?: string,
  msgType?: 'message' | 'error' | 'onboard_human' | 'sync_agent',
  payload?: object,      // 额外数据
  metadata?: object,     // 元数据
  timestamp: number
}
```

#### msgType 规范化
- `onboard_human` - 入职申请
- `sync_agent` - Agent 同步命令
- `message` - 普通消息
- `error` - 错误提示

### 3. Bug 修复

#### 空值检查
- 修复 `isOnboardRequest()` 和 `isOnboardFormat()` 的参数检查
- 添加 `message` 为 `undefined` 或 `null` 时的保护

#### 字段映射确认
- 工号 → `staffId`
- 姓名 → `name`
- 电话 → `phone`
- 角色 → `role`
- 能力 → `capabilities`

### 4. 代码结构调整

#### 文件职责清晰化
- `hr-message-handler.ts` - 处理所有 HR 相关消息逻辑
- `hr-manage-core.ts` - HR 管理工具核心逻辑
- `index.ts` - 工具注册和 action 分发

---

## 技术细节

### HR 入职流程时序图

```
用户                    HR Agent                  wegirl:replies              CTO (default)
 |                        |                              |                         |
 |--- "我要入职" -------->|                              |                         |
 |                        |                              |                         |
 |                        |--- hr_manage:create_staff -->|                         |
 |                        |                              |                         |
 |                        |<-- 返回：发送入职登记表 ------|                         |
 |                        |                              |                         |
 |<-- 入职登记表 ---------|                              |                         |
 |                        |                              |                         |
 |--- 填写入职信息 ------> |                              |                         |
 |                        |                              |                         |
 |                        |--- hr_manage:create_staff -->|                         |
 |                        |                              |                         |
 |                        |<-- 返回：解析成功 ------------|                         |
 |                        |                              |                         |
 |                        |--- 发布 onboard_human ------> |                         |
 |                        |                              |---> msgType:onboard_human ->|
 |                        |                              |                         |
 |                        |<-- 返回：发送成功确认 --------|                         |
 |                        |                              |                         |
 |<-- "已提交，正在处理" --|                              |                         |
```

### 关键数据结构

#### OnboardData
```typescript
interface OnboardData {
  staffId: string;      // 工号（系统唯一标识）
  name: string;         // 姓名
  phone?: string;       // 电话
  role?: string;        // 角色/职责
  capabilities?: string[];  // 能力标签
  valid: boolean;       // 是否有效
  error?: string;       // 错误信息（如果无效）
}
```

#### 入职消息 Payload
```typescript
payload: {
  staffId: string,           // 工号
  name: string,              // 姓名
  phone?: string,            // 电话
  role?: string,             // 角色
  capabilities?: string[],   // 能力
  feishuOpenId: string,      // 飞书 OpenId
  sourceUserId: string,      // 源用户ID
}
```

---

## 配置示例

### openclaw.json
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
  },
  "bindings": [
    {
      "agentId": "hr",
      "match": { "channel": "wegirl", "accountId": "hr" }
    }
  ]
}
```

### HR Agent SOUL.md
```markdown
## 工作模式

### 重要：处理入职请求的流程

当用户说"我要入职"或发送入职相关信息时，**必须**按以下步骤处理：

1. **收到入职请求** → 立即调用 `hr_manage({ action: "create_staff", message: <用户消息> })`
2. **不要自己回复入职提示** → 让工具处理并发送正确的入职登记表
3. **工具会返回结果** → 根据结果告知用户下一步

**入职消息格式示例：**
```
工号: tiger（只能包含小写字母、数字、-、_）
姓名: 张三
电话: 13800138000
角色: 产品经理
能力: sales, writing
```
```

---

## 版本迭代

### v2.0.20 (2026-03-21)
**HR 入职流程优化**

- `create_staff` 参数格式简化：`message`/`userId`/`userName`/`userOpenId`
- 从 `hr_manage` 中删除 `create_agent`/`delete_agent` action
- action 名称改为 HR 术语：`list_agents` → `list_staffs`，`get_agent` → `get_staff`
- 日志格式统一为模板字符串
- 删除 `wegirl-reply-debug.json` 文件输出
- 日志前缀统一：`[hr_manage:process_message]` → `[hr_manage:create_staff]`
- GitHub 提交: `4d3b8c4`

---

## 升级指南

### 从 v1.x 升级到 v2.0

1. **更新代码**
   ```bash
   cd /path/to/wegirl-connector
   git pull origin main
   npm install
   npm run build
   ```

2. **重启 Gateway**
   ```bash
   openclaw gateway restart
   ```

3. **验证 HR 入职流程**
   - 私聊 HR Agent 发送"我要入职"
   - 确认收到标准格式的入职登记表
   - 填写入职信息并提交
   - 确认 CTO 收到 `onboard_human` 消息

---

## 待办事项

### v2.1 计划
- [ ] 工作流状态机支持
- [ ] 入职审批流程（CTO 审核后再创建 Agent）
- [ ] 批量入职支持
- [ ] 入职邮件通知

### 已知限制
- `default` accountId 已被 scout agent 占用，新 agent 使用 `{agentName}` 模式
- 跨实例消息路由依赖 Redis，需要确保 Redis 可用性

---

## 贡献者

- **CTO (main)** - 架构设计、代码审查
- **HR (hr)** - 入职流程设计、测试

---

## 相关文档

- [README.md](./README.md)
- [SKILL.md](./SKILL.md)
- [protocol.ts](./src/protocol.ts) - 消息协议定义

---

_Released with ❤️ by 微妞CTO_