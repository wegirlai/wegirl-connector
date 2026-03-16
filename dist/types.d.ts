export interface PluginConfig {
    instanceId?: string;
    redisUrl?: string;
    redisPassword?: string;
    redisDb?: number;
    keyPrefix?: string;
    ttl?: number;
    enablePubSub?: boolean;
}
export interface EventPayload {
    sessionId?: string;
    conversationId?: string;
    userId?: string;
    senderId?: string;
    content?: string;
    to?: string;
    channelId?: string;
    accountId?: string;
    tool?: string;
    params?: Record<string, unknown>;
    result?: unknown;
    duration?: number;
    agentId?: string;
    id?: string;
    createdAt?: number;
    messageCount?: number;
    model?: string;
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
    messageId?: string;
    raw?: unknown;
    [key: string]: unknown;
}
export interface PersistedEvent {
    id: string;
    type: string;
    timestamp: number;
    payload: string;
    sessionId: string;
    userId: string;
}
export interface MessageEnvelope {
    metadata: {
        msgId: string;
        traceId?: string;
        timestamp: number;
        ttl?: number;
        priority?: 'low' | 'normal' | 'high' | 'urgent';
        version?: string;
        replyTo?: string;
    };
    from: {
        type: 'agent' | 'human' | 'system' | 'broadcast';
        agentId?: string;
        instanceId?: string;
        sessionKey?: string;
        userId?: string;
    };
    to: {
        type: 'agent' | 'human' | 'system' | 'broadcast';
        agentId?: string;
        instanceId?: string;
        sessionKey?: string;
        userId?: string;
    };
    type: 'request' | 'response' | 'event' | 'error' | 'heartbeat' | 'register';
    payload: Record<string, unknown>;
    context?: {
        workflow?: {
            workflowId: string;
            step: number;
            totalSteps?: number;
            variables?: Record<string, unknown>;
        };
        session?: Record<string, unknown>;
        custom?: Record<string, unknown>;
    };
    routing?: {
        mode: 'agent' | 'capability' | 'workflow' | 'broadcast' | 'human';
        agentId?: string;
        userId?: string;
        capability?: string;
        strategy?: string;
        workflowId?: string;
        step?: number;
        action?: 'next' | 'retry' | 'skip' | 'cancel';
        filter?: {
            capabilities?: string[];
            instanceId?: string;
            departments?: string[];
        };
    };
}
export type CleanupFunction = () => Promise<void> | void;
export interface ServiceConfig {
    id: string;
    start: () => Promise<CleanupFunction | void>;
}
export type RegisterServiceFunction = (service: ServiceConfig) => void;
export interface PluginMeta {
    label: string;
    selectionLabel?: string;
    docsPath?: string;
    blurb?: string;
}
export interface PluginCapabilities {
    chatTypes: ('direct' | 'group' | 'thread')[];
    threads?: boolean;
    polls?: boolean;
    ephemeral?: boolean;
    edit?: boolean;
    delete?: boolean;
}
export interface AccountContext {
    accountId: string;
    cfg: any;
    account: any;
    runtime: {
        emit: (event: string, data: any) => void;
        logger: {
            info: (msg: string, ...args: any[]) => void;
            error: (msg: string, ...args: any[]) => void;
        };
    };
    abortSignal: AbortSignal;
    log: {
        info: (msg: string) => void;
        error: (msg: string) => void;
    };
    getStatus: () => any;
    setStatus: (status: {
        running: boolean;
    }) => void;
}
export interface ConfigAdapter {
    listAccountIds: (cfg: any) => string[];
    resolveAccount: (cfg: any, id: string | null) => any;
    isConfigured?: (account: any, cfg?: any) => boolean | Promise<boolean>;
    isEnabled?: (account: any, cfg?: any) => boolean;
    defaultAccountId?: (cfg?: any) => string;
    describeAccount?: (e: any) => any;
}
export interface SecurityAdapter {
    resolveDmPolicy: () => {
        policy: 'open' | 'pairing' | 'closed';
        allowFrom: string[];
        policyPath?: string;
        allowFromPath?: string;
        approveHint?: string;
    };
}
export interface OutboundAdapter {
    deliveryMode: 'direct' | 'queued';
    sendText: (params: {
        text: string;
        to: string;
        conversationId: string;
        sessionId?: string;
        accountId?: string;
        metadata?: any;
    }) => Promise<{
        ok: boolean;
        messageId?: string;
        error?: string;
    }>;
    sendCard?: (params: {
        card: any;
        to: string;
        conversationId: string;
        sessionId?: string;
        accountId?: string;
    }) => Promise<{
        ok: boolean;
        messageId?: string;
    }>;
    updateMessage?: (params: {
        messageId: string;
        content: any;
        conversationId: string;
    }) => Promise<{
        ok: boolean;
    }>;
}
export interface GatewayAdapter {
    startAccount: (ctx: AccountContext) => Promise<(() => Promise<void>) | void>;
}
export interface ChannelPlugin {
    id: string;
    meta: PluginMeta;
    capabilities?: PluginCapabilities;
    config?: ConfigAdapter;
    security?: SecurityAdapter;
    outbound?: OutboundAdapter;
    gateway?: GatewayAdapter;
    setup?: {
        resolveAccountId?: (params: {
            cfg: any;
            accountId?: string;
        }) => string;
        applyAccountName?: (params: {
            cfg: any;
            accountId: string;
            name?: string;
        }) => any;
        applyAccountConfig: (params: {
            cfg: any;
            accountId: string;
            input: any;
        }) => any;
        validateInput?: (params: {
            cfg: any;
            accountId: string;
            input: any;
        }) => string | null;
    };
    status?: (ctx: AccountContext) => Promise<{
        ok: boolean;
        message?: string;
    }>;
}
export interface ChannelRegistration {
    plugin: ChannelPlugin;
}
export type RegisterChannelFunction = (registration: ChannelRegistration) => void;
export interface PluginContext {
    logger: {
        info: (message: string, ...args: unknown[]) => void;
        error: (message: string, ...args: unknown[]) => void;
        warn: (message: string, ...args: unknown[]) => void;
        debug: (message: string, ...args: unknown[]) => void;
    };
    runtime?: any;
    pluginConfig?: PluginConfig;
    on: (event: string, handler: (data: EventPayload) => void | Promise<void>) => void;
    registerService: RegisterServiceFunction;
    registerChannel: RegisterChannelFunction;
    registerGatewayMethod: (method: string, handler: (ctx: {
        respond: (success: boolean, data: unknown) => void;
        params?: Record<string, unknown>;
    }) => void | Promise<void>) => void;
    registerTool?: (tool: {
        name: string;
        description: string;
        parameters: object;
        handler: (params: any, context: any) => Promise<any>;
    }) => void;
    registerHttpRoute?: (params: {
        path: string;
        method?: string;
        handler: (req: {
            method: string;
            url: string;
            headers: Record<string, string>;
            body: string;
        }, res: {
            status: (code: number) => {
                json: (data: any) => void;
                send: (data: string) => void;
                end: () => void;
            };
        }) => void | Promise<void>;
    }) => {
        unregister: () => void;
    };
}
//# sourceMappingURL=types.d.ts.map