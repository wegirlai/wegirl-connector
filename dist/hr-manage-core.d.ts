import type Redis from 'ioredis';
export interface ExecutionContext {
    instanceId: string;
    logger: any;
    redis: Redis;
}
export interface CreateAgentParams {
    agentName: string;
    accountId: string;
    instanceId?: string;
    capabilities?: string[];
    role?: string;
}
export interface CreateAgentResult {
    success: boolean;
    agentName: string;
    accountId: string;
    alreadyExisted: boolean;
    steps: StepResult[];
    metadata: {
        workspacePath: string;
        agentDirPath: string;
        configUpdated: boolean;
        restartOpenclaw: boolean;
    };
    error?: string;
}
interface StepResult {
    step: number;
    name: string;
    status: 'success' | 'failed' | 'skipped';
    message?: string;
}
export declare function executeCreateAgent(params: CreateAgentParams, ctx: ExecutionContext): Promise<CreateAgentResult>;
export {};
//# sourceMappingURL=hr-manage-core.d.ts.map