import type Redis from 'ioredis';
import type { StaffInfo, InstanceInfo, RegistryEntry } from './protocol.js';
export declare class Registry {
    private redis;
    private instanceId;
    private logger;
    private heartbeatTimers;
    constructor(redis: Redis, instanceId: string, logger: any);
    private key;
    registerStaff(staffInfo: StaffInfo, instanceInfo: InstanceInfo): Promise<void>;
    registerAgent(agentInfo: any, instanceInfo: InstanceInfo): Promise<void>;
    registerHuman(humanInfo: any): Promise<void>;
    register(staffInfo: StaffInfo): Promise<void>;
    heartbeat(staffId: string, load?: {
        activeTasks: number;
        pendingTasks: number;
    }): Promise<void>;
    private startHeartbeat;
    unregisterStaff(staffId: string): Promise<void>;
    unregisterAgent(agentId: string): Promise<void>;
    getStaff(staffId: string): Promise<RegistryEntry | null>;
    getAgent(agentId: string): Promise<RegistryEntry | null>;
    getHuman(userId: string): Promise<RegistryEntry | null>;
    findStaffByCapability(capability: string, strategy?: 'least-load' | 'random' | 'first'): Promise<RegistryEntry[]>;
    findAgentsByCapability(capability: string, strategy?: 'least-load' | 'random' | 'first'): Promise<RegistryEntry[]>;
    getInstanceStaff(instanceId: string): Promise<RegistryEntry[]>;
    getOnlineStaff(): Promise<RegistryEntry[]>;
    cleanupExpiredStaff(): Promise<string[]>;
    private flattenObject;
    private unflattenObject;
    destroy(): void;
}
//# sourceMappingURL=registry.d.ts.map