// src/hr-manage-core.ts - HR 管理工具核心逻辑
// 纯工具函数，可被直接调用，不依赖 Agent 上下文

import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type Redis from 'ioredis';

const execAsync = promisify(exec);

// 执行上下文
export interface ExecutionContext {
  instanceId: string;
  logger: any;
  redis: Redis;
}

// 创建 Agent 参数
export interface CreateAgentParams {
  agentName: string;
  accountId: string;
  instanceId?: string;
  capabilities?: string[];
  role?: string;  // 职能/角色
}

// 执行结果
export interface CreateAgentResult {
  success: boolean;
  agentName: string;
  accountId: string;
  alreadyExisted: boolean;
  steps: StepResult[];
  metadata: {
    workspacePath: string;
    configUpdated: boolean;
    redisRegistered: boolean;
    streamed: boolean;
  };
  error?: string;
}

interface StepResult {
  step: number;
  name: string;
  status: 'success' | 'failed' | 'skipped';
  message?: string;
}

// 获取 OpenClaw 配置路径
function getOpenClawConfigPath(): string {
  if (process.env.OPENCLAW_CONFIG_PATH) {
    return process.env.OPENCLAW_CONFIG_PATH;
  }
  const homeDir = process.env.OPENCLAW_HOME || require('os').homedir();
  return path.join(homeDir, '.openclaw', 'openclaw.json');
}

// 获取 OpenClaw 主目录
function getOpenClawHome(): string {
  return process.env.OPENCLAW_HOME || path.join(require('os').homedir(), '.openclaw');
}

// 检查 agent 是否已存在
async function checkAgentExists(agentName: string): Promise<boolean> {
  const workspacePath = path.join(getOpenClawHome(), `workspace-${agentName}`);
  if (fs.existsSync(workspacePath)) {
    return true;
  }
  
  try {
    const { stdout } = await execAsync('openclaw agents list --json 2>/dev/null || echo "[]"');
    const agents = JSON.parse(stdout || '[]');
    return agents?.some((a: any) => a.id === agentName || a.name === agentName) || false;
  } catch {
    return false;
  }
}

// 检查 accountId 是否已被占用（在 openclaw.json 的 bindings 中）
function checkAccountIdInUse(accountId: string): { inUse: boolean; agentId?: string } {
  try {
    const configPath = getOpenClawConfigPath();
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    
    const binding = config.bindings?.find(
      (b: any) => b.match?.channel === 'wegirl' && b.match?.accountId === accountId
    );
    
    if (binding) {
      return { inUse: true, agentId: binding.agentId };
    }
    return { inUse: false };
  } catch {
    return { inUse: false };
  }
}

// 检查 accountId 是否已在 Redis 中注册
async function checkAccountIdInRedis(accountId: string, redis: Redis): Promise<boolean> {
  const KEY_PREFIX = 'wegirl:';
  const data = await redis.hgetall(`${KEY_PREFIX}staff:${accountId}`);
  return !!data.staffId;
}

// 执行创建 Agent
export async function executeCreateAgent(
  params: CreateAgentParams,
  ctx: ExecutionContext
): Promise<CreateAgentResult> {
  const { agentName, accountId, instanceId = ctx.instanceId, capabilities = [], role = '-' } = params;
  const results: CreateAgentResult = {
    success: false,
    agentName,
    accountId,
    alreadyExisted: false,
    steps: [],
    metadata: {
      workspacePath: path.join(getOpenClawHome(), 'agents', agentName),
      configUpdated: false,
      redisRegistered: false,
      streamed: false
    }
  };

  try {
    // Step 0: 检查 agentName 是否已存在
    ctx.logger.info(`[hr_manage] Checking if agent ${agentName} exists...`);
    const exists = await checkAgentExists(agentName);
    if (exists) {
      results.alreadyExisted = true;
      results.steps.push({ step: 0, name: 'check_exists', status: 'success', message: 'Agent already exists' });
      results.success = true;
      return results;
    }
    results.steps.push({ step: 0, name: 'check_exists', status: 'success', message: 'Agent does not exist' });

    // Step 0.5: 检查 accountId 是否已被占用
    ctx.logger.info(`[hr_manage] Checking if accountId ${accountId} is available...`);
    const bindingCheck = checkAccountIdInUse(accountId);
    if (bindingCheck.inUse) {
      throw new Error(`accountId "${accountId}" 已被 agent "${bindingCheck.agentId}" 占用，请选择其他 accountId`);
    }
    const redisCheck = await checkAccountIdInRedis(accountId, ctx.redis);
    if (redisCheck) {
      throw new Error(`accountId "${accountId}" 已在 Redis 中注册，请先删除或选择其他 accountId`);
    }
    results.steps.push({ step: 0, name: 'check_accountId', status: 'success', message: 'accountId available' });

    // Step 1: 创建 Agent（使用非交互模式）
    ctx.logger.info(`[hr_manage] Step 1: Creating agent ${agentName}...`);
    
    const workspacePath = path.join(getOpenClawHome(), `agents`, agentName);
    
    // 确保 workspace 目录存在
    if (!fs.existsSync(workspacePath)) {
      fs.mkdirSync(workspacePath, { recursive: true });
    }
    
    try {
      // 使用非交互模式创建 agent（不加 --bind，因为 wegirl 是自定义 channel）
      const cmd = `openclaw agents add ${agentName} --non-interactive --workspace ${workspacePath} --model kimi-coding/k2p5 --json`;
      const { stdout, stderr } = await execAsync(cmd, { timeout: 120000 });
      
      const output = stdout || stderr;
      ctx.logger.info(`[hr_manage] Create agent output: ${output}`);
      
      // 检查输出中是否包含成功标志
      if (output.includes('ready') || output.includes('Agent') || output.includes(agentName)) {
        results.steps.push({ step: 1, name: 'create_agent', status: 'success', message: `Workspace: ${workspacePath}` });
      } else {
        throw new Error(`Failed to create agent: ${output}`);
      }
    } catch (execErr: any) {
      // 如果 agent 已存在，可能是成功的
      if (execErr.message?.includes('already exists') || execErr.stdout?.includes('already exists')) {
        results.steps.push({ step: 1, name: 'create_agent', status: 'success', message: 'Agent already exists' });
      } else {
        throw new Error(`Failed to create agent: ${execErr.message || execErr}`);
      }
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

    if (!config.bindings) config.bindings = [];
    const bindingExists = config.bindings?.some(
      (b: any) => b.agentId === agentName && b.match?.accountId === accountId
    ) || false;
    if (!bindingExists) {
      config.bindings.push(binding);
    }

    // 添加 wegirl account - 复用现有的 plugin 配置
    if (!config.channels) config.channels = {};
    if (!config.channels.wegirl) config.channels.wegirl = { accounts: {} };
    if (!config.channels.wegirl.accounts) config.channels.wegirl.accounts = {};

    // 从 plugin config 获取 Redis 配置（已存在的配置）
    const pluginCfg = config?.plugins?.entries?.wegirl?.config || {};
    
    config.channels.wegirl.accounts[accountId] = {
      enabled: true,
      redisUrl: pluginCfg?.redisUrl || 'redis://localhost:6379',
      redisPassword: pluginCfg?.redisPassword,
      redisDb: pluginCfg?.redisDb ?? 1
    };

    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    results.metadata.configUpdated = true;
    results.steps.push({ step: 2, name: 'update_config', status: 'success' });

    // Step 3: 注册到 Redis (使用统一的 staff key)
    ctx.logger.info(`[hr_manage] Step 3: Registering to Redis...`);
    const KEY_PREFIX = 'wegirl:';
    const agentCapabilities = capabilities.length > 0 ? capabilities : [agentName, 'wegirl_send'];

    // 使用 staff key 存储 agent 信息
    await ctx.redis.hset(`${KEY_PREFIX}staff:${accountId}`, {
      staffId: accountId,
      type: 'agent',
      instanceId: instanceId,
      role: role,
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

    // 添加到类型索引
    await ctx.redis.sadd(`${KEY_PREFIX}staff:by-type:agent`, accountId);

    // 添加到实例集合 (使用 staff 集合)
    await ctx.redis.sadd(`${KEY_PREFIX}instance:${instanceId}:staff`, accountId);

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

  } catch (error: any) {
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
