// src/router.ts - 消息路由引擎
import Redis from 'ioredis';
import { executeCreateAgent } from './hr-manage-core.js';
const KEY_PREFIX = 'wegirl:';
const STREAM_KEY = `${KEY_PREFIX}messages`;
const INSTANCE_CHANNEL_PREFIX = `${KEY_PREFIX}instance:`;
export class MessageRouter {
    redis;
    options;
    subscriber = null;
    isRunning = false;
    constructor(redis, instanceId, logger) {
        this.redis = redis;
        this.options = { instanceId, logger };
    }
    // 启动路由（订阅 Redis 消息）
    async startListening() {
        if (this.isRunning)
            return;
        // 创建独立订阅客户端
        this.subscriber = new Redis(this.redis.options);
        const instanceChannel = `${INSTANCE_CHANNEL_PREFIX}${this.options.instanceId}`;
        // 订阅实例频道
        await this.subscriber.subscribe(instanceChannel);
        this.options.logger.info(`[Router] Subscribed to ${instanceChannel}`);
        // 处理消息
        this.subscriber.on('message', (channel, message) => {
            this.handleChannelMessage(channel, message).catch((err) => {
                this.options.logger.error('[Router] Error handling message:', err.message);
            });
        });
        this.isRunning = true;
    }
    // 处理频道消息
    async handleChannelMessage(channel, message) {
        try {
            const data = JSON.parse(message);
            this.options.logger.info(`[Router] Received message on ${channel}:`, data.type || 'unknown');
            // 处理 default agent 消息（跨实例任务执行）
            if (data.to?.agentId?.startsWith('default')) {
                await this.handleDefaultMessage(data);
            }
        }
        catch (err) {
            this.options.logger.error('[Router] Failed to handle message:', err.message);
        }
    }
    // 处理 default agent 消息（直接工具执行）
    async handleDefaultMessage(envelope) {
        const payload = typeof envelope.payload === 'string'
            ? JSON.parse(envelope.payload)
            : envelope.payload;
        this.options.logger.info(`[Router][default] Handling tool: ${payload.tool}, action: ${payload.action}`);
        // 只处理 hr_manage 工具
        if (payload.tool === 'hr_manage' && payload.action === 'create_agent') {
            try {
                const result = await executeCreateAgent(payload.params, {
                    instanceId: this.options.instanceId,
                    logger: this.options.logger,
                    redis: this.redis
                });
                // 发送回调
                if (payload.replyTo) {
                    const callbackMsg = {
                        type: 'task_result',
                        taskId: payload.taskId,
                        status: result.success ? 'success' : 'failed',
                        result: {
                            agentName: result.agentName,
                            accountId: result.accountId,
                            created: !result.alreadyExisted,
                            alreadyExisted: result.alreadyExisted,
                            steps: result.steps,
                            requiresRestart: true
                        },
                        error: result.error
                    };
                    // 发送回调消息
                    await this.sendReply(payload.replyTo, callbackMsg);
                }
                // 如果成功创建且需要重启，延迟重启
                if (result.success && !result.alreadyExisted) {
                    this.options.logger.info('[Router][default] Agent created, scheduling restart...');
                    setTimeout(() => {
                        process.exit(0); // 依赖进程管理器重启
                    }, 5000);
                }
            }
            catch (err) {
                this.options.logger.error('[Router][default] Failed to execute create_agent:', err.message);
                // 发送错误回调
                if (payload.replyTo) {
                    await this.sendReply(payload.replyTo, {
                        type: 'task_result',
                        taskId: payload.taskId,
                        status: 'failed',
                        error: err.message
                    });
                }
            }
        }
        else {
            this.options.logger.warn(`[Router][default] Unknown tool or action: ${payload.tool}/${payload.action}`);
        }
    }
    // 发送回调消息
    async sendReply(target, message) {
        try {
            // 解析 target: "agent:hr" 或 "human:user123"
            const [type, id] = target.split(':');
            if (type === 'agent') {
                // 发送给 agent - 通过 Stream
                const replyEnvelope = {
                    type: 'response',
                    metadata: {
                        msgId: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
                        timestamp: Date.now()
                    },
                    from: { type: 'agent', agentId: `default:${this.options.instanceId}` },
                    to: { type: 'agent', agentId: id },
                    payload: { content: JSON.stringify(message), format: 'json' }
                };
                await this.redis.xadd(`${KEY_PREFIX}messages`, '*', 'data', JSON.stringify(replyEnvelope));
            }
            else if (type === 'human') {
                // 发送给 human - 通过待办队列
                await this.redis.zadd(`${KEY_PREFIX}pending:${id}`, Date.now(), JSON.stringify({
                    type: 'notification',
                    content: message,
                    timestamp: Date.now()
                }));
            }
            this.options.logger.info(`[Router] Reply sent to ${target}`);
        }
        catch (err) {
            this.options.logger.error('[Router] Failed to send reply:', err.message);
        }
    }
    // 停止路由
    async stop() {
        if (!this.isRunning)
            return;
        if (this.subscriber) {
            await this.subscriber.quit();
            this.subscriber = null;
        }
        this.isRunning = false;
        this.options.logger.info('[Router] Stopped');
    }
    // 发布消息到目标实例
    async publishToInstance(instanceId, message) {
        const channel = `${INSTANCE_CHANNEL_PREFIX}${instanceId}`;
        await this.redis.publish(channel, JSON.stringify(message));
    }
}
//# sourceMappingURL=router.js.map