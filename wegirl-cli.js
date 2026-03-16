#!/usr/bin/env node
/**
 * WeGirl CLI - 完整命令行工具
 * 包含所有 Gateway 方法，直接操作 Redis
 */

import Redis from 'ioredis';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Redis 配置
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const REDIS_PASSWORD = process.env.REDIS_PASSWORD || '';
const REDIS_DB = parseInt(process.env.REDIS_DB || '0');
const KEY_PREFIX = 'wegirl:';
const EVENT_PREFIX = 'openclaw:events:';

// 初始化 Redis 客户端
function createRedisClient() {
  const options = {
    retryStrategy: (times) => Math.min(times * 50, 2000),
    maxRetriesPerRequest: 3,
  };
  
  if (REDIS_PASSWORD) options.password = REDIS_PASSWORD;
  if (REDIS_DB !== undefined && REDIS_DB !== null && !isNaN(REDIS_DB)) {
    options.db = REDIS_DB;
  }
  
  const client = new Redis(REDIS_URL, options);
  client.on('error', () => {}); // 抑制错误输出
  return client;
}

// ========== 辅助函数 ==========

function generateId(prefix = '') {
  return `${prefix}${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

// ========== Task 操作 ==========

async function createTask(redis, userId, type, title, description, metadata = {}, priority = 'normal') {
  const taskId = generateId('task_');
  const priorityNum = { low: 1, normal: 2, high: 3, urgent: 4 }[priority] || 2;
  
  const task = {
    taskId, userId, status: 'pending', type, title,
    description: description || '',
    metadata: JSON.stringify(metadata || {}),
    priority: priorityNum, retryCount: 0,
    createdAt: Date.now(), updatedAt: Date.now(),
  };

  const pipeline = redis.pipeline();
  pipeline.hset(`${KEY_PREFIX}task:${taskId}`, task);
  pipeline.zadd(`${KEY_PREFIX}tasks:${userId}:by_status`, Date.now(), `pending:${taskId}`);
  pipeline.zadd(`${KEY_PREFIX}tasks:${userId}:timeline`, Date.now(), taskId);
  await pipeline.exec();
  
  return { ...task, metadata: JSON.parse(task.metadata) };
}

async function listTasks(redis, userId, options = {}) {
  const { status, limit = 10, offset = 0 } = options;
  const key = `${KEY_PREFIX}tasks:${userId}:by_status`;
  
  let entries = await redis.zrange(key, 0, -1);
  if (status) {
    const statuses = status.split(',');
    entries = entries.filter(e => statuses.some(s => e.startsWith(`${s}:`)));
  }
  
  const total = entries.length;
  const paginated = entries.slice(offset, offset + limit);
  
  const tasks = await Promise.all(paginated.map(async (entry) => {
    const taskId = entry.split(':').slice(1).join(':');
    const data = await redis.hgetall(`${KEY_PREFIX}task:${taskId}`);
    if (!data.taskId) return null;
    return {
      ...data,
      metadata: JSON.parse(data.metadata || '{}'),
      priority: parseInt(data.priority) || 2,
      createdAt: parseInt(data.createdAt) || 0,
      updatedAt: parseInt(data.updatedAt) || 0,
      retryCount: parseInt(data.retryCount) || 0,
    };
  }));
  
  return { tasks: tasks.filter(Boolean), total };
}

async function getTask(redis, taskId) {
  const data = await redis.hgetall(`${KEY_PREFIX}task:${taskId}`);
  if (!data.taskId) return null;
  return {
    ...data,
    metadata: JSON.parse(data.metadata || '{}'),
    priority: parseInt(data.priority) || 2,
    createdAt: parseInt(data.createdAt) || 0,
    updatedAt: parseInt(data.updatedAt) || 0,
    retryCount: parseInt(data.retryCount) || 0,
  };
}

async function updateTask(redis, taskId, status, extra = {}) {
  const exists = await redis.exists(`${KEY_PREFIX}task:${taskId}`);
  if (!exists) return null;
  
  const { decision, decisionBy, decisionMessage } = extra;
  const updates = { status, updatedAt: Date.now() };
  if (decision) updates.decision = decision;
  if (decisionBy) updates.decisionBy = decisionBy;
  if (decisionMessage) updates.decisionMessage = decisionMessage;
  
  const taskData = await redis.hgetall(`${KEY_PREFIX}task:${taskId}`);
  const userId = taskData.userId;
  const oldStatus = taskData.status;
  
  const pipeline = redis.pipeline();
  pipeline.hset(`${KEY_PREFIX}task:${taskId}`, updates);
  if (oldStatus !== status) {
    pipeline.zrem(`${KEY_PREFIX}tasks:${userId}:by_status`, `${oldStatus}:${taskId}`);
    pipeline.zadd(`${KEY_PREFIX}tasks:${userId}:by_status`, Date.now(), `${status}:${taskId}`);
  }
  await pipeline.exec();
  
  return getTask(redis, taskId);
}

async function deleteTask(redis, taskId) {
  const taskData = await redis.hgetall(`${KEY_PREFIX}task:${taskId}`);
  if (!taskData.taskId) return false;
  
  const pipeline = redis.pipeline();
  pipeline.del(`${KEY_PREFIX}task:${taskId}`);
  pipeline.zrem(`${KEY_PREFIX}tasks:${taskData.userId}:by_status`, `${taskData.status}:${taskId}`);
  pipeline.zrem(`${KEY_PREFIX}tasks:${taskData.userId}:timeline`, taskId);
  await pipeline.exec();
  return true;
}

async function getPendingCount(redis, userId) {
  const key = `${KEY_PREFIX}tasks:${userId}:by_status`;
  const entries = await redis.zrange(key, 0, -1);
  return entries.filter(e => e.startsWith('pending:')).length;
}

// ========== Agent 操作 ==========

async function listAgents(redis, options = {}) {
  const { status = 'all', capability } = options;
  
  const agentKeys = await redis.keys(`${KEY_PREFIX}agents:*`);
  const humanKeys = await redis.keys(`${KEY_PREFIX}humans:*`);
  
  const [agents, humans] = await Promise.all([
    Promise.all(agentKeys.map(async (key) => {
      const data = await redis.hgetall(key);
      if (!data.agentId) return null;
      if (status !== 'all' && data.status !== status) return null;
      return {
        id: data.agentId,
        name: data.name || 'Unknown',
        type: data.type || 'agent',
        instanceId: data.instanceId,
        status: data.status || 'unknown',
        capabilities: data.capabilities ? data.capabilities.split(',') : []
      };
    })),
    Promise.all(humanKeys.map(async (key) => {
      const data = await redis.hgetall(key);
      if (!data.userId) return null;
      return {
        id: data.userId,
        name: data.name || 'Unknown',
        type: 'human',
        instanceId: data.instanceId,
        status: data.status || 'unknown',
        capabilities: data.capabilities ? data.capabilities.split(',') : []
      };
    }))
  ]);
  
  return { 
    agents: agents.filter(Boolean), 
    humans: humans.filter(Boolean),
    total: agents.filter(Boolean).length + humans.filter(Boolean).length
  };
}

async function getAgent(redis, agentId) {
  const data = await redis.hgetall(`${KEY_PREFIX}agents:${agentId}`);
  if (!data.agentId) return null;
  
  const now = Date.now();
  const lastHeartbeat = parseInt(data.lastHeartbeat) || 0;
  const heartbeatAge = now - lastHeartbeat;
  
  return {
    agentId: data.agentId,
    name: data.name,
    instanceId: data.instanceId,
    type: data.type || 'agent',
    status: data.status,
    capabilities: data.capabilities?.split(',') || [],
    maxConcurrent: parseInt(data.maxConcurrent) || 3,
    supportedModels: data['metadata:supportedModels']?.split(',') || [],
    lastHeartbeat, heartbeatAgeMs: heartbeatAge,
    heartbeatAgeSec: Math.floor(heartbeatAge / 1000),
    isOnline: data.status === 'online' && heartbeatAge < 90000,
    load: {
      activeTasks: parseInt(data['load:activeTasks']) || 0,
      pendingTasks: parseInt(data['load:pendingTasks']) || 0
    }
  };
}

// ========== Human 操作 ==========

async function registerHuman(redis, userId, name, capabilities = []) {
  const humanData = {
    userId,
    name: name || userId,
    status: 'online',
    instanceId: 'cli-instance',
    capabilities: Array.isArray(capabilities) ? capabilities.join(',') : capabilities,
    registeredAt: Date.now(),
    lastSeen: Date.now()
  };
  
  await redis.hset(`${KEY_PREFIX}humans:${userId}`, humanData);
  
  // 添加能力索引
  const caps = Array.isArray(capabilities) ? capabilities : (capabilities ? capabilities.split(',') : []);
  for (const cap of caps) {
    if (cap.trim()) {
      await redis.sadd(`${KEY_PREFIX}capability:${cap}:humans`, userId);
    }
  }
  
  return humanData;
}

async function unregisterHuman(redis, userId) {
  // 获取用户信息以清理能力索引
  const data = await redis.hgetall(`${KEY_PREFIX}humans:${userId}`);
  if (data.capabilities) {
    const caps = data.capabilities.split(',');
    for (const cap of caps) {
      if (cap.trim()) {
        await redis.srem(`${KEY_PREFIX}capability:${cap}:humans`, userId);
      }
    }
  }
  
  await redis.del(`${KEY_PREFIX}humans:${userId}`);
  return true;
}

// ========== Capability 操作 ==========

async function getCapabilityStats(redis) {
  const capKeys = await redis.keys(`${KEY_PREFIX}capability:*`);
  const capabilities = {};
  
  for (const keyStr of capKeys) {
    const parts = keyStr.split(':');
    if (parts.length < 3) continue;
    
    const capName = parts[2];
    const isHuman = parts[3] === 'humans';
    const count = await redis.scard(keyStr);
    
    if (!capabilities[capName]) capabilities[capName] = { agents: 0 };
    if (isHuman) capabilities[capName].humans = count;
    else capabilities[capName].agents = count;
  }
  
  return capabilities;
}

// ========== Event 操作 ==========

async function getRecentEvents(redis, options = {}) {
  const { limit = 10, type } = options;
  
  let eventIds = [];
  
  if (type) {
    // 按类型筛选
    const ids = await redis.smembers(`${EVENT_PREFIX}type:${type}`);
    const sortedIds = [];
    for (const id of ids) {
      const score = await redis.zscore(`${EVENT_PREFIX}timeline`, id);
      if (score !== null) sortedIds.push({ id, score });
    }
    sortedIds.sort((a, b) => b.score - a.score);
    eventIds = sortedIds.slice(0, Math.abs(limit)).map(x => x.id);
  } else if (limit < 0) {
    const allIds = await redis.zrange(`${EVENT_PREFIX}timeline`, 0, -1);
    const index = allIds.length + limit;
    eventIds = index >= 0 ? [allIds[index]] : [];
  } else {
    eventIds = await redis.zrevrange(`${EVENT_PREFIX}timeline`, 0, limit - 1);
  }
  
  const events = await Promise.all(eventIds.map(async (id) => {
    const data = await redis.hgetall(`${EVENT_PREFIX}data:${id}`);
    if (!data.id) return null;
    return {
      id: data.id,
      type: data.type,
      timestamp: parseInt(data.timestamp),
      payload: JSON.parse(data.payload || '{}'),
    };
  }));
  
  return { events: events.filter(Boolean), total: events.filter(Boolean).length, filter: { type, limit } };
}

async function getEventStats(redis) {
  const eventTypes = [
    'before_agent_start', 'agent_end', 'subagent_spawning', 'agent_error',
    'message_received', 'message_sent', 'session_created', 'session_ended',
    'before_tool_call', 'after_tool_call'
  ];
  
  const typeCounts = {};
  for (const type of eventTypes) {
    const count = await redis.scard(`${EVENT_PREFIX}type:${type}`);
    typeCounts[type] = count;
  }
  
  return { typeCounts, totalTypes: eventTypes.length };
}

// ========== Stats 操作 ==========

async function getStats(redis) {
  const pipeline = redis.pipeline();
  pipeline.dbsize();
  pipeline.info('memory');
  
  const [dbResult, infoResult] = await pipeline.exec();
  const keyCount = dbResult[1];
  const info = infoResult[1];
  
  // 解析内存信息
  const usedMemory = info.match(/used_memory:(\d+)/)?.[1] || '0';
  const usedMemoryHuman = info.match(/used_memory_human:([\w.]+)/)?.[1] || '0';
  
  return {
    redis: {
      keys: keyCount,
      usedMemory: parseInt(usedMemory),
      usedMemoryHuman
    },
    wegirl: {
      agents: (await redis.keys(`${KEY_PREFIX}agents:*`)).length,
      humans: (await redis.keys(`${KEY_PREFIX}humans:*`)).length,
      tasks: (await redis.keys(`${KEY_PREFIX}task:*`)).length
    }
  };
}

// ========== Send 操作 ==========

async function sendMessage(redis, target, message, fromAgentId = 'cli', options = {}) {
  const [targetType, targetId] = target.split(':');
  if (!targetType || !targetId) throw new Error('Invalid target format. Use human:id or agent:id');
  
  const routingId = generateId('routing_');
  
  // 发给 human：创建任务
  if (targetType === 'human') {
    const task = await createTask(
      redis, targetId, 'notification',
      message.substring(0, 50),
      message,
      { from: fromAgentId, routingId },
      'normal'
    );
    return { success: true, taskId: task.taskId, target, messageLength: message.length, routingId };
  }
  
  // 发给 agent：通过 Stream 发送
  if (targetType === 'agent') {
    // 获取 agent 信息
    const agentData = await redis.hgetall(`${KEY_PREFIX}agents:${targetId}`);
    if (!agentData.agentId) {
      throw new Error(`Agent not found: ${targetId}`);
    }
    
    const targetInstanceId = agentData.instanceId || 'instance-local';
    const streamKey = `${KEY_PREFIX}stream:instance:${targetInstanceId}`;
    
    const deliveryParams = {
      routingId,
      message,
      channel: options.channel || 'wegirl',
      accountId: options.accountId || 'default',
      chatId: options.chatId || targetId,
      chatType: options.chatType || 'direct',
      from: fromAgentId,
      targetType: 'agent',
      targetId: targetId
    };
    
    // 通过 Stream 发送消息（跨实例通信）
    const messageId = await redis.xadd(
      streamKey,
      'MAXLEN', '~', 5000,
      '*',
      'data', JSON.stringify(deliveryParams)
    );
    
    return {
      success: true,
      target: `agent:${targetId}`,
      targetInstanceId,
      messageLength: message.length,
      routingId,
      messageId,
      streamKey,
      via: 'stream'
    };
  }
  
  throw new Error(`Unsupported target type: ${targetType}`);
}

// ========== Health & Test ==========

async function healthCheck(redis) {
  const start = Date.now();
  await redis.ping();
  const latency = Date.now() - start;
  
  return {
    status: 'ok',
    redis: { connected: redis.status === 'ready', latency: `${latency}ms` },
    timestamp: Date.now()
  };
}

async function testConnection(redis) {
  const start = Date.now();
  await redis.ping();
  const latency = Date.now() - start;
  
  return {
    redisConnected: redis.status === 'ready',
    latency: `${latency}ms`,
    timestamp: Date.now()
  };
}

// ========== Stream 监控操作 ==========

async function getStreamStatus(redis, options = {}) {
  const { instanceId = 'instance-local' } = options;
  const streamKey = `${KEY_PREFIX}stream:instance:${instanceId}`;
  const consumerGroup = 'wegirl-consumers';
  
  const result = {
    instanceId,
    streamKey,
    consumerGroup,
    timestamp: Date.now()
  };
  
  // 1. Stream 基本信息
  try {
    const streamInfo = await redis.xinfo('STREAM', streamKey);
    const infoMap = {};
    for (let i = 0; i < streamInfo.length; i += 2) {
      infoMap[streamInfo[i]] = streamInfo[i + 1];
    }
    result.stream = {
      exists: true,
      length: infoMap.length || 0,
      radixTreeKeys: infoMap['radix-tree-keys'],
      radixTreeNodes: infoMap['radix-tree-nodes'],
      groups: infoMap.groups || 0,
      lastGeneratedId: infoMap['last-generated-id'],
      firstEntry: infoMap['first-entry'] ? {
        id: infoMap['first-entry'][0],
        data: infoMap['first-entry'][1]
      } : null,
      lastEntry: infoMap['last-entry'] ? {
        id: infoMap['last-entry'][0],
        data: infoMap['last-entry'][1]
      } : null
    };
  } catch (err) {
    if (err.message?.includes('no such key')) {
      result.stream = { exists: false, length: 0 };
    } else {
      result.stream = { error: err.message };
    }
  }
  
  // 2. Consumer Group 信息
  try {
    const groupInfo = await redis.xinfo('GROUPS', streamKey);
    const groups = [];
    for (const group of groupInfo) {
      const groupMap = {};
      for (let i = 0; i < group.length; i += 2) {
        groupMap[group[i]] = group[i + 1];
      }
      groups.push({
        name: groupMap.name,
        consumers: groupMap.consumers || 0,
        pending: groupMap.pending || 0,
        lastDeliveredId: groupMap['last-delivered-id']
      });
    }
    result.consumerGroups = groups;
  } catch (err) {
    if (err.message?.includes('no such key')) {
      result.consumerGroups = [];
    } else {
      result.consumerGroups = { error: err.message };
    }
  }
  
  // 3. Pending 消息详情
  try {
    const pending = await redis.xpending(streamKey, consumerGroup);
    if (pending && Array.isArray(pending)) {
      result.pending = {
        count: pending[0] || 0,
        minId: pending[1] || null,
        maxId: pending[2] || null
      };
      
      // 如果 pending 数量 > 0，获取详细列表
      if (pending[0] > 0) {
        const pendingDetails = await redis.xpending(
          streamKey, consumerGroup,
          '-', '+', Math.min(pending[0], 10)
        );
        result.pending.details = pendingDetails.map((p) => ({
          messageId: p[0],
          consumer: p[1],
          idleTimeMs: p[2],
          deliveryCount: p[3]
        }));
      }
    }
  } catch (err) {
    result.pending = { error: err.message };
  }
  
  return result;
}

async function listStreamConsumers(redis, options = {}) {
  const { instanceId = 'instance-local' } = options;
  const streamKey = `${KEY_PREFIX}stream:instance:${instanceId}`;
  const consumerGroup = 'wegirl-consumers';
  
  try {
    const consumers = await redis.xinfo('CONSUMERS', streamKey, consumerGroup);
    return {
      streamKey,
      consumerGroup,
      consumers: consumers.map(c => {
        const consumerMap = {};
        for (let i = 0; i < c.length; i += 2) {
          consumerMap[c[i]] = c[i + 1];
        }
        return {
          name: consumerMap.name,
          pending: consumerMap.pending || 0,
          idle: consumerMap.idle || 0
        };
      })
    };
  } catch (err) {
    return { error: err.message };
  }
}

async function getStreamEntries(redis, options = {}) {
  const { instanceId = 'instance-local', count = 10, reverse = false } = options;
  const streamKey = `${KEY_PREFIX}stream:instance:${instanceId}`;
  
  try {
    let entries;
    if (reverse) {
      entries = await redis.xrevrange(streamKey, '+', '-', 'COUNT', count);
    } else {
      entries = await redis.xrange(streamKey, '-', '+', 'COUNT', count);
    }
    
    return {
      streamKey,
      count: entries.length,
      entries: entries.map(([id, fields]) => {
        const fieldMap = {};
        for (let i = 0; i < fields.length; i += 2) {
          fieldMap[fields[i]] = fields[i + 1];
        }
        return { id, data: fieldMap };
      })
    };
  } catch (err) {
    return { error: err.message };
  }
}

async function clearStream(redis, options = {}) {
  const { instanceId = 'instance-local', force = false } = options;
  const streamKey = `${KEY_PREFIX}stream:instance:${instanceId}`;
  
  if (!force) {
    return { 
      warning: 'This will delete all messages in the stream. Use --force to confirm.',
      streamKey,
      messageCount: await redis.xlen(streamKey).catch(() => 0)
    };
  }
  
  await redis.del(streamKey);
  return { success: true, streamKey, action: 'deleted' };
}

// ========== CLI 命令处理 ==========

const COMMANDS = {
  // 健康检查
  'health': async (redis) => await healthCheck(redis),
  'test': async (redis) => await testConnection(redis),
  
  // 统计
  'stats': async (redis) => await getStats(redis),
  
  // Stream 监控
  'stream.status': async (redis, args) => await getStreamStatus(redis, args),
  'stream.consumers': async (redis, args) => await listStreamConsumers(redis, args),
  'stream.entries': async (redis, args) => await getStreamEntries(redis, args),
  'stream.clear': async (redis, args) => await clearStream(redis, args),
  'agents': async (redis, args) => await listAgents(redis, args),
  'agent.list': async (redis, args) => {
    const { status, capability } = args;
    return await listAgents(redis, { status, capability });
  },
  'agent.get': async (redis, args) => {
    const { agentId } = args;
    if (!agentId) throw new Error('Missing required: agentId');
    const agent = await getAgent(redis, agentId);
    if (!agent) throw new Error(`Agent not found: ${agentId}`);
    return { agent };
  },
  
  // Human 管理
  'human.register': async (redis, args) => {
    const { userId, name, capabilities } = args;
    if (!userId) throw new Error('Missing required: userId');
    const caps = capabilities ? capabilities.split(',') : [];
    const human = await registerHuman(redis, userId, name, caps);
    return { human };
  },
  'human.unregister': async (redis, args) => {
    const { userId } = args;
    if (!userId) throw new Error('Missing required: userId');
    const success = await unregisterHuman(redis, userId);
    return { success, userId };
  },
  
  // Capability 统计
  'capability.stats': async (redis) => await getCapabilityStats(redis),
  
  // Event 查询
  'event.recent': async (redis, args) => {
    const { limit = 10, type } = args;
    return await getRecentEvents(redis, { limit: parseInt(limit), type });
  },
  'event.stats': async (redis) => await getEventStats(redis),
  
  // 待办队列（兼容旧接口）
  'pending': async (redis, args) => {
    const { userId } = args;
    if (!userId) throw new Error('Missing required: userId');
    const count = await getPendingCount(redis, userId);
    return { userId, count };
  },
  
  // 任务管理
  'task.create': async (redis, args) => {
    const { userId, type, title, description, metadata, priority } = args;
    if (!userId || !type || !title) throw new Error('Missing required: userId, type, title');
    const metaObj = metadata ? (typeof metadata === 'string' ? JSON.parse(metadata) : metadata) : {};
    const task = await createTask(redis, userId, type, title, description, metaObj, priority);
    return { task };
  },
  'task.list': async (redis, args) => {
    const { userId, status, limit, offset } = args;
    if (!userId) throw new Error('Missing required: userId');
    return await listTasks(redis, userId, { status, limit: parseInt(limit) || 10, offset: parseInt(offset) || 0 });
  },
  'task.get': async (redis, args) => {
    const { taskId } = args;
    if (!taskId) throw new Error('Missing required: taskId');
    const task = await getTask(redis, taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    return { task };
  },
  'task.update': async (redis, args) => {
    const { taskId, status, decision, decisionBy, decisionMessage } = args;
    if (!taskId || !status) throw new Error('Missing required: taskId, status');
    const task = await updateTask(redis, taskId, status, { decision, decisionBy, decisionMessage });
    if (!task) throw new Error(`Task not found: ${taskId}`);
    return { task };
  },
  'task.decide': async (redis, args) => {
    const { taskId, decision, decisionBy, message } = args;
    if (!taskId || !decision || !decisionBy) throw new Error('Missing required: taskId, decision, decisionBy');
    const newStatus = decision === 'approve' ? 'approved' : 'rejected';
    const task = await updateTask(redis, taskId, newStatus, { decision, decisionBy, decisionMessage: message });
    if (!task) throw new Error(`Task not found: ${taskId}`);
    return { task };
  },
  'task.delete': async (redis, args) => {
    const { taskId } = args;
    if (!taskId) throw new Error('Missing required: taskId');
    const success = await deleteTask(redis, taskId);
    return { success, taskId };
  },
  
  // 发送消息
  'send': async (redis, args) => {
    const { target, message, from, channel, accountId, chatId, chatType } = args;
    if (!target || !message) throw new Error('Missing required: target, message');
    const options = { channel, accountId, chatId, chatType };
    return await sendMessage(redis, target, message, from, options);
  },
};

// ========== 参数解析 ==========

function parseArgs() {
  const args = process.argv.slice(2);
  const command = args[0];
  
  if (!command || command === '--help' || command === '-h') {
    showHelp();
    process.exit(0);
  }
  
  const params = {};
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const key = arg.replace(/^--/, '');
      const nextArg = args[i + 1];
      if (nextArg && !nextArg.startsWith('--')) {
        params[key] = tryParseJson(nextArg);
        i++;
      } else {
        params[key] = true;
      }
    } else if (arg.startsWith('{')) {
      Object.assign(params, JSON.parse(arg));
    }
  }
  
  return { command, params };
}

function tryParseJson(str) {
  try {
    return JSON.parse(str);
  } catch {
    return str;
  }
}

function showHelp() {
  console.log(`
WeGirl CLI - 完整命令行工具

用法: wegirl <command> [options]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📊 系统状态
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  health           健康检查
  test             连接测试
  stats            系统统计

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📊 Stream 监控
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  stream.status    Stream 状态（消息数、Consumer Group、Pending）
                   [--instanceId <id>]
  stream.consumers 列出所有 Consumers
                   [--instanceId <id>]
  stream.entries   查看 Stream 消息
                   [--instanceId <id>] [--count <n>] [--reverse]
  stream.clear     清空 Stream（危险！）
                   [--instanceId <id>] --force

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
👥 Agent 管理
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  agents           列出所有 agents 和 humans
  agent.list       列出 agents（支持筛选）
                   --status <online|offline|all>
                   --capability <cap>
  agent.get        获取 agent 详情
                   --agentId <id>

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
👤 Human 管理
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  human.register   注册人类用户
                   --userId <id> --name <name> --capabilities <cap1,cap2>
  human.unregister 删除人类用户
                   --userId <id>

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🎯 Capability 统计
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  capability.stats 能力统计

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📅 Event 事件
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  event.recent     最近事件
                   --limit <n> --type <event_type>
  event.stats      事件统计

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📋 任务管理
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  task.create      创建任务
                   --userId <id> --type <type> --title <title>
                   [--description <desc>] [--metadata <json>] [--priority <level>]
  task.list        列出任务
                   --userId <id> [--status <status>] [--limit <n>] [--offset <n>]
  task.get         获取任务详情
                   --taskId <id>
  task.update      更新任务状态
                   --taskId <id> --status <status>
  task.decide      审批任务
                   --taskId <id> --decision <approve|reject> --decisionBy <who>
  task.delete      删除任务
                   --taskId <id>

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
💬 消息
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  send             发送消息
                   --target <human:id|agent:id> --message <msg> [--from <agent>]
                   [--channel <ch>] [--accountId <id>] [--chatId <id>] [--chatType <type>]
  pending          查看待办数量
                   --userId <id>

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
💡 示例
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  wegirl health
  wegirl agents
  wegirl agent.get --agentId scout
  wegirl stream.status
  wegirl stream.status --instanceId instance-prod
  wegirl stream.entries --count 5 --reverse
  wegirl task.list --userId tiger --status pending
  wegirl task.create --userId tiger --type url_review --title "审查" --description "内容"
  wegirl task.decide --taskId task_xxx --decision approve --decisionBy tiger
  wegirl send --target human:tiger --message "Hello!"

环境变量:
  REDIS_URL, REDIS_PASSWORD, REDIS_DB
`);
}

// ========== 主函数 ==========

async function main() {
  const { command, params } = parseArgs();
  
  const handler = COMMANDS[command];
  if (!handler) {
    console.error(`❌ 未知命令: ${command}`);
    console.error('使用 --help 查看帮助');
    process.exit(1);
  }
  
  const redis = createRedisClient();
  
  try {
    const result = await handler(redis, params);
    console.log(JSON.stringify({ ok: true, result }, null, 2));
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
    process.exit(1);
  } finally {
    await redis.quit();
  }
}

main().catch(console.error);
