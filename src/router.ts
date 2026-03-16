// src/router.ts - 消息路由引擎

import Redis from 'ioredis';
import type { 
  MessageEnvelope, 
  Address, 
  RoutingTarget, 
  RegistryEntry,
  HumanInfo,
  AgentInfo
} from './protocol.js';
import { Registry } from './registry.js';
import { PendingQueue } from './queue.js';

const KEY_PREFIX = 'wegirl:';
const STREAM_KEY = `${KEY_PREFIX}messages`;
const INSTANCE_CHANNEL_PREFIX = `${KEY_PREFIX}instance:`;

export interface RouterOptions {
  instanceId: string;
  localDelivery: (envelope: MessageEnvelope) => Promise<void>;
  logger: any;
}

export class MessageRouter {
  private redis: Redis;
  private options: { instanceId: string; logger: any };
  private subscriber: Redis | null = null;
  private isRunning = false;

  constructor(
    redis: Redis,
    instanceId: string,
    logger: any
  ) {
    this.redis = redis;
    this.options = { instanceId, logger };
  }

  // 启动路由（订阅 Redis 消息）
  async startListening(): Promise<void> {
    if (this.isRunning) return;
    
    // 创建独立订阅客户端
    this.subscriber = new Redis(this.redis.options);
    
    const instanceChannel = `${INSTANCE_CHANNEL_PREFIX}${this.options.instanceId}`;
    
    // 订阅实例频道
    await this.subscriber.subscribe(instanceChannel);
    this.options.logger.info(`[Router] Subscribed to ${instanceChannel}`);
    
    // 处理消息
    this.subscriber.on('message', (channel, message) => {
      this.handleChannelMessage(channel, message).catch((err: any) => {
        this.options.logger.error('[Router] Error handling message:', err.message);
      });
    });
    
    this.isRunning = true;
  }

  // 处理频道消息
  private async handleChannelMessage(channel: string, message: string): Promise<void> {
    try {
      const data = JSON.parse(message);
      this.options.logger.info(`[Router] Received message on ${channel}:`, data.type || 'unknown');
      // 这里可以添加本地投递逻辑
    } catch (err: any) {
      this.options.logger.error('[Router] Failed to parse message:', err.message);
    }
  }

  // 停止路由
  async stop(): Promise<void> {
    if (!this.isRunning) return;
    
    if (this.subscriber) {
      await this.subscriber.quit();
      this.subscriber = null;
    }
    
    this.isRunning = false;
    this.options.logger.info('[Router] Stopped');
  }

  // 发布消息到目标实例
  async publishToInstance(instanceId: string, message: any): Promise<void> {
    const channel = `${INSTANCE_CHANNEL_PREFIX}${instanceId}`;
    await this.redis.publish(channel, JSON.stringify(message));
  }
}
