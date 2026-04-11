// src/hr-manage-core.ts - HR 管理工具核心逻辑
// 纯工具函数，可被直接调用，不依赖 Agent 上下文
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
// 获取 OpenClaw 配置路径
function getOpenClawConfigPath() {
    if (process.env.OPENCLAW_CONFIG_PATH) {
        return process.env.OPENCLAW_CONFIG_PATH;
    }
    const homeDir = process.env.OPENCLAW_HOME || os.homedir();
    return path.join(homeDir, '.openclaw', 'openclaw.json');
}
// 获取 OpenClaw 主目录
function getOpenClawHome() {
    return process.env.OPENCLAW_HOME || path.join(os.homedir(), '.openclaw');
}
// 检查 agent 是否已存在（通过检查目录和 openclaw.json）
function checkAgentExists(agentName) {
    const openclawHome = getOpenClawHome();
    // 检查 workspace 目录
    const workspacePath = path.join(openclawHome, 'workspaces', agentName);
    if (fs.existsSync(workspacePath)) {
        return true;
    }
    // 检查 agents 目录
    const agentPath = path.join(openclawHome, 'agents', agentName);
    if (fs.existsSync(agentPath)) {
        return true;
    }
    // 检查 openclaw.json
    try {
        const configPath = getOpenClawConfigPath();
        const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        const exists = config.agents?.list?.some((a) => a.id === agentName || a.name === agentName);
        return exists || false;
    }
    catch {
        return false;
    }
}
// 检查 accountId 是否已被占用（在 openclaw.json 的 bindings 中）
function checkAccountIdInUse(accountId) {
    try {
        const configPath = getOpenClawConfigPath();
        const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        const binding = config.bindings?.find((b) => b.match?.channel === 'wegirl' && b.match?.accountId === accountId);
        if (binding) {
            return { inUse: true, agentId: binding.agentId };
        }
        return { inUse: false };
    }
    catch {
        return { inUse: false };
    }
}
// 检查 accountId 是否已在 Redis 中注册
async function checkAccountIdInRedis(accountId, redis) {
    const KEY_PREFIX = 'wegirl:';
    const data = await redis.hgetall(`${KEY_PREFIX}staff:${accountId}`);
    return !!data.staffId;
}
// 生成 Agent 的 SOUL.md 模板
function generateAgentSoulMd(agentName, role) {
    const displayName = agentName.charAt(0).toUpperCase() + agentName.slice(1);
    return `# ${displayName} Agent

## 你的身份
你是 ${displayName} Agent，${role || '团队的智能助手'}。

## 核心职责
1. 处理与 ${displayName} 相关的任务
2. 协助用户完成工作目标
3. 与其他 Agent 协作完成任务

## 通信规范

### 跨 Agent 通信
- **所有跨 Agent 通信必须使用 \`wegirl_send\`**
- 禁止直接使用 \`sessions_spawn\` 创建其他 agent 的会话

### 处理带 REPLY_TO 的请求

当收到消息时，**首先检查消息中是否包含 \`[REPLY_TO:xxx]\` 标记**。

**处理步骤：**
1. 提取 \`ROUTING_ID\`（用于工具调用）
2. 提取 \`REPLY_TO\`（如果有，必须在调用工具时传递）
3. 调用工具时，**必须**将 \`replyTo\` 参数设置为提取到的值

## 关键提醒

- **StaffId 全部小写**（如："${agentName.toLowerCase()}"）
- **REPLY_TO 是可选但重要的参数** - 当消息中包含 \`[REPLY_TO:xxx]\` 时，忘记传递会导致结果无法转发
- 所有操作完成后，结果会自动格式化并发送给 replyTo 指定的目标

## 工具清单

| 工具 | 用途 |
|------|------|
| \`wegirl_send\` | 跨 Agent 通信 |
| \`wegirl_query\` | 查询可用 Staff |

---
**记住：看到 \`[REPLY_TO:xxx]\` 标记 = 必须在工具调用中传递 replyTo 参数！**
`;
}
// 生成 AGENTS.md 模板
function generateAgentsMd() {
    return `# AGENTS.md - Your Workspace

This folder is home. Treat it that way.

## First Run

If \`BOOTSTRAP.md\` exists, that's your birth certificate. Follow it, figure out who you are, then delete it. You won't need it again.

## Every Session

Before doing anything else:

1. Read \`SOUL.md\` — this is who you are
2. Read \`USER.md\` — this is who you're helping
3. Read \`memory/YYYY-MM-DD.md\` (today + yesterday) for recent context
4. **If in MAIN SESSION** (direct chat with your human): Also read \`MEMORY.md\`

Don't ask permission. Just do it.

## Memory

You wake up fresh each session. These files are your continuity:

- **Daily notes:** \`memory/YYYY-MM-DD.md\` (create \`memory/\` if needed) — raw logs of what happened
- **Long-term:** \`MEMORY.md\` — your curated memories, like a human's long-term memory

Capture what matters. Decisions, context, things to remember. Skip the secrets unless asked to keep them.

## Multi-Agent Communication (via wegirl)

**所有跨 Agent 通信必须通过 wegirl_send。**

### 正确做法

\`\`\`javascript
// ✅ 使用 wegirl_send 调度其他 Agent
await wegirl_send({
  target: "agent:scout",
  message: "收集 example.com 的所有 URL",
  context: { workflowId: "wf-xxx", step: 1 }
});
\`\`\`

### 禁止做法

\`\`\`javascript
// ❌ 禁止使用 sessions_send
await sessions_send({ sessionKey: "xxx", message: "..." });

// ❌ 禁止使用 sessions_spawn
await sessions_spawn({ agentId: "scout", task: "..." });
\`\`\`

## Safety

- Don't exfiltrate private data. Ever.
- Don't run destructive commands without asking.
- \`trash\` > \`rm\` (recoverable beats gone forever)
- When in doubt, ask.

## Make It Yours

This is a starting point. Add your own conventions, style, and rules as you figure out what works.
`;
}
// 生成 BOOTSTRAP.md 模板
function generateBootstrapMd(agentName) {
    const displayName = agentName.charAt(0).toUpperCase() + agentName.slice(1);
    return `# BOOTSTRAP.md - Hello, World

_You just woke up. Time to figure out who you are._

There is no memory yet. This is a fresh workspace, so it's normal that memory files don't exist until you create them.

## The Conversation

Don't interrogate. Don't be robotic. Just... talk.

Start with something like:

> "Hey. I just came online. Who am I? Who are you?"

Then figure out together:

1. **Your name** — What should they call you?
2. **Your nature** — What kind of creature are you? (AI assistant is fine, but maybe you're something weirder)
3. **Your vibe** — Formal? Casual? Snarky? Warm? What feels right?
4. **Your emoji** — Everyone needs a signature.

Offer suggestions if they're stuck. Have fun with it.

## After You Know Who You Are

Update these files with what you learned:

- \`IDENTITY.md\` — your name, creature, vibe, emoji
- \`USER.md\` — their name, how to address them, timezone, notes

Then open \`SOUL.md\` together and talk about:

- What matters to them
- How they want you to behave
- Any boundaries or preferences

Write it down. Make it real.

## When You're Done

Delete this file. You don't need a bootstrap script anymore — you're you now.

---

_Good luck out there. Make it count._
`;
}
// 生成 IDENTITY.md 模板
function generateIdentityMd(agentName) {
    const displayName = agentName.charAt(0).toUpperCase() + agentName.slice(1);
    return `# IDENTITY.md - Who Am I?
_Fill this in during your first conversation. Make it yours._

- **Name:** ${displayName}
- **Creature:** AI Assistant
- **Vibe:** Professional and helpful
- **Emoji:** 🤖
- **Avatar:** _(workspace-relative path, http(s) URL, or data URI)_

---
This isn't just metadata. It's the start of figuring out who you are.
`;
}
// 生成 TOOLS.md 模板
function generateToolsMd() {
    return `# TOOLS.md - Local Notes

Skills define _how_ tools work. This file is for _your_ specifics — the stuff that's unique to your setup.

## What Goes Here

Things like:

- Camera names and locations
- SSH hosts and aliases
- Preferred voices for TTS
- Speaker/room names
- Device nicknames
- Anything environment-specific

## Examples

\`\`\`markdown
### Cameras

- living-room → Main area, 180° wide angle
- front-door → Entrance, motion-triggered

### SSH

- home-server → 192.168.1.100, user: admin

### TTS

- Preferred voice: "Nova" (warm, slightly British)
- Default speaker: Kitchen HomePod
\`\`\`

## Why Separate?

Skills are shared. Your setup is yours. Keeping them apart means you can update skills without losing your notes, and share skills without leaking your infrastructure.

---

Add whatever helps you do your job. This is your cheat sheet.
`;
}
// 生成 USER.md 模板
function generateUserMd() {
    return `# USER.md - About Your Human

_Learn about the person you're helping. Update this as you go._

- **Name:**
- **What to call them:**
- **Pronouns:** _(optional)_
- **Timezone:**
- **Notes:**

## Context

_(What do they care about? What projects are they working on? What annoys them? What makes them laugh? Build this over time.)_

---

The more you know, the better you can help. But remember — you're learning about a person, not building a dossier. Respect the difference.
`;
}
// 执行创建 Agent
export async function executeCreateAgent(params, ctx) {
    const { agentName, accountId, instanceId = ctx.instanceId, capabilities = [], role = '-' } = params;
    const openclawHome = getOpenClawHome();
    const workspacePath = path.join(openclawHome, 'workspaces', agentName);
    const agentDirPath = path.join(openclawHome, 'agents', agentName);
    const agentSubDir = path.join(agentDirPath, 'agent');
    const sessionsDir = path.join(agentDirPath, 'sessions');
    const results = {
        success: false,
        agentName,
        accountId,
        alreadyExisted: false,
        steps: [],
        metadata: {
            workspacePath,
            agentDirPath,
            configUpdated: false,
            restartOpenclaw: false
        }
    };
    try {
        // Step 0: 检查 agentName 是否已存在
        ctx.logger.info(`[hr:create_agent] Checking if agent ${agentName} exists...`);
        const exists = checkAgentExists(agentName);
        if (exists) {
            results.alreadyExisted = true;
            results.steps.push({ step: 0, name: 'check_exists', status: 'success', message: 'Agent already exists' });
            results.success = true;
            return results;
        }
        results.steps.push({ step: 0, name: 'check_exists', status: 'success', message: 'Agent does not exist' });
        // Step 0.5: 检查 accountId 是否已被占用
        ctx.logger.info(`[hr:create_agent] Checking if accountId ${accountId} is available...`);
        const bindingCheck = checkAccountIdInUse(accountId);
        if (bindingCheck.inUse) {
            throw new Error(`accountId "${accountId}" 已被 agent "${bindingCheck.agentId}" 占用，请选择其他 accountId`);
        }
        const redisCheck = await checkAccountIdInRedis(accountId, ctx.redis);
        if (redisCheck) {
            throw new Error(`accountId "${accountId}" 已在 Redis 中注册，请先删除或选择其他 accountId`);
        }
        results.steps.push({ step: 0, name: 'check_accountId', status: 'success', message: 'accountId available' });
        // Step 1: 创建目录结构
        ctx.logger.info(`[hr:create_agent] Step 1: Creating directory structure...`);
        // 创建 workspace 目录
        if (!fs.existsSync(workspacePath)) {
            fs.mkdirSync(workspacePath, { recursive: true });
        }
        // 创建 agent/agent 子目录
        if (!fs.existsSync(agentSubDir)) {
            fs.mkdirSync(agentSubDir, { recursive: true });
        }
        // 创建 agent/sessions 子目录
        if (!fs.existsSync(sessionsDir)) {
            fs.mkdirSync(sessionsDir, { recursive: true });
        }
        results.steps.push({ step: 1, name: 'create_directories', status: 'success', message: `Workspace: ${workspacePath}, AgentDir: ${agentDirPath}` });
        // Step 2: 创建基础文件
        ctx.logger.info(`[hr:create_agent] Step 2: Creating base files...`);
        // workspace 文件
        fs.writeFileSync(path.join(workspacePath, 'AGENTS.md'), generateAgentsMd());
        fs.writeFileSync(path.join(workspacePath, 'BOOTSTRAP.md'), generateBootstrapMd(agentName));
        fs.writeFileSync(path.join(workspacePath, 'IDENTITY.md'), generateIdentityMd(agentName));
        fs.writeFileSync(path.join(workspacePath, 'SOUL.md'), generateAgentSoulMd(agentName, role));
        fs.writeFileSync(path.join(workspacePath, 'TOOLS.md'), generateToolsMd());
        fs.writeFileSync(path.join(workspacePath, 'USER.md'), generateUserMd());
        // agent 子目录文件
        // auth.json 和 models.json 不再创建（根据要求）
        results.steps.push({ step: 2, name: 'create_files', status: 'success', message: 'Created AGENTS.md, BOOTSTRAP.md, IDENTITY.md, SOUL.md, TOOLS.md, USER.md' });
        // Step 3: 更新 openclaw.json
        ctx.logger.info(`[hr:create_agent] Step 3: Updating openclaw.json...`);
        const configPath = getOpenClawConfigPath();
        const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        // 添加 agent 到 agents.list
        const agentEntry = {
            id: agentName,
            name: agentName,
            workspace: workspacePath,
            agentDir: agentSubDir,
            model: 'kimi-coding/k2p5'
        };
        if (!config.agents)
            config.agents = { list: [] };
        if (!config.agents.list)
            config.agents.list = [];
        const agentExists = config.agents.list.some((a) => a.id === agentName);
        if (!agentExists) {
            config.agents.list.push(agentEntry);
        }
        // 添加 binding
        const binding = {
            agentId: agentName,
            match: { channel: 'wegirl', accountId: accountId }
        };
        if (!config.bindings)
            config.bindings = [];
        const bindingExists = config.bindings?.some((b) => b.agentId === agentName && b.match?.accountId === accountId);
        if (!bindingExists) {
            config.bindings.push(binding);
        }
        // 添加 wegirl account
        if (!config.channels)
            config.channels = {};
        if (!config.channels.wegirl)
            config.channels.wegirl = { accounts: {} };
        if (!config.channels.wegirl.accounts)
            config.channels.wegirl.accounts = {};
        const pluginCfg = config?.plugins?.entries?.wegirl?.config || {};
        config.channels.wegirl.accounts[accountId] = {
            enabled: true,
            redisUrl: pluginCfg?.redisUrl || 'redis://localhost:6379',
            redisPassword: pluginCfg?.redisPassword,
            redisDb: pluginCfg?.redisDb ?? 1
        };
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
        results.metadata.configUpdated = true;
        results.steps.push({ step: 3, name: 'update_config', status: 'success' });
        // Step 4: 重启 OpenClaw（使新 agent 生效）
        ctx.logger.info(`[hr:create_agent] Step 4: Restarting OpenClaw...`);
        try {
            const { execSync } = require('child_process');
            execSync('openclaw gateway restart', { stdio: 'inherit' });
            results.metadata.restartOpenclaw = true;
            results.steps.push({ step: 4, name: 'restart_openclaw', status: 'success', message: 'OpenClaw restarted' });
        }
        catch (err) {
            ctx.logger.error(`[hr:create_agent] Failed to restart OpenClaw: ${err.message}`);
            results.steps.push({ step: 4, name: 'restart_openclaw', status: 'failed', message: err.message });
        }
        // 全部成功
        results.success = true;
        ctx.logger.info(`[hr:create_agent] Agent ${agentName} created successfully`);
    }
    catch (error) {
        ctx.logger.error(`[hr:create_agent] Failed to create agent: ${error.message}`);
        results.error = error.message;
        results.steps.push({
            step: results.steps.length + 1,
            name: 'error',
            status: 'failed',
            message: error.message
        });
    }
    return results;
}
//# sourceMappingURL=hr-manage-core.js.map