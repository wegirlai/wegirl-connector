import Redis from 'ioredis';
import type { WeGirlSendOptions, SendResult } from './types.js';
/**
 * 写入响应（由接收方 Agent 调用）
 */
export declare function writeResponse(redis: Redis, routingId: string, message: string, payload?: Record<string, any>, logger?: any): Promise<void>;
/**
 * V2 核心发送函数
 *
 * 职责：
 * 1. 参数标准化验证
 * 2. 查询目标 Staff 信息
 * 3. A2H 直接发布到 replies
 * 4. 统一写入 Redis Stream（不分本地/远程）
 * 5. 同步模式 → 阻塞等待响应（timeoutSeconds > 0）
 */
export declare function wegirlSend(options: WeGirlSendOptions, logger?: any): Promise<SendResult>;
export { wegirlSend as wegirlSessionsSend };
//# sourceMappingURL=send.d.ts.map