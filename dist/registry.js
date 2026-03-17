// src/registry.ts - Staff 注册与心跳管理 (统一 agents/humans)
const KEY_PREFIX = 'wegirl:';
const HEARTBEAT_INTERVAL = 30000; // 30秒
const HEARTBEAT_TIMEOUT = 90000; // 90秒
export class Registry {
    redis;
    instanceId;
    logger;
    heartbeatTimers = new Map();
    constructor(redis, instanceId, logger) {
        this.redis = redis;
        this.instanceId = instanceId;
        this.logger = logger;
    }
    // 生成 Redis Key
    key(...parts) {
        return `${KEY_PREFIX}${parts.join(':')}`;
    }
    // 注册 Staff (统一 agent/human)
    async registerStaff(staffInfo, instanceInfo) {
        const entry = {
            staffId: staffInfo.staffId,
            type: staffInfo.type, // 'agent' | 'human'
            instanceId: instanceInfo.instanceId,
            name: staffInfo.name,
            capabilities: staffInfo.capabilities || [],
            maxConcurrent: staffInfo.maxConcurrent || 3,
            status: 'online',
            lastHeartbeat: Date.now(),
            metadata: staffInfo.metadata || {},
            load: {
                activeTasks: 0,
                pendingTasks: 0
            }
        };
        const pipeline = this.redis.pipeline();
        // 保存 Staff 信息 (统一 key: wegirl:staff:{id})
        pipeline.hset(this.key('staff', staffInfo.staffId), this.flattenObject(entry));
        // 添加到实例的 Staff 集合
        pipeline.sadd(this.key('instance', instanceInfo.instanceId, 'staff'), staffInfo.staffId);
        // 添加到类型索引
        pipeline.sadd(this.key('staff', 'by-type', staffInfo.type), staffInfo.staffId);
        // 添加到能力索引 (统一)
        for (const cap of staffInfo.capabilities || []) {
            pipeline.sadd(this.key('capability', cap), staffInfo.staffId);
        }
        await pipeline.exec();
        this.logger.info(`[Registry] Staff registered: ${staffInfo.staffId} (${staffInfo.type}) @${instanceInfo.instanceId}`);
        // 只有 agent 启动心跳
        if (staffInfo.type === 'agent') {
            this.startHeartbeat(staffInfo.staffId, instanceInfo.instanceId);
        }
    }
    // 向后兼容: 注册 Agent
    async registerAgent(agentInfo, instanceInfo) {
        await this.registerStaff({
            staffId: agentInfo.agentId,
            type: 'agent',
            name: agentInfo.name,
            capabilities: agentInfo.capabilities,
            maxConcurrent: agentInfo.maxConcurrent,
            metadata: agentInfo.metadata
        }, instanceInfo);
    }
    // 向后兼容: 注册 Human
    async registerHuman(humanInfo) {
        await this.registerStaff({
            staffId: humanInfo.userId,
            type: 'human',
            name: humanInfo.name,
            capabilities: humanInfo.capabilities,
            metadata: {
                departments: humanInfo.departments,
                skills: humanInfo.skills,
                availability: humanInfo.availability
            }
        }, { instanceId: this.instanceId, version: '1.0' });
    }
    // 简化的 register 方法
    async register(staffInfo) {
        await this.registerStaff(staffInfo, { instanceId: this.instanceId, version: '1.0' });
    }
    // 发送心跳
    async heartbeat(staffId, load) {
        const key = this.key('staff', staffId);
        const updates = {
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
    startHeartbeat(staffId, instanceId) {
        if (this.heartbeatTimers.has(staffId)) {
            clearInterval(this.heartbeatTimers.get(staffId));
        }
        const timer = setInterval(async () => {
            try {
                await this.heartbeat(staffId);
            }
            catch (err) {
                this.logger.error(`[Registry] Heartbeat failed for ${staffId}:`, err.message);
            }
        }, HEARTBEAT_INTERVAL);
        this.heartbeatTimers.set(staffId, timer);
    }
    // 注销 Staff
    async unregisterStaff(staffId) {
        // 停止心跳
        if (this.heartbeatTimers.has(staffId)) {
            clearInterval(this.heartbeatTimers.get(staffId));
            this.heartbeatTimers.delete(staffId);
        }
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
    async unregisterAgent(agentId) {
        await this.unregisterStaff(agentId);
    }
    // 查询 Staff 信息
    async getStaff(staffId) {
        const data = await this.redis.hgetall(this.key('staff', staffId));
        if (!data || Object.keys(data).length === 0) {
            return null;
        }
        return this.unflattenObject(data);
    }
    // 向后兼容: 查询 Agent
    async getAgent(agentId) {
        return this.getStaff(agentId);
    }
    // 向后兼容: 查询 Human
    async getHuman(userId) {
        return this.getStaff(userId);
    }
    // 根据能力查找 Staff
    async findStaffByCapability(capability, strategy = 'least-load') {
        const staffIds = await this.redis.smembers(this.key('capability', capability));
        if (staffIds.length === 0) {
            return [];
        }
        const staff = [];
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
    async findAgentsByCapability(capability, strategy = 'least-load') {
        const all = await this.findStaffByCapability(capability, strategy);
        return all.filter(s => s.type === 'agent');
    }
    // 获取实例的所有 Staff
    async getInstanceStaff(instanceId) {
        const staffIds = await this.redis.smembers(this.key('instance', instanceId, 'staff'));
        const staff = [];
        for (const staffId of staffIds) {
            const s = await this.getStaff(staffId);
            if (s) {
                staff.push(s);
            }
        }
        return staff;
    }
    // 获取所有在线 Staff
    async getOnlineStaff() {
        const pattern = this.key('staff', '*');
        const keys = await this.redis.keys(pattern);
        const staff = [];
        for (const key of keys) {
            const staffId = key.split(':').pop();
            if (!staffId)
                continue;
            const s = await this.getStaff(staffId);
            if (s && s.status === 'online') {
                staff.push(s);
            }
        }
        return staff;
    }
    // 清理过期 Staff (仅针对 agent 类型)
    async cleanupExpiredStaff() {
        const offlineStaff = [];
        const now = Date.now();
        // 扫描所有 Staff
        const pattern = this.key('staff', '*');
        const keys = await this.redis.keys(pattern);
        for (const key of keys) {
            const staffId = key.split(':').pop();
            if (!staffId)
                continue;
            const s = await this.getStaff(staffId);
            if (!s)
                continue;
            // 只处理 agent 类型
            if (s.type !== 'agent')
                continue;
            // 检查是否过期
            if (now - s.lastHeartbeat > HEARTBEAT_TIMEOUT && s.status === 'online') {
                await this.redis.hset(key, {
                    status: 'offline',
                    lastHeartbeat: now.toString()
                });
                offlineStaff.push(staffId);
                this.logger.warn(`[Registry] Agent marked offline: ${staffId}`);
            }
        }
        return offlineStaff;
    }
    // 扁平化对象
    flattenObject(obj, prefix = '') {
        const result = {};
        for (const key in obj) {
            const value = obj[key];
            const newKey = prefix ? `${prefix}:${key}` : key;
            if (value === null || value === undefined) {
                continue;
            }
            else if (typeof value === 'object' && !Array.isArray(value)) {
                Object.assign(result, this.flattenObject(value, newKey));
            }
            else if (Array.isArray(value)) {
                result[newKey] = value.join(',');
            }
            else {
                result[newKey] = String(value);
            }
        }
        return result;
    }
    // 反扁平化对象
    unflattenObject(data) {
        const result = {};
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
            }
            else if (value === 'true') {
                current[lastKey] = true;
            }
            else if (value === 'false') {
                current[lastKey] = false;
            }
            else if (!isNaN(Number(value)) && value !== '') {
                current[lastKey] = Number(value);
            }
            else {
                current[lastKey] = value;
            }
        }
        return result;
    }
    // 销毁
    destroy() {
        for (const [staffId, timer] of this.heartbeatTimers) {
            clearInterval(timer);
            this.logger.info(`[Registry] Stopped heartbeat for ${staffId}`);
        }
        this.heartbeatTimers.clear();
    }
}
//# sourceMappingURL=registry.js.map