// src/registry.ts - Staff 注册与心跳管理（仅保留查询和注销，注册统一由 syncAgentsFromLocal 完成）

import type Redis from 'ioredis';
import type { 
  StaffInfo,
  InstanceInfo, 
  RegistryEntry,
} from './protocol.js';

const KEY_PREFIX = 'wegirl:';

export class Registry {
  private redis: Redis;
  private instanceId: string;
  private logger: any;

  constructor(redis: Redis, instanceId: string, logger: any) {
    this.redis = redis;
    this.instanceId = instanceId;
    this.logger = logger;
  }

  // 生成 Redis Key
  private key(...parts: string[]): string {
    return `${KEY_PREFIX}${parts.join(':')}`;
  }

  // ===== 查询方法（保留）=====

  // 查询 Staff 信息
  async getStaff(staffId: string): Promise<RegistryEntry | null> {
    const data = await this.redis.hgetall(this.key('staff', staffId));
    if (!data || Object.keys(data).length === 0) {
      return null;
    }
    return this.unflattenObject(data) as RegistryEntry;
  }

  // 向后兼容: 查询 Agent
  async getAgent(agentId: string): Promise<RegistryEntry | null> {
    return this.getStaff(agentId);
  }

  // 向后兼容: 查询 Human
  async getHuman(userId: string): Promise<RegistryEntry | null> {
    return this.getStaff(userId);
  }

  // 根据能力查找 Staff
  async findStaffByCapability(
    capability: string, 
    strategy: 'least-load' | 'random' | 'first' = 'least-load'
  ): Promise<RegistryEntry[]> {
    const staffIds = await this.redis.smembers(this.key('capability', capability));
    
    if (staffIds.length === 0) {
      return [];
    }

    const staff: RegistryEntry[] = [];
    for (const staffId of staffIds) {
      const s = await this.getStaff(staffId);
      if (s && s.status === 'online') {
        staff.push(s);
      }
    }

    // 应用策略
    switch (strategy) {
      case 'least-load':
        return staff.sort((a, b) => {
          const loadA = a.load?.activeTasks || 0;
          const loadB = b.load?.activeTasks || 0;
          return loadA - loadB;
        });
      case 'random':
        return staff.sort(() => Math.random() - 0.5);
      case 'first':
      default:
        return staff;
    }
  }

  // 向后兼容: 根据能力查找 Agent
  async findAgentsByCapability(
    capability: string, 
    strategy: 'least-load' | 'random' | 'first' = 'least-load'
  ): Promise<RegistryEntry[]> {
    const all = await this.findStaffByCapability(capability, strategy);
    return all.filter(s => s.type === 'agent');
  }

  // 获取实例的所有 Staff
  async getInstanceStaff(instanceId: string): Promise<RegistryEntry[]> {
    const staffIds = await this.redis.smembers(this.key('instance', instanceId, 'staff'));
    const staff: RegistryEntry[] = [];
    
    for (const staffId of staffIds) {
      const s = await this.getStaff(staffId);
      if (s) {
        staff.push(s);
      }
    }
    
    return staff;
  }

  // 获取所有在线 Staff
  async getOnlineStaff(): Promise<RegistryEntry[]> {
    const pattern = this.key('staff', '*');
    const keys = await this.redis.keys(pattern);
    
    const staff: RegistryEntry[] = [];
    for (const key of keys) {
      const staffId = key.split(':').pop();
      if (!staffId) continue;
      
      const s = await this.getStaff(staffId);
      if (s && s.status === 'online') {
        staff.push(s);
      }
    }
    
    return staff;
  }

  // ===== 注销方法（保留，用于 syncAgentsFromLocal 清理僵尸 agent）=====

  // 注销 Staff
  async unregisterStaff(staffId: string): Promise<void> {
    // 获取 Staff 信息
    const staffData = await this.redis.hgetall(this.key('staff', staffId));
    if (!staffData || Object.keys(staffData).length === 0) {
      return;
    }

    const capabilitiesStr = staffData.capabilities || '';
    const capabilities = capabilitiesStr ? capabilitiesStr.split(',') : [];
    const instanceId = staffData.instanceId;
    const type = staffData.type;

    const pipeline = this.redis.pipeline();
    
    // 删除 Staff 信息
    pipeline.del(this.key('staff', staffId));
    
    // 从实例集合移除
    if (instanceId) {
      pipeline.srem(this.key('instance', instanceId, 'staff'), staffId);
    }
    
    // 从类型索引移除
    if (type) {
      pipeline.srem(this.key('staff', 'by-type', type), staffId);
    }
    
    // 从能力索引移除
    for (const cap of capabilities) {
      if (cap) {
        pipeline.srem(this.key('capability', cap), staffId);
      }
    }
    
    await pipeline.exec();
    
    this.logger.info(`[Registry] Staff unregistered: ${staffId}`);
  }

  // 向后兼容: 注销 Agent
  async unregisterAgent(agentId: string): Promise<void> {
    await this.unregisterStaff(agentId);
  }

  // 销毁
  destroy(): void {
    // 清理资源
  }

  // ===== 工具方法 =====

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
}
