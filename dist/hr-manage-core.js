// src/hr-manage-core.ts - HR 管理工具核心逻辑
// 纯工具函数，可被直接调用，不依赖 Agent 上下文
import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
const execAsync = promisify(exec);
// 获取 OpenClaw 配置路径
function getOpenClawConfigPath() {
    if (process.env.OPENCLAW_CONFIG_PATH) {
        return process.env.OPENCLAW_CONFIG_PATH;
    }
    const homeDir = process.env.OPENCLAW_HOME || require('os').homedir();
    return path.join(homeDir, '.openclaw', 'openclaw.json');
}
// 获取 OpenClaw 主目录
function getOpenClawHome() {
    return process.env.OPENCLAW_HOME || path.join(require('os').homedir(), '.openclaw');
}
// 检查 agent 是否已存在
async function checkAgentExists(agentName) {
    const workspacePath = path.join(getOpenClawHome(), `workspace-${agentName}`);
    if (fs.existsSync(workspacePath)) {
        return true;
    }
    try {
        const { stdout } = await execAsync('openclaw agents list --json 2>/dev/null || echo "[]"');
        const agents = JSON.parse(stdout || '[]');
        return agents.some((a) => a.id === agentName || a.name === agentName);
    }
    catch {
        return false;
    }
}
// 执行创建 Agent
export async function executeCreateAgent(params, ctx) {
    const { agentName, accountId, instanceId = ctx.instanceId, capabilities = [], role = '-' } = params;
    const results = {
        success: false,
        agentName,
        accountId,
        alreadyExisted: false,
        steps: [],
        metadata: {
            workspacePath: path.join(getOpenClawHome(), `workspace-${agentName}`),
            configUpdated: false,
            redisRegistered: false,
            streamed: false
        }
    };
    try {
        // Step 0: 检查是否已存在
        ctx.logger.info(`[hr_manage] Checking if agent ${agentName} exists...`);
        const exists = await checkAgentExists(agentName);
        if (exists) {
            results.alreadyExisted = true;
            results.steps.push({ step: 0, name: 'check_exists', status: 'success', message: 'Agent already exists' });
            results.success = true;
            return results;
        }
        results.steps.push({ step: 0, name: 'check_exists', status: 'success', message: 'Agent does not exist' });
        // Step 1: 创建 Agent
        ctx.logger.info(`[hr_manage] Step 1: Creating agent ${agentName}...`);
        const expectScript = `
spawn openclaw agents add ${agentName}
expect "Workspace directory"
send "\\r"
expect "Configure model/auth"
send "\\r"
expect "Configure chat channels"
send "\\r"
expect "Select a channel"
send "\\x1b\\x5bB\\x1b\\x5bB\\x1b\\x5bB\\x1b\\x5bB\\x1b\\x5bB\\x1b\\x5bB\\x1b\\x5bB\\x1b\\x5bB\\x1b\\x5bB\\x1b\\x5bB\\x1b\\x5bB\\x1b\\x5bB\\x1b\\x5bB\\x1b\\x5bB\\x1b\\x5bB\\x1b\\x5bB\\x1b\\x5bB\\x1b\\x5bB\\r"
expect eof
`;
        const expectFile = `/tmp/create_agent_${agentName}.exp`;
        fs.writeFileSync(expectFile, expectScript);
        try {
            const { stdout, stderr } = await execAsync(`expect ${expectFile}`, { timeout: 120000 });
            fs.unlinkSync(expectFile);
            if (stdout.includes('ready') || stdout.includes('Agent')) {
                results.steps.push({ step: 1, name: 'create_agent', status: 'success' });
            }
            else {
                throw new Error(`Failed to create agent: ${stderr || stdout}`);
            }
        }
        catch (execErr) {
            fs.unlinkSync(expectFile);
            throw execErr;
        }
        // Step 2: 更新 openclaw.json
        ctx.logger.info(`[hr_manage] Step 2: Updating openclaw.json...`);
        const configPath = getOpenClawConfigPath();
        const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        // 添加 binding
        const binding = {
            agentId: agentName,
            match: { channel: 'wegirl', accountId: accountId }
        };
        if (!config.bindings)
            config.bindings = [];
        const bindingExists = config.bindings.some((b) => b.agentId === agentName && b.match?.accountId === accountId);
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
        config.channels.wegirl.accounts[accountId] = {
            enabled: true,
            redisUrl: process.env.REDIS_URL || `redis://${process.env.REDIS_HOST || 'localhost'}:${process.env.REDIS_PORT || '6379'}`,
            redisPassword: process.env.REDIS_PASSWORD || '',
            redisDb: parseInt(process.env.REDIS_DB || '1', 10)
        };
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
        results.metadata.configUpdated = true;
        results.steps.push({ step: 2, name: 'update_config', status: 'success' });
        // Step 3: 注册到 Redis
        ctx.logger.info(`[hr_manage] Step 3: Registering to Redis...`);
        const KEY_PREFIX = 'wegirl:';
        const agentCapabilities = capabilities.length > 0 ? capabilities : [agentName];
        await ctx.redis.hset(`${KEY_PREFIX}agents:${accountId}`, {
            agentId: accountId,
            instanceId: instanceId,
            type: 'agent',
            role: role, // 职能/角色
            name: agentName,
            capabilities: agentCapabilities.join(','),
            status: 'online',
            lastHeartbeat: Date.now().toString(),
            'load:activeTasks': '0',
            'load:pendingTasks': '0'
        });
        // 添加到能力索引
        for (const cap of agentCapabilities) {
            await ctx.redis.sadd(`${KEY_PREFIX}capability:${cap}`, accountId);
        }
        // 添加到实例集合
        await ctx.redis.sadd(`${KEY_PREFIX}instance:${instanceId}:agents`, accountId);
        results.metadata.redisRegistered = true;
        results.steps.push({ step: 3, name: 'register_redis', status: 'success' });
        // Step 4: 发布到 Stream
        ctx.logger.info(`[hr_manage] Step 4: Publishing to Stream...`);
        const streamKey = `${KEY_PREFIX}results:hr`;
        const streamMessage = {
            taskId: `create-${agentName}-${Date.now()}`,
            timestamp: Date.now(),
            source: {
                instanceId: ctx.instanceId,
                tool: 'hr_manage',
                action: 'create_agent'
            },
            status: 'success',
            payload: {
                agentName,
                accountId,
                instanceId,
                capabilities: agentCapabilities
            },
            syncData: {
                agentId: accountId,
                instanceId,
                capabilities: agentCapabilities,
                status: 'active'
            }
        };
        await ctx.redis.xadd(streamKey, '*', 'data', JSON.stringify(streamMessage));
        results.metadata.streamed = true;
        results.steps.push({ step: 4, name: 'publish_stream', status: 'success' });
        // 全部成功
        results.success = true;
        ctx.logger.info(`[hr_manage] Agent ${agentName} created successfully`);
    }
    catch (error) {
        ctx.logger.error(`[hr_manage] Failed to create agent: ${error.message}`);
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