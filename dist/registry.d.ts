import type Redis from 'ioredis';
import type { RegistryEntry } from './protocol.js';
export declare class Registry {
    private redis;
    private instanceId;
    private logger;
    constructor(redis: Redis, instanceId: string, logger: any);
    private key;
    getStaff(staffId: string): Promise<RegistryEntry | null>;
    getAgent(agentId: string): Promise<RegistryEntry | null>;
    getHuman(userId: string): Promise<RegistryEntry | null>;
    findStaffByCapability(capability: string, strategy?: 'least-load' | 'random' | 'first'): Promise<RegistryEntry[]>;
    findAgentsByCapability(capability: string, strategy?: 'least-load' | 'random' | 'first'): Promise<RegistryEntry[]>;
    getInstanceStaff(instanceId: string): Promise<RegistryEntry[]>;
    getOnlineStaff(): Promise<RegistryEntry[]>;
    unregisterStaff(staffId: string): Promise<void>;
    unregisterAgent(agentId: string): Promise<void>;
    destroy(): void;
    private flattenObject;
    private unflattenObject;
}
//# sourceMappingURL=registry.d.ts.map