// src/sessions-send.ts - 发送消息到 Agent

import Redis from 'ioredis';
import { getWeGirlRuntime } from "./runtime.js";

type ReplyPayload = {
  text?: string;
  mediaUrl?: string;
  mediaUrls?: string[];
  replyToId?: string;
  replyToTag?: boolean;
  replyToCurrent?: boolean;
  audioAsVoice?: boolean;
  isError?: boolean;
  channelData?: Record<string, unknown>;
};

type ReplyDispatchKind = "tool" | "block" | "final";

interface SessionsSendOptions {
  message: string;
  cfg: any;
  channel: string;
  accountId: string;
  from: string;
  chatId: string;
  chatType: string;
  log?: any;
}

// Redis 连接缓存
let redisClient: Redis | null = null;
let redisConnectPromise: Promise<Redis> | null = null;

async function getRedisPublisher(cfg: any): Promise<Redis> {
  if (redisClient && redisClient.status === 'ready') {
    return redisClient;
  }
  
  if (redisConnectPromise) {
    return redisConnectPromise;
  }
  
  redisConnectPromise = (async () => {
    const channelCfg = cfg?.channels?.['wegirl'] || {};
    const redisUrl = channelCfg?.redisUrl || process.env.REDIS_URL || `redis://${process.env.REDIS_HOST || 'localhost'}:${process.env.REDIS_PORT || '6379'}`;
    const password = channelCfg?.redisPassword || process.env.REDIS_PASSWORD;
    const db = channelCfg?.redisDb || 1;
    
    const options: any = { db };
    if (password) options.password = password;
    
    const client = new Redis(redisUrl, options);
    
    await new Promise<void>((resolve, reject) => {
      client.once('ready', resolve);
      client.once('error', reject);
      setTimeout(() => reject(new Error('Redis connect timeout')), 5000);
    });
    
    redisClient = client;
    return client;
  })();
  
  return redisConnectPromise;
}

/**
 * 使用 PluginRuntime 发送消息
 */
export async function wegirlSessionsSend(options: SessionsSendOptions): Promise<void> {
  const { message, cfg, channel, accountId, from, chatId, chatType, log } = options;
  
  log?.info?.(`[sessionsSend] Called: channel=${channel}, accountId=${accountId}, chatId=${chatId}`);

  // 尝试通过 Redis 转发
  try {
    const redis = await getRedisPublisher(cfg);
    const forwardMsg = {
      type: 'forward',
      message,
      channel,
      accountId,
      from,
      chatId,
      chatType,
      timestamp: Date.now()
    };
    await redis.publish('wegirl:forward', JSON.stringify(forwardMsg));
    log?.info?.('[sessionsSend] Message forwarded via Redis');
  } catch (err: any) {
    log?.error?.('[sessionsSend] Redis forward failed:', err.message);
  }

  // 尝试通过 runtime 发送
  const runtime = getWeGirlRuntime();
  if (!runtime) {
    log?.error?.('[sessionsSend] No runtime available');
    return;
  }

  try {
    const reply = buildReply(message, channel, accountId, chatId, chatType);
    await deliver(runtime, reply, log);
    log?.info?.('[sessionsSend] Message delivered via runtime');
  } catch (err: any) {
    log?.error?.('[sessionsSend] Runtime delivery failed:', err.message);
    throw err;
  }
}

function buildReply(
  message: string,
  channel: string,
  accountId: string,
  chatId: string,
  chatType: string
): any {
  return {
    kind: "final" as ReplyDispatchKind,
    payload: {
      text: message,
      replyToCurrent: true
    } as ReplyPayload,
    target: {
      channel,
      accountId,
      chatId,
      chatType
    }
  };
}

async function deliver(runtime: any, reply: any, log?: any): Promise<void> {
  // 检查 runtime 的 deliver 方法
  if (typeof runtime.deliver === 'function') {
    await runtime.deliver(reply);
    return;
  }
  
  if (typeof runtime.send === 'function') {
    await runtime.send(reply);
    return;
  }
  
  if (typeof runtime.reply === 'function') {
    await runtime.reply(reply);
    return;
  }
  
  log?.warn?.('[sessionsSend] No suitable delivery method found on runtime');
  throw new Error('Runtime has no delivery method');
}
