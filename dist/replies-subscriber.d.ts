interface ReplyMessage {
    flowType: string;
    source: string;
    target: string;
    message: string;
    chatType: string;
    msgType?: string;
    routingId?: string;
    payload?: any;
    timestamp: number;
}
export declare class RepliesSubscriber {
    private subscriber;
    private redisUrl;
    private redisPassword?;
    private logger;
    private messageHandler;
    constructor(redisUrl: string, redisPassword: string | undefined, logger: any, messageHandler: (msg: ReplyMessage) => Promise<void>);
    start(): Promise<void>;
    private handleOnboardHuman;
    stop(): Promise<void>;
}
export {};
//# sourceMappingURL=replies-subscriber.d.ts.map