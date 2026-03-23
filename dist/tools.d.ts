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
    /**
     * StaffId 标准化规则：
     * - 普通 ID 转小写： "HR" → "hr"
     * - source: 前缀保留： "source:ou_xxx" → "source:ou_xxx"
     */
    normalizeStaffId(id: string | undefined): string | undefined;
    /**
     * 查询 Staff 信息
     * 支持三种方式：id（staffId）、name（精确匹配）、capability（能力匹配）
     */
    queryStaff(by: 'id' | 'name' | 'capability', query: string): Promise<any[]>;
    private formatStaffInfo;
}
export {};
//# sourceMappingURL=tools.d.ts.map