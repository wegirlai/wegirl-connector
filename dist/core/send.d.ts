import type { WeGirlSendOptions, SendResult } from './types.js';
/**
 * V2 核心发送函数
 *
 * 职责：
 * 1. 参数标准化验证
 * 2. 查询目标 Staff 信息
 * 3. A2H 直接发布到 replies
 * 4. 跨实例 → 写入 Redis Stream
 * 5. 本地 → 调用 V1 wegirlSessionsSend
 */
export declare function wegirlSend(options: WeGirlSendOptions, logger?: any): Promise<SendResult>;
export { wegirlSend as wegirlSessionsSend };
//# sourceMappingURL=send.d.ts.map