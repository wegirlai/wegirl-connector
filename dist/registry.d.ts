import type Redis from 'ioredis';
import type { AgentInfo, InstanceInfo, HumanInfo, RegistryEntry } from './protocol.js';
export declare class Registry {
    private redis;
    private instanceId;
    private logger;
    private heartbeatTimers;
    constructor(redis: Redis, instanceId: string, logger: any);
    private key;
    registerAgent(agentInfo: AgentInfo, instanceInfo: InstanceInfo): Promise<void>;
    registerHuman(humanInfo: HumanInfo): Promise<void>;
    register(agentInfo: AgentInfo): Promise<void>;
    heartbeat(agentId: string, load?: {
        activeTasks: number;
        pendingTasks: number;
    }): Promise<void>;
    private startHeartbeat;
    unregisterAgent(agentId: string): Promise<void>;
    getAgent(agentId: string): Promise<RegistryEntry | null>;
    getHuman(userId: string): Promise<HumanInfo | null>;
    findAgentsByCapability(capability: string, strategy?: 'least-load' | 'random' | 'first'): Promise<RegistryEntry[]>;
    findHumansByCapability(capability: string, options?: {
        minLevel?: string;
        requireOnline?: boolean;
    }): Promise<HumanInfo[]>;
    getInstanceAgents(instanceId: string): Promise<RegistryEntry[]>;
    cleanupExpiredAgents(): Promise<string[]>;
    private flattenObject;
    private unflattenObject;
    destroy(): void;
}
//# sourceMappingURL=registry.d.ts.map