// src/replies-subscriber.ts - 订阅 wegirl:replies 并处理消息
import Redis from 'ioredis';
const KEY_PREFIX = 'wegirl:';
export class RepliesSubscriber {
    subscriber = null;
    redisUrl;
    redisPassword;
    logger;
    messageHandler;
    constructor(redisUrl, redisPassword, logger, messageHandler) {
        this.redisUrl = redisUrl;
        this.redisPassword = redisPassword;
        this.logger = logger;
        this.messageHandler = messageHandler;
    }
    async start() {
        const options = {};
        if (this.redisPassword) {
            options.password = this.redisPassword;
        }
        this.subscriber = new Redis(this.redisUrl, options);
        await this.subscriber.subscribe('wegirl:replies');
        this.logger.info('[RepliesSubscriber] Subscribed to wegirl:replies');
        this.subscriber.on('message', async (channel, message) => {
            try {
                const data = JSON.parse(message);
                this.logger.info(`[RepliesSubscriber] Received: ${data.msgType || 'unknown'} from ${data.source}`);
                // 统一处理 message 和 error 类型
                if (data.msgType === 'message' || data.msgType === 'error') {
                    await this.messageHandler(data);
                }
                else if (data.msgType === 'onboard_human') {
                    // 入职消息特殊处理 - 创建 human 用户
                    await this.handleOnboardHuman(data);
                }
                else {
                    this.logger.debug(`[RepliesSubscriber] Ignoring msgType: ${data.msgType}`);
                }
            }
            catch (err) {
                this.logger.error('[RepliesSubscriber] Failed to handle message:', err.message);
            }
        });
    }
    async handleOnboardHuman(data) {
        const { staffId, name, phone, role, capabilities, feishuOpenId } = data.payload || {};
        if (!staffId || !name) {
            this.logger.error('[RepliesSubscriber] Onboard human failed: missing staffId or name');
            return;
        }
        this.logger.info(`[RepliesSubscriber] Onboard human: ${staffId} (${name})`);
        try {
            // 1. 添加到 humans 表
            const redis = new Redis(this.redisUrl, { password: this.redisPassword });
            await redis.hset(`${KEY_PREFIX}humans:${staffId}`, {
                staffId,
                name,
                phone: phone || '',
                role: role || 'member',
                capabilities: JSON.stringify(capabilities || []),
                feishuOpenId: feishuOpenId || '',
                type: 'human',
                status: 'active',
                onboardedAt: Date.now().toString(),
                onboardedBy: data.source,
            });
            this.logger.info(`[RepliesSubscriber] Added to humans table: ${staffId}`);
            // 2. 添加到 wegirl:staff:{staffId}
            await redis.hset(`${KEY_PREFIX}staff:${staffId}`, {
                staffId,
                name,
                type: 'human',
                role: role || 'member',
                capabilities: (capabilities || []).join(','),
                feishuOpenId: feishuOpenId || '',
                status: 'online',
                onboardedAt: Date.now().toString(),
            });
            this.logger.info(`[RepliesSubscriber] Added to staff registry: ${staffId}`);
            // 3. 添加到 humans 索引
            await redis.sadd(`${KEY_PREFIX}humans`, staffId);
            await redis.quit();
            // 4. 发送成功消息给用户
            await this.messageHandler({
                ...data,
                msgType: 'message',
                message: `✅ ${name} 入职成功！\n\n工号：${staffId}\n角色：${role || 'member'}\n能力：${(capabilities || []).join(', ') || '无'}`,
            });
        }
        catch (err) {
            this.logger.error('[RepliesSubscriber] Onboard human failed:', err.message);
            // 发送失败消息
            await this.messageHandler({
                ...data,
                msgType: 'error',
                message: `❌ 入职失败：${err.message}`,
            });
        }
    }
    async stop() {
        if (this.subscriber) {
            await this.subscriber.quit();
            this.subscriber = null;
        }
    }
}
//# sourceMappingURL=replies-subscriber.js.map