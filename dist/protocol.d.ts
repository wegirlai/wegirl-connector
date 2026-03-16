export declare const PROTOCOL_VERSION = "1.0";
export type AddressType = 'agent' | 'human' | 'system' | 'broadcast';
export type MessageType = 'request' | 'response' | 'event' | 'error' | 'heartbeat' | 'register';
export type RoutingMode = 'agent' | 'capability' | 'workflow' | 'broadcast' | 'human';
export type CapabilityStrategy = 'first' | 'round-robin' | 'least-load' | 'random';
export interface Address {
    type: AddressType;
    agentId?: string;
    instanceId?: string;
    sessionKey?: string;
    userId?: string;
}
export interface MessageMetadata {
    msgId: string;
    traceId?: string;
    timestamp: number;
    ttl?: number;
    priority?: 'low' | 'normal' | 'high' | 'urgent';
    version?: string;
    replyTo?: string;
}
export interface RoutingTarget {
    mode: RoutingMode;
    agentId?: string;
    capability?: string;
    strategy?: CapabilityStrategy;
    workflowId?: string;
    step?: number;
    action?: 'next' | 'retry' | 'skip' | 'cancel';
    userId?: string;
    filter?: {
        capabilities?: string[];
        instanceId?: string;
        departments?: string[];
    };
}
export interface WorkflowContext {
    workflowId: string;
    step: number;
    totalSteps?: number;
    history?: WorkflowStep[];
    variables?: Record<string, unknown>;
}
export interface WorkflowStep {
    step: number;
    agentId: string;
    result: string;
    timestamp: number;
}
export interface MessageContext {
    workflow?: WorkflowContext;
    session?: Record<string, unknown>;
    custom?: Record<string, unknown>;
}
export interface MessageEnvelope {
    metadata: MessageMetadata;
    from: Address;
    to: Address;
    type: MessageType;
    payload: MessagePayload;
    context?: MessageContext;
    routing?: RoutingTarget;
}
export interface MessagePayload {
    content?: string;
    format?: 'text' | 'json' | 'markdown' | 'card';
    attachments?: Attachment[];
    status?: 'pending' | 'approved' | 'rejected' | 'completed' | 'failed';
    metadata?: Record<string, unknown>;
    code?: string;
    message?: string;
    retryable?: boolean;
    originalMsgId?: string;
    eventType?: string;
    data?: unknown;
    load?: number;
    activeSessions?: number;
    capabilities?: string[];
    agentInfo?: AgentInfo;
    instanceInfo?: InstanceInfo;
}
export interface Attachment {
    type: string;
    name: string;
    url?: string;
    content?: string;
    mimeType?: string;
}
export interface AgentInfo {
    agentId: string;
    name: string;
    capabilities: string[];
    maxConcurrent: number;
    supportedModels?: string[];
    metadata?: Record<string, unknown>;
}
export interface InstanceInfo {
    instanceId: string;
    version: string;
    region?: string;
    host?: string;
}
export interface HumanInfo {
    type: 'human';
    userId: string;
    name: string;
    capabilities: string[];
    departments?: string[];
    availability: {
        status: 'online' | 'busy' | 'offline' | 'dnd';
        workHours?: string;
        timezone?: string;
    };
    load?: {
        pendingTasks: number;
        maxConcurrent: number;
    };
    skills?: Record<string, SkillInfo>;
}
export interface SkillInfo {
    level: 'junior' | 'senior' | 'expert';
    years?: number;
    authorized?: boolean;
}
export interface PendingItem {
    metadata: MessageMetadata;
    from: Address;
    originalTarget: string;
    payload: MessagePayload;
    queuedAt: number;
    retryCount: number;
    priority: number;
}
export interface WeGirlSendParams {
    target: string;
    message: string;
    context?: {
        workflowId?: string;
        step?: number;
        timeout?: number;
        requirements?: Record<string, unknown>;
    };
    options?: {
        waitForReply?: boolean;
        priority?: 'low' | 'normal' | 'high' | 'urgent';
        ttl?: number;
    };
}
export interface RegistryEntry {
    agentId: string;
    instanceId: string;
    type: 'agent' | 'human';
    name: string;
    capabilities: string[];
    maxConcurrent: number;
    status: 'online' | 'offline' | 'busy';
    lastHeartbeat: number;
    metadata?: Record<string, unknown>;
    load?: {
        activeTasks: number;
        pendingTasks: number;
    };
}
//# sourceMappingURL=protocol.d.ts.map