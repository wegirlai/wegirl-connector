// src/registry.ts - Agent/人类注册与心跳管理

import type Redis from 'ioredis';
import type { 
  AgentInfo, 
  InstanceInfo, 
  HumanInfo, 
  RegistryEntry,
  MessageEnvelope 
} from './protocol.js';
import { randomUUID } from 'crypto';

const KEY_PREFIX = 'wegirl:';
const HEARTBEAT_INTERVAL = 30000; // 30秒
const HEARTBEAT_TIMEOUT = 90000;  // 90秒

export class Registry {
  private redis: Redis;
  private instanceId: string;
  private logger: any;
  private heartbeatTimers: Map<string, NodeJS.Timeout> = new Map();

  constructor(redis: Redis, instanceId: string, logger: any) {
    this.redis = redis;
    this.instanceId = instanceId;
    this.logger = logger;
  }

  // 生成 Redis Key
  private key(...parts: string[]): string {
    return `${KEY_PREFIX}${parts.join(':')}`;
  }

  // 注册 Agent
  async registerAgent(agentInfo: AgentInfo, instanceInfo: InstanceInfo): Promise<void> {
    const entry: RegistryEntry = {
      agentId: agentInfo.agentId,
      instanceId: instanceInfo.instanceId,
      type: 'agent',
      name: agentInfo.name,
      capabilities: agentInfo.capabilities,
      maxConcurrent: agentInfo.maxConcurrent,
      status: 'online',
      lastHeartbeat: Date.now(),
      metadata: {
        supportedModels: agentInfo.supportedModels,
        ...agentInfo.metadata
      },
      load: {
        activeTasks: 0,
        pendingTasks: 0
      }
    };

    const pipeline = this.redis.pipeline();
    
    // 保存 Agent 信息
    pipeline.hset(this.key('agents', agentInfo.agentId), this.flattenObject(entry));
    
    // 添加到实例的 Agent 集合
    pipeline.sadd(this.key('instance', instanceInfo.instanceId, 'agents'), agentInfo.agentId);
    
    // 添加到能力索引
    for (const cap of agentInfo.capabilities) {
      pipeline.sadd(this.key('capability', cap), agentInfo.agentId);
    }
    
    await pipeline.exec();
    
    this.logger.info(`[Registry] Agent registered: ${agentInfo.agentId}@${instanceInfo.instanceId}`);
    
    // 启动心跳
    this.startHeartbeat(agentInfo.agentId, instanceInfo.instanceId);
  }

  // 注册人类用户
  async registerHuman(humanInfo: HumanInfo): Promise<void> {
    const key = this.key('humans', humanInfo.userId);
    
    const pipeline = this.redis.pipeline();
    pipeline.hset(key, this.flattenObject(humanInfo));
    
    // 添加到能力索引
    for (const cap of humanInfo.capabilities) {
      pipeline.sadd(this.key('capability', cap, 'humans'), humanInfo.userId);
    }
    
    // 添加到部门索引
    if (humanInfo.departments) {
      for (const dept of humanInfo.departments) {
        pipeline.sadd(this.key('department', dept), humanInfo.userId);
      }
    }
    
    await pipeline.exec();
    
    this.logger.info(`[Registry] Human registered: ${humanInfo.userId}`);
  }

  // 简化的 register 方法
  async register(agentInfo: AgentInfo): Promise<void> {
    await this.registerAgent(agentInfo, { instanceId: this.instanceId } as InstanceInfo);
  }

  // 发送心跳
  async heartbeat(agentId: string, load?: { activeTasks: number; pendingTasks: number }): Promise<void> {
    const key = this.key('agents', agentId);
    
    const updates: any = {
      lastHeartbeat: Date.now().toString(),
      status: 'online',
    };
    
    if (load) {
      updates['load:activeTasks'] = load.activeTasks.toString();
      updates['load:pendingTasks'] = load.pendingTasks.toString();
    }
    
    await this.redis.hset(key, updates);
  }

  // 启动定时心跳
  private startHeartbeat(agentId: string, instanceId: string): void {
    if (this.heartbeatTimers.has(agentId)) {
      clearInterval(this.heartbeatTimers.get(agentId)!);
    }

    const timer = setInterval(async () => {
      try {
        await this.heartbeat(agentId);
      } catch (err: any) {
        this.logger.error(`[Registry] Heartbeat failed for ${agentId}:`, err.message);
      }
    }, HEARTBEAT_INTERVAL);

    this.heartbeatTimers.set(agentId, timer);
  }

  // 注销 Agent
  async unregisterAgent(agentId: string): Promise<void> {
    // 停止心跳
    if (this.heartbeatTimers.has(agentId)) {
      clearInterval(this.heartbeatTimers.get(agentId)!);
      this.heartbeatTimers.delete(agentId);
    }

    // 获取 Agent 信息
    const agentData = await this.redis.hgetall(this.key('agents', agentId));
    if (!agentData || Object.keys(agentData).length === 0) {
      return;
    }

    const capabilitiesStr = agentData.capabilities || '';
    const capabilities = capabilitiesStr ? capabilitiesStr.split(',') : [];
    const instanceId = agentData.instanceId;

    const pipeline = this.redis.pipeline();
    
    // 删除 Agent 信息
    pipeline.del(this.key('agents', agentId));
    
    // 从实例集合移除
    if (instanceId) {
      pipeline.srem(this.key('instance', instanceId, 'agents'), agentId);
    }
    
    // 从能力索引移除
    for (const cap of capabilities) {
      if (cap) {
        pipeline.srem(this.key('capability', cap), agentId);
      }
    }
    
    await pipeline.exec();
    
    this.logger.info(`[Registry] Agent unregistered: ${agentId}`);
  }

  // 查询 Agent 信息
  async getAgent(agentId: string): Promise<RegistryEntry | null> {
    const data = await this.redis.hgetall(this.key('agents', agentId));
    if (!data || Object.keys(data).length === 0) {
      return null;
    }
    return this.unflattenObject(data) as RegistryEntry;
  }

  // 查询人类信息
  async getHuman(userId: string): Promise<HumanInfo | null> {
    const data = await this.redis.hgetall(this.key('humans', userId));
    if (!data || Object.keys(data).length === 0) {
      return null;
    }
    return this.unflattenObject(data) as HumanInfo;
  }

  // 根据能力查找 Agent
  async findAgentsByCapability(
    capability: string, 
    strategy: 'least-load' | 'random' | 'first' = 'least-load'
  ): Promise<RegistryEntry[]> {
    const agentIds = await this.redis.smembers(this.key('capability', capability));
    
    if (agentIds.length === 0) {
      return [];
    }

    const agents: RegistryEntry[] = [];
    for (const agentId of agentIds) {
      const agent = await this.getAgent(agentId);
      if (agent && agent.status === 'online') {
        agents.push(agent);
      }
    }

    // 应用策略
    switch (strategy) {
      case 'least-load':
        return agents.sort((a, b) => {
          const loadA = a.load?.activeTasks || 0;
          const loadB = b.load?.activeTasks || 0;
          return loadA - loadB;
        });
      case 'random':
        return agents.sort(() => Math.random() - 0.5);
      case 'first':
      default:
        return agents;
    }
  }

  // 根据能力查找人类
  async findHumansByCapability(
    capability: string,
    options?: {
      minLevel?: string;
      requireOnline?: boolean;
    }
  ): Promise<HumanInfo[]> {
    const userIds = await this.redis.smembers(this.key('capability', capability, 'humans'));
    
    if (userIds.length === 0) {
      return [];
    }

    const humans: HumanInfo[] = [];
    for (const userId of userIds) {
      const human = await this.getHuman(userId);
      if (!human) continue;

      // 检查在线状态
      if (options?.requireOnline && human.availability?.status !== 'online') {
        continue;
      }

      // 检查技能等级
      if (options?.minLevel && human.skills?.[capability]) {
        const level = human.skills[capability].level;
        const levelOrder = { junior: 1, senior: 2, expert: 3 };
        if (levelOrder[level as keyof typeof levelOrder] < levelOrder[options.minLevel as keyof typeof levelOrder]) {
          continue;
        }
      }

      humans.push(human);
    }

    return humans;
  }

  // 获取实例的所有 Agent
  async getInstanceAgents(instanceId: string): Promise<RegistryEntry[]> {
    const agentIds = await this.redis.smembers(this.key('instance', instanceId, 'agents'));
    const agents: RegistryEntry[] = [];
    
    for (const agentId of agentIds) {
      const agent = await this.getAgent(agentId);
      if (agent) {
        agents.push(agent);
      }
    }
    
    return agents;
  }

  // 清理过期 Agent
  async cleanupExpiredAgents(): Promise<string[]> {
    const offlineAgents: string[] = [];
    const now = Date.now();

    // 使用 keys 扫描所有 Agent
    const pattern = this.key('agents', '*');
    const keys = await this.redis.keys(pattern);

    for (const key of keys) {
      const agentId = key.split(':').pop();
      if (!agentId) continue;

      const agent = await this.getAgent(agentId);
      if (!agent) continue;

      // 检查是否过期，只标记为 offline
      if (now - agent.lastHeartbeat > HEARTBEAT_TIMEOUT && agent.status === 'online') {
        await this.redis.hset(key, {
          status: 'offline',
          lastHeartbeat: now.toString()
        });
        offlineAgents.push(agentId);
        this.logger.warn(`[Registry] Agent marked offline: ${agentId}`);
      }
    }

    return offlineAgents;
  }

  // 扁平化对象
  private flattenObject(obj: any, prefix = ''): Record<string, string> {
    const result: Record<string, string> = {};
    
    for (const key in obj) {
      const value = obj[key];
      const newKey = prefix ? `${prefix}:${key}` : key;
      
      if (value === null || value === undefined) {
        continue;
      } else if (typeof value === 'object' && !Array.isArray(value)) {
        Object.assign(result, this.flattenObject(value, newKey));
      } else if (Array.isArray(value)) {
        result[newKey] = value.join(',');
      } else {
        result[newKey] = String(value);
      }
    }
    
    return result;
  }

  // 反扁平化对象
  private unflattenObject(data: Record<string, string>): any {
    const result: any = {};
    
    for (const key in data) {
      const parts = key.split(':');
      let current = result;
      
      for (let i = 0; i < parts.length - 1; i++) {
        const part = parts[i];
        if (!(part in current)) {
          current[part] = {};
        }
        current = current[part];
      }
      
      const lastKey = parts[parts.length - 1];
      const value = data[key];
      
      // 尝试解析数组
      if (value.includes(',')) {
        current[lastKey] = value.split(',').filter(v => v);
      } else if (value === 'true') {
        current[lastKey] = true;
      } else if (value === 'false') {
        current[lastKey] = false;
      } else if (!isNaN(Number(value)) && value !== '') {
        current[lastKey] = Number(value);
      } else {
        current[lastKey] = value;
      }
    }
    
    return result;
  }

  // 销毁
  destroy(): void {
    for (const [agentId, timer] of this.heartbeatTimers) {
      clearInterval(timer);
      this.logger.info(`[Registry] Stopped heartbeat for ${agentId}`);
    }
    this.heartbeatTimers.clear();
  }
}
