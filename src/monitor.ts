// src/monitor.ts - WeGirl Provider Monitor（每个 agent 独立监听自己的 stream）

import Redis from 'ioredis';
import { getWeGirlPluginConfig } from './config.js';
import { wegirlSessionsSend } from './core/sessions-send.js';

interface MonitorParams {
  accountId: string;
  instanceId: string;
  cfg: any;
  abortSignal?: AbortSignal;
  log?: any;
}

/**
 * 监控 WeGirl Redis Stream（每个 agent 独立）
 * 监听 wegirl:stream:${instanceId}:${accountId}
 * 
 * ⚠️ 设计原则：
 * 1. 此函数从 Stream 接收消息
 * 2. 调用 wegirlSessionsSend 完成实际的 act（Agent 处理）
 * 3. 处理成功后才 ACK 消息（at-least-once 语义）
 * 4. 如果处理失败，消息保留在 pending 列表中，可被重新消费
 */
export async function monitorWeGirlProvider(params: MonitorParams): Promise<void> {
  const { accountId, instanceId, cfg, abortSignal, log } = params;
  
  // 每个 agent 独立的 stream key 和消费者组
  const streamKey = `wegirl:stream:${instanceId}:${accountId}`;
  const consumerGroup = `wegirl-consumers-${instanceId}-${accountId}`;
  const consumerName = `${accountId}-${Date.now()}`;
  
  log?.info?.(`[WeGirl:${accountId}] Starting monitor for stream: ${streamKey}`);
  
  // 1. 创建 Redis 连接
  const pluginCfg = getWeGirlPluginConfig();
  const redis = new Redis({
    host: pluginCfg?.redisHost || '10.8.0.1',
    port: pluginCfg?.redisPort || 6379,
    password: pluginCfg?.redisPassword,
    db: pluginCfg?.redisDb ?? 1,
    maxRetriesPerRequest: null,
    connectTimeout: 10000,
    lazyConnect: true,
  });
  
  // 2. 显式连接 Redis
  try {
    await redis.connect();
    log?.info?.(`[WeGirl:${accountId}] Redis connected`);
  } catch (err: any) {
    log?.error?.(`[WeGirl:${accountId}] Redis connect failed:`, err.message);
    throw err;
  }
  
  // 3. 创建消费者组
  try {
    await redis.xgroup('CREATE', streamKey, consumerGroup, '$', 'MKSTREAM');
    log?.info?.(`[WeGirl:${accountId}] Created consumer group: ${consumerGroup}`);
  } catch (err: any) {
    if (!err.message?.includes('already exists')) {
      log?.error?.(`[WeGirl:${accountId}] Failed to create consumer group:`, err.message);
      throw err;
    }
    log?.debug?.(`[WeGirl:${accountId}] Consumer group already exists: ${consumerGroup}`);
  }
  
  // 4. 消息接收循环
  log?.info?.(`[WeGirl:${accountId}] Entering consume loop...`);
  
  while (!abortSignal?.aborted) {
    try {
      // 读取消息（阻塞 5 秒，每次只读 1 条）
      const result = await (redis as any).xreadgroup(
        'GROUP', consumerGroup, consumerName,
        'BLOCK', 5000,
        'COUNT', 1,
        'STREAMS', streamKey, '>'
      );
      
      if (!result || !Array.isArray(result) || result.length === 0) {
        continue;
      }
      
      const streamData = result[0];
      if (!streamData || !Array.isArray(streamData) || streamData.length < 2) {
        continue;
      }
      
      const entries = streamData[1];
      if (!entries || !Array.isArray(entries) || entries.length === 0) {
        continue;
      }
      
      // 处理消息
      for (const entry of entries) {
        if (!Array.isArray(entry) || entry.length < 2) continue;
        
        const id = entry[0];
        const fields = entry[1];
        
        try {
          // 解析 data 字段
          let messageData = '';
          if (Array.isArray(fields)) {
            for (let i = 0; i < fields.length; i += 2) {
              if (fields[i] === 'data' && i + 1 < fields.length) {
                messageData = fields[i + 1];
                break;
              }
            }
          }
          
          if (!messageData) {
            log?.warn?.(`[WeGirl:${accountId}] No data field in message ${id}`);
            await redis.xack(streamKey, consumerGroup, id);
            continue;
          }
          
          const msg = JSON.parse(messageData);
          
          log?.info?.(`[WeGirl:${accountId}] Received message ${id}: ${msg.flowType} from ${msg.source}`);
          
          // ⚠️ 关键：调用 wegirlSessionsSend，由它内部完成 act
          // 使用 await 确保处理完成后再 ACK，实现 at-least-once 语义
          try {
            await wegirlSessionsSend({
              message: msg.message,
              source: msg.source,
              target: msg.target,
              chatType: msg.chatType || 'direct',
              groupId: msg.groupId,
              routingId: msg.routingId,
              taskId: msg.taskId,
              stepId: msg.stepId,
              stepTotalAgents: msg.stepTotalAgents,
              msgType: msg.msgType,
              payload: msg.payload,
              metadata: msg.metadata,
              replyTo: msg.replyTo,
              flowType: msg.flowType,  // 传递原始 flowType
              fromType: 'outer',
              cfg,
              channel: 'wegirl',
              log,
            });
            
            log?.info?.(`[WeGirl:${accountId}] Message ${id} processed via wegirlSessionsSend`);
            
            // ⚠️ 关键修改：处理成功后再 ACK
            // 这样如果处理失败，消息会保留在 pending 列表中，可被重新消费
            await redis.xack(streamKey, consumerGroup, id);
            log?.debug?.(`[WeGirl:${accountId}] Message ${id} acknowledged after processing`);
            
          } catch (err: any) {
            log?.error?.(`[WeGirl:${accountId}] Message ${id} processing failed:`, err.message);
            // 处理失败，不 ACK，消息会保留在 pending 列表中等待重试
            // 注意：如果失败次数过多，可能需要人工介入清理
          }
          
        } catch (err: any) {
          log?.error?.(`[WeGirl:${accountId}] Failed to parse/ack message ${id}:`, err.message);
        }
      }
    } catch (err: any) {
      log?.error?.(`[WeGirl:${accountId}] Consumer error:`, err.message);
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  
  // 5. 清理
  log?.info?.(`[WeGirl:${accountId}] Monitor stopped`);
  await redis.quit();
}
