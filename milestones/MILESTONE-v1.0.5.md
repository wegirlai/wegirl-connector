# MILESTONE-v1.0.5.md

## 版本 v1.0.5 (2026-04-11)

### 概述
优化 HR Tool 的 list_staffs 功能，支持显示人类员工，并按实例分组展示。

### 主要变更

#### 1. list_staffs 支持人类员工
- **问题**: 之前只返回 agent 类型，不显示人类员工
- **解决**: 修改过滤条件，同时返回 `type=agent` 和 `type=human`

#### 2. 按实例分组展示
**新格式**:
```
📋 团队花名册

wegirl001 实例：
🤖 main - CTO 🟢
🤖 hr - 人力资源专员 🟢
🤖 scout - URL发现 🟢
👤 tiger - 老板 🟢
👤 suki - 产品经理 🟢

wegirl002 实例：
🤖 cncplanner - CNC策划 🟢
🤖 leaddiscovery - 线索发现 ⚪

共 15 位成员（🤖 10 / 👤 5）
```

**特点**:
- 按 instanceId 分组显示
- 每行一个成员，显示角色
- 在线状态：🟢 在线 / ⚪ 离线
- 底部统计总数（机器人/人类）

#### 3. 返回格式兼容性
- 保持 `result.agents` 字段名（虽然包含 humans）
- 客户端无需修改

### 文件变更

| 文件 | 变更 |
|------|------|
| `src/index.ts` | `handleListAgents` 返回 human 类型，`formatResultForReply` 新格式 |

### 相关改动

**wegirl-service** (配合修改):
- 启动时同步 humans 表到 Redis
- `handle_init` 支持同步 humans

### 测试建议

1. 调用 `list_staffs` 确认显示 humans
2. 检查实例分组是否正确
3. 验证在线状态图标

### 后续优化

1. 支持按能力筛选
2. 支持按角色分组
3. 添加搜索功能
