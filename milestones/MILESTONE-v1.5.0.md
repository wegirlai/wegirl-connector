# MILESTONE-v1.5.0.md - Skill Install 工具

## 版本信息

- **版本**: 1.5.0
- **日期**: 2025-07-11
- **提交**: `v1.5.0: Skill Install 工具 - 从 Dashboard 同步 Agent 技能`

## 核心功能

### 1. 🛠️ `skill_install` 工具

**问题**: Agent 的技能（Skills）配置在 Dashboard 后端管理，但 Agent 本地工作目录的 `skills/` 文件夹需要与后端保持同步。手动管理容易出错，且需要支持"远程有本地无就下载、本地有远程无就删除"的自动对齐机制。

**方案**:
- 新增 `skill_install` 工具，供 Agent 内部调用同步技能
- 通过 Dashboard 后端接口获取应安装的技能列表和文件路径
- 比较本地 `skills/` 目录，自动下载缺失文件、删除多余文件
- 支持 `force_update` 参数强制覆盖已有文件

**接口依赖**:
- `GET http://dashboard.weiniuai.com/api/server/agents/{agent_id}/skills` — 获取技能列表
- `GET http://dashboard.weiniuai.com/api/server/skills/{skill_id}/download?path={file_path}` — 逐个下载文件

### 2. 📁 新文件 `src/skill-install.ts`

核心模块，包含以下功能：

- **`fetchRemoteSkills(agentId)`** — 从 Dashboard 获取该 Agent 应安装的技能列表（含 `id`/`name`/`description`/`files`）
- **`downloadSkillFile(skillId, filePath)`** — 下载单个技能文件内容
- **`getLocalSkillFiles(skillDir)`** — 递归扫描本地技能目录，获取所有文件相对路径
- **`syncSkill(skill, skillsDir, logger, forceUpdate)`** — 单个技能同步：对比远程文件列表与本地文件，下载缺失、删除多余、可选强制更新
- **`installSkills(agentId, options)`** — 主入口：获取远程列表 → 扫描本地 → 删除远程已移除的技能 → 逐个同步
- **`formatSyncResult(result)`** — 格式化结果为易读文本（带 emoji 图标和统计）

### 3. 🔧 `index.ts` 注册 `skill_install` 工具

新增 Tool 注册：
- 参数 `agent_id`（必填）— 目标 Agent ID
- 参数 `force_update`（可选，默认 false）— 是否强制覆盖已有文件
- 执行时调用 `installSkills(agent_id, { forceUpdate, logger })`
- 返回格式化结果或错误信息

## 文件变更

| 文件 | 变更 | 说明 |
|------|------|------|
| `src/skill-install.ts` | +302 行（新文件） | 技能同步安装核心模块 |
| `src/index.ts` | +1 导入行 +37 行（注册代码） | 注册 `skill_install` 工具 |
| `dist/*` | 自动编译 | TypeScript 编译输出 |

## 使用方式

### 1. Agent 直接调用（内部使用）

```javascript
// 在 Agent 内部，收到请求后调用：
const result = await skill_install({
  agent_id: "dashboarddev",
  force_update: false  // 只下载缺失文件，不覆盖已存在的
});
```

### 2. 通过 wegirl_send 让目标 Agent 自己调用

```javascript
wegirl_send({
  flowType: "A2A",
  source: "hr",
  target: "dashboarddev",
  message: "请同步你的技能配置",
  replyTo: "hr",
  routingId: "xxx"
});
```

dashboarddev 收到消息后，内部调用 `skill_install({ agent_id: "dashboarddev" })` 完成同步。

## 返回示例

```
📦 技能同步结果
Agent: dashboarddev
本地目录: /root/.openclaw/agents/dashboarddev/skills

🆕 sentiment-analysis [installed]
  + 新增 2 个文件:
    - SKILL.md
    - scripts/analyze.py

🔄 web-crawler [updated]
  + 新增 1 个文件:
    - references/headers.md
  - 删除 1 个文件:
    - old_version.py

🗑️ legacy-skill [removed]

📊 统计: 1 安装 / 1 更新 / 1 删除 / 0 失败
```

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `DASHBOARD_API_URL` | `http://dashboard.weiniuai.com` | Dashboard 后端地址（可覆盖用于测试环境） |
| `OPENCLAW_HOME` | `/root/.openclaw` | OpenClaw 主目录（决定 skills 安装路径） |

## 同步逻辑

```
远程技能列表  ←  GET /api/agents/{id}/skills
       │
       ▼
本地技能目录  ←  扫描 {agentWorkspace}/skills/
       │
       ▼
  ┌──────────┬──────────┬──────────┐
  │ 远程有   │ 远程有   │ 本地有   │
  │ 本地无   │ 本地有   │ 远程无   │
  │          │          │          │
  │ → 下载   │ → 跳过   │ → 删除   │
  │          │  (或更新  │  整个技能│
  │          │  if force)│  目录    │
  └──────────┴──────────┴──────────┘
       │
       ▼
  逐个下载文件  ←  GET /api/skills/{id}/download?path=xxx
```

## 影响范围

- **OpenClaw Gateway**: 重启后生效（`openclaw gateway restart`）
- **wegirl-service**: 无影响（按现有协议消费）
- **Dashboard 后端**: 新增接口（已提供）
- **Agent 工作目录**: `skills/` 目录自动维护，无需手动操作

## 向后兼容

- ✅ 所有变更均为**新增**，不修改现有 API/协议
- ✅ 新工具不影响 `wegirl_send`/`hr`/`rag` 等现有工具
- ✅ 无 `skills/` 目录的 Agent 首次同步时会自动创建目录
- ✅ 支持 `forceUpdate` 可选参数，默认行为安全（只下载缺失）

## 验证方式

1. 重启 Gateway 后检查日志: `[WeGirl register] Tools registered: wegirl_send, hr, rag, skill_install`
2. 调用 `skill_install({ agent_id: "dashboarddev" })` 检查返回结果
3. 检查本地 `{agentWorkspace}/skills/` 目录是否与 Dashboard 配置一致
4. 调用 `skill_install({ agent_id: "dashboarddev", force_update: true })` 验证强制更新模式
