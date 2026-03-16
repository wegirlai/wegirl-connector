import Redis from 'ioredis';
import type { MessageEnvelope } from './protocol.js';
export interface RouterOptions {
    instanceId: string;
    localDelivery: (envelope: MessageEnvelope) => Promise<void>;
    logger: any;
}
export declare class MessageRouter {
    private redis;
    private options;
    private subscriber;
    private isRunning;
    constructor(redis: Redis, instanceId: string, logger: any);
    startListening(): Promise<void>;
    private handleChannelMessage;
    stop(): Promise<void>;
    publishToInstance(instanceId: string, message: any): Promise<void>;
}
//# sourceMappingURL=router.d.ts.map