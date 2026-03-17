import Redis from 'ioredis';
interface WeGirlSendParams {
    target: string;
    message: string;
    channel?: string;
    accountId?: string;
    chatId?: string;
    chatType?: string;
    from?: string;
    replyChannel?: string;
    replyAccountId?: string;
    replyTo?: string;
}
export declare class WeGirlTools {
    private redis;
    private logger;
    private instanceId;
    constructor(redis: Redis, instanceId: string, logger: any);
    private parseTarget;
    send(params: WeGirlSendParams): Promise<any>;
    private publishRoutingEvent;
    register(params: any): Promise<any>;
    query(params: any): Promise<any>;
    private buildAddress;
    private deliverToAgent;
    private deliverToHuman;
    private deliverToCapability;
    private broadcast;
}
export {};
//# sourceMappingURL=tools.d.ts.map