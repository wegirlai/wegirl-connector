// src/core/sessions-send.ts - 发送消息到 Agent (V1 核心层) - 使用 dispatchReplyWithBufferedBlockDispatcher
import Redis from 'ioredis';
import { getWeGirlRuntime } from "../runtime.js";
import { buildMessage } from './utils.js';
import { createReplyPrefixOptions, resolveOutboundMediaUrls } from "openclaw/plugin-sdk";
// Redis 连接缓存
let redisClient = null;
let redisConnectPromise = null;
const agentQueues = new Map();
const agentProcessing = new Map();
// ========== Session 锁等待机制 ==========
import * as fs from 'fs';
import * as path from 'path';
/**
 * 获取 agent 的 session lock 文件路径
 */
function getSessionLockPath(agentId) {
    // 从 openclaw.json 或环境变量获取 workspace 路径
    const workspaceBase = process.env.OPENCLAW_WORKSPACE || '/root/.openclaw';
    return path.join(workspaceBase, 'agents', agentId, 'sessions', '*.jsonl.lock');
}
/**
 * 检查是否有 session lock 文件存在
 */
async function hasSessionLock(agentId) {
    try {
        const workspaceBase = process.env.OPENCLAW_WORKSPACE || '/root/.openclaw';
        const sessionsDir = path.join(workspaceBase, 'agents', agentId, 'sessions');
        if (!fs.existsSync(sessionsDir)) {
            return false;
        }
        const files = fs.readdirSync(sessionsDir);
        return files.some(f => f.endsWith('.jsonl.lock'));
    }
    catch {
        return false;
    }
}
/**
 * 等待 session lock 释放（带超时）
 */
async function waitForSessionLock(agentId, maxWaitMs = 30000, log) {
    const startTime = Date.now();
    const checkInterval = 500; // 每 500ms 检查一次
    while (Date.now() - startTime < maxWaitMs) {
        const hasLock = await hasSessionLock(agentId);
        if (!hasLock) {
            return true; // Lock 已释放
        }
        log?.debug?.(`[SessionLock] ${agentId} is locked, waiting... (${Date.now() - startTime}ms)`);
        await new Promise(resolve => setTimeout(resolve, checkInterval));
    }
    log?.warn?.(`[SessionLock] Timeout waiting for ${agentId} after ${maxWaitMs}ms`);
    return false; // 超时
}
async function processAgentQueue(target, log) {
    const queue = agentQueues.get(target);
    if (!queue || queue.length === 0) {
        agentProcessing.set(target, false);
        return;
    }
    agentProcessing.set(target, true);
    const next = queue.shift();
    if (!next) {
        agentProcessing.set(target, false);
        return;
    }
    try {
        // 等待 session lock 释放
        log?.info?.(`[AgentQueue] Waiting for ${target} session lock...`);
        const lockReleased = await waitForSessionLock(target, 30000, log);
        if (!lockReleased) {
            throw new Error(`Session lock timeout for ${target}`);
        }
        log?.info?.(`[AgentQueue] Processing message for ${target}, queue length: ${queue.length}`);
        await processMessage(next.options);
        next.resolve();
    }
    catch (err) {
        log?.error?.(`[AgentQueue] Failed to process message for ${target}: ${err.message}`);
        next.reject(err);
    }
    finally {
        // 给一个短暂的延迟，确保 OpenClaw 完全释放锁
        await new Promise(resolve => setTimeout(resolve, 100));
        // 继续处理队列中的下一个
        setImmediate(() => processAgentQueue(target, log));
    }
}
async function enqueueMessage(options) {
    const { target, log } = options;
    return new Promise((resolve, reject) => {
        const queue = agentQueues.get(target) || [];
        queue.push({ options, resolve, reject });
        agentQueues.set(target, queue);
        log?.info?.(`[AgentQueue] Enqueued message for ${target}, queue length: ${queue.length}`);
        // 如果没有正在处理的消息，开始处理
        if (!agentProcessing.get(target)) {
            processAgentQueue(target, log);
        }
    });
}
async function getRedisPublisher(cfg) {
    if (redisClient && redisClient.status === 'ready') {
        return redisClient;
    }
    if (redisConnectPromise) {
        return redisConnectPromise;
    }
    redisConnectPromise = (async () => {
        // 统一从 openclaw.json 的 plugins.wegirl.config 读取
        const pluginCfg = cfg?.plugins?.entries?.wegirl?.config || {};
        const redisUrl = pluginCfg?.redisUrl || 'redis://localhost:6379';
        const password = pluginCfg?.redisPassword;
        const db = pluginCfg?.redisDb ?? 1;
        const client = new Redis(redisUrl, {
            password: password,
            db: db,
        });
        await new Promise((resolve, reject) => {
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
 * 辅助函数：根据 source 和 target 判断 flowType（从 Redis 查询）
 */
async function determineFlowType(redis, src, tgt, log) {
    // 辅助函数：从 Redis 查询 staff 类型
    async function getStaffType(staffId) {
        try {
            // 去掉 source: 前缀
            const cleanId = staffId.startsWith('source:') ? staffId.slice(7) : staffId;
            const data = await redis.hgetall(`wegirl:staff:${cleanId}`);
            return data.type || 'unknown';
        }
        catch (err) {
            log?.warn?.(`[determineFlowType] Failed to get staff type for ${staffId}:`, err);
            return 'unknown';
        }
    }
    const [sourceType, targetType] = await Promise.all([
        getStaffType(src),
        getStaffType(tgt)
    ]);
    log?.info?.(`[determineFlowType] Staff types: source=${src}(${sourceType}), target=${tgt}(${targetType})`);
    if (sourceType === 'human' && targetType === 'agent')
        return 'H2A';
    if (sourceType === 'agent' && targetType === 'human')
        return 'A2H';
    if (sourceType === 'agent' && targetType === 'agent')
        return 'A2A';
    if (sourceType === 'human' && targetType === 'human')
        return 'H2H';
    // 如果查询失败，使用启发式规则
    const isHumanSource = src.startsWith('source:') || src.startsWith('ou_');
    const isHumanTarget = tgt.startsWith('source:') || tgt.startsWith('ou_') || !tgt.includes(':');
    if (isHumanSource && !isHumanTarget)
        return 'H2A';
    if (!isHumanSource && isHumanTarget)
        return 'A2H';
    if (!isHumanSource && !isHumanTarget)
        return 'A2A';
    return 'H2A';
}
/**
 * 辅助函数：对调 flowType（H2A <-> A2H，A2A 保持）
 */
function reverseFlowType(flowType) {
    const map = {
        'H2A': 'A2H',
        'A2H': 'H2A',
        'A2A': 'A2A',
        'H2H': 'H2H'
    };
    return map[flowType] || flowType;
}
/**
 * 辅助函数：推断媒体类型
 */
function inferMediaType(url) {
    const ext = url.split('.').pop()?.toLowerCase();
    const mimeMap = {
        'jpg': 'image/jpeg',
        'jpeg': 'image/jpeg',
        'png': 'image/png',
        'gif': 'image/gif',
        'webp': 'image/webp',
        'mp4': 'video/mp4',
        'mp3': 'audio/mpeg',
        'pdf': 'application/pdf',
        'doc': 'application/msword',
        'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    };
    return mimeMap[ext || ''] || 'application/octet-stream';
}
/**
 * 处理 Agent 回复的核心逻辑（在 deliver 回调中调用）
 */
async function handleAgentReply(params) {
    const { payload, flowType, source, target, chatType, groupId, chatId, routingId, originalRoutingId, messageId, createdAt, originalMetadata, cfg, channel, taskId, stepId, agentCount, log } = params;
    const text = payload.text ?? '';
    const mediaUrls = resolveOutboundMediaUrls(payload);
    log?.info?.(`[handleAgentReply] Processing reply: target=${target}, text=${text.substring(0, 50)}, mediaCount=${mediaUrls.length}`);
    // 获取 timeoutSeconds（从 options.metadata 或默认值）
    const timeoutSeconds = originalMetadata?.timeoutSeconds || 0;
    const responseTtl = timeoutSeconds > 0 ? timeoutSeconds + 30 : 60;
    const responseRoutingId = originalMetadata?.responseRoutingId;
    const awaitResponse = originalMetadata?.awaitResponse;
    // ========== 1. 同步等待响应回写（同步模式）==========
    if (awaitResponse && responseRoutingId) {
        try {
            const redis = await getRedisPublisher(cfg);
            if (redis) {
                const responseData = buildMessage({
                    flowType: reverseFlowType(flowType),
                    source: target,
                    target: source,
                    message: text,
                    chatType,
                    routingId: responseRoutingId,
                    msgType: 'response',
                    fromType: 'inner',
                    metadata: {
                        originalRoutingId,
                        mediaUrls: mediaUrls.length > 0 ? mediaUrls : undefined,
                    }
                });
                await redis.lpush(`wegirl:response:${responseRoutingId}`, JSON.stringify(responseData));
                await redis.expire(`wegirl:response:${responseRoutingId}`, responseTtl);
                log?.info?.(`[handleAgentReply] Sync response written to Redis: ${responseRoutingId}`);
            }
        }
        catch (err) {
            log?.error?.(`[handleAgentReply] Failed to write sync response: ${err.message}`);
        }
        // 同步模式下继续执行后续转发逻辑（如果有 replyTo）
    }
    // ========== 2. 转发给 replyTo（同步和异步都支持）==========
    const originalReplyTo = originalMetadata?.replyTo;
    const replyToList = Array.isArray(originalReplyTo) ? originalReplyTo : (originalReplyTo ? [originalReplyTo] : []);
    const validReplyToList = replyToList.filter(r => r && r !== source);
    if (validReplyToList.length > 0) {
        log?.info?.(`[handleAgentReply] Detected ${validReplyToList.length} replyTo targets: ${validReplyToList.join(', ')}`);
        const forwardResults = [];
        for (const replyToTarget of validReplyToList) {
            try {
                // 动态导入避免循环依赖
                const { wegirlSend } = await import('./send.js');
                const targetType = replyToTarget.startsWith('human:') ||
                    replyToTarget.startsWith('source:') ||
                    replyToTarget.startsWith('ou_')
                    ? 'A2H' : 'A2A';
                // 如果有媒体，先发送媒体
                if (mediaUrls.length > 0) {
                    for (const mediaUrl of mediaUrls) {
                        await wegirlSend({
                            flowType: targetType,
                            source: target,
                            target: replyToTarget.replace(/^human:/, ''),
                            message: '', // 媒体消息可以不带文本
                            routingId: `${routingId}-fwd-media-${replyToTarget}`,
                            chatType: 'direct',
                            timeoutSeconds: 0,
                            msgType: 'media',
                            payload: {
                                mediaUrl,
                                mediaType: inferMediaType(mediaUrl),
                            }
                        }, log);
                    }
                }
                // 发送文本
                if (text.trim()) {
                    await wegirlSend({
                        flowType: targetType,
                        source: target,
                        target: replyToTarget.replace(/^human:/, ''),
                        message: text,
                        routingId: `${routingId}-fwd-${replyToTarget}`,
                        chatType: 'direct',
                        timeoutSeconds: 0
                    }, log);
                }
                log?.info?.(`[handleAgentReply] Successfully forwarded to ${replyToTarget}`);
                forwardResults.push({ target: replyToTarget, success: true });
            }
            catch (err) {
                log?.error?.(`[handleAgentReply] Forward to ${replyToTarget} failed: ${err.message}`);
                forwardResults.push({ target: replyToTarget, success: false, error: err.message });
            }
        }
        // 如果有失败的，通知 source（调用方）
        const failedTargets = forwardResults.filter(r => !r.success);
        if (failedTargets.length > 0) {
            try {
                const { wegirlSend } = await import('./send.js');
                const failedNames = failedTargets.map(t => t.target).join(', ');
                await wegirlSend({
                    flowType: 'A2A',
                    source: target,
                    target: source,
                    message: `❌ 转发给 [${failedNames}] 失败`,
                    routingId: `${routingId}-err`,
                    chatType: 'direct',
                    timeoutSeconds: 0
                }, log);
            }
            catch (notifyErr) {
                log?.error?.(`[handleAgentReply] Failed to notify source: ${notifyErr.message}`);
            }
        }
        // 如果有 replyTo，转发完成后不再执行后续默认逻辑
        return;
    }
    // ========== 3. 群聊多 agent 处理 ==========
    if (chatType === 'group' && taskId && agentCount && agentCount > 1) {
        const effectiveAgentId = stepId || target;
        log?.info?.(`[handleAgentReply] Group multi-agent reply: taskId=${taskId}, agent=${effectiveAgentId}`);
        try {
            const pub = await getRedisPublisher(cfg);
            if (!pub) {
                log?.error?.(`[handleAgentReply] Redis publisher not connected`);
                return;
            }
            // 分析回复内容确定状态
            let replyStatus;
            if (text.startsWith('NO_REPLY') || (text.trim() === '' && mediaUrls.length === 0)) {
                replyStatus = 'no_reply';
            }
            else if (text.startsWith('ERROR:') || text.includes('失败') || text.includes('错误')) {
                replyStatus = 'error';
            }
            else if (text.includes('超时') || text.includes('timeout')) {
                replyStatus = 'timeout';
            }
            else {
                replyStatus = 'completed';
            }
            // 如果有媒体，先发送媒体消息
            if (mediaUrls.length > 0) {
                for (const mediaUrl of mediaUrls) {
                    const mediaMessage = buildMessage({
                        flowType: reverseFlowType(flowType),
                        source: target,
                        target: source,
                        message: '',
                        chatType: 'group',
                        groupId,
                        routingId,
                        msgType: 'media',
                        fromType: 'inner',
                        metadata: {
                            replyStatus,
                            taskId,
                            isFinal: false,
                            duration: Date.now() - createdAt,
                            mediaUrl,
                            mediaType: inferMediaType(mediaUrl),
                        }
                    });
                    await pub.publish('wegirl:replies', JSON.stringify(mediaMessage));
                }
            }
            // 发送文本消息
            if (text.trim()) {
                const replyMessage = buildMessage({
                    flowType: reverseFlowType(flowType),
                    source: target,
                    target: source,
                    message: text,
                    chatType: 'group',
                    groupId,
                    routingId,
                    msgType: 'message',
                    fromType: 'inner',
                    metadata: {
                        replyStatus,
                        taskId,
                        isFinal: true,
                        duration: Date.now() - createdAt,
                    }
                });
                await pub.publish('wegirl:replies', JSON.stringify(replyMessage));
            }
            log?.info?.(`[handleAgentReply] Group reply published to wegirl:replies from ${target}, flowType=${reverseFlowType(flowType)}, timeoutSeconds=${timeoutSeconds}`);
            return;
        }
        catch (err) {
            log?.error?.(`[handleAgentReply] Group reply failed:`, err.message);
        }
        return;
    }
    // ========== 4. 单 agent 回复 ==========
    // 只有 channel="wegirl" 或 originatingChannel="wegirl" 时才通过 outbound 发送
    const effectiveChannel = originalMetadata?.originatingChannel || channel;
    if (effectiveChannel !== 'wegirl') {
        log?.debug?.(`[handleAgentReply] effectiveChannel=${effectiveChannel} !== 'wegirl', skip outbound delivery (Gateway will handle)`);
        return;
    }
    log?.info?.(`[handleAgentReply] channel='wegirl', sending reply via outbound: ${text.substring(0, 50)}...`);
    try {
        const pub = await getRedisPublisher(cfg);
        if (!pub) {
            log?.error?.(`[handleAgentReply] Redis publisher not connected`);
            return;
        }
        // 如果有媒体，先发送媒体
        if (mediaUrls.length > 0) {
            for (const mediaUrl of mediaUrls) {
                const mediaMessage = buildMessage({
                    flowType: reverseFlowType(flowType),
                    source: target,
                    target: source,
                    message: '',
                    chatType,
                    routingId,
                    msgType: 'media',
                    fromType: 'inner',
                    metadata: {
                        inReplyTo: messageId,
                        status: 'completed',
                        isFinal: false,
                        duration: Date.now() - createdAt,
                        mediaUrl,
                        mediaType: inferMediaType(mediaUrl),
                    }
                });
                await pub.publish('wegirl:replies', JSON.stringify(mediaMessage));
            }
        }
        // 发送文本回复
        if (text.trim()) {
            const replyMessage = buildMessage({
                flowType: reverseFlowType(flowType),
                source: target,
                target: source,
                message: text,
                chatType,
                routingId,
                msgType: 'message',
                fromType: 'inner',
                metadata: {
                    inReplyTo: messageId,
                    status: 'completed',
                    isFinal: true,
                    duration: Date.now() - createdAt,
                }
            });
            console.log(`[handleAgentReply]`, JSON.stringify(replyMessage, null, 2));
            await pub.publish('wegirl:replies', JSON.stringify(replyMessage));
        }
        log?.info?.(`[handleAgentReply] Reply published to wegirl:replies, flowType=${reverseFlowType(flowType)}, timeoutSeconds=${timeoutSeconds}`);
    }
    catch (err) {
        // 发送失败，发布错误回复
        try {
            const pub = await getRedisPublisher(cfg);
            if (pub) {
                const errorReply = buildMessage({
                    flowType: 'A2H',
                    source: target,
                    target: chatId,
                    message: `发送失败: ${err.message}`,
                    chatType,
                    routingId,
                    msgType: 'error',
                    fromType: 'inner',
                    metadata: {
                        inReplyTo: messageId,
                        status: 'failed',
                        isFinal: true,
                        duration: Date.now() - createdAt,
                        error: err.message,
                        errorCode: 'REPLY_PUBLISH_FAILED',
                    }
                });
                await pub.publish('wegirl:replies', JSON.stringify(errorReply));
            }
        }
        catch { }
        log?.error?.(`[handleAgentReply] Failed to publish reply: ${err.message}`);
    }
}
/**
 * 发送消息到 Agent (使用队列机制避免 session 锁冲突)
 */
export async function wegirlSessionsSend(options) {
    return enqueueMessage(options);
}
/**
 * 实际处理消息的函数 (原 wegirlSessionsSend 逻辑)
 */
async function processMessage(options) {
    const { message, cfg, channel, target, source, groupId, chatType, log, taskId, stepTotalAgents, stepId, routingId: originalRoutingId, msgType, metadata: originalMetadata, replyTo } = options;
    const chatId = groupId || target;
    const agentCount = stepTotalAgents;
    const routingId = originalRoutingId || `routing_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;
    const messageId = originalMetadata?.messageId || `wegirl-${Date.now()}`;
    const createdAt = Date.now();
    log?.info?.(`[WeGirl SessionsSend] Called: channel=${channel}, source=${source}, target=${target}, chatId=${chatId}, chatType=${chatType}${taskId ? `, taskId=${taskId}` : ''}${originalRoutingId ? `, originalRoutingId=${originalRoutingId}` : ''}`);
    // ========== 1. 获取 PluginRuntime ==========
    const runtime = getWeGirlRuntime();
    if (!runtime?.channel?.routing || !runtime?.channel?.reply) {
        log?.error?.('[WeGirl SessionsSend] Runtime not available');
        return;
    }
    // 检查 dispatchReplyWithBufferedBlockDispatcher 是否可用
    if (typeof runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher !== 'function') {
        log?.error?.('[WeGirl SessionsSend] dispatchReplyWithBufferedBlockDispatcher not available');
        return;
    }
    // ========== 2. resolveAgentRoute ==========
    const route = runtime.channel.routing.resolveAgentRoute({
        cfg,
        channel,
        accountId: target,
    });
    if (!route?.agentId) {
        log?.error?.(`[WeGirl SessionsSend] Failed to resolve agent route: channel=${channel}, target=${target}`);
        return;
    }
    const sessionKey = route.sessionKey;
    const agentId = route.agentId;
    const logPrefix = `[WeGirl SessionsSend ${sessionKey}]`;
    log?.info?.(`${logPrefix} Route resolved: agentId=${agentId}, sessionKey=${sessionKey}, matchedBy=${route.matchedBy}`);
    // ========== 3. 确定 flowType 并发送 Redis 消息 ==========
    let flowType = 'H2A';
    try {
        const redis = await getRedisPublisher(cfg);
        flowType = await determineFlowType(redis, source, target, log);
        log?.info?.(`${logPrefix} Flow type determined: ${flowType}`);
        // 发送 Redis 消息（使用标准 V2 格式）
        const forwardMsg = buildMessage({
            flowType,
            source,
            target,
            message,
            chatType,
            groupId: chatType === 'group' ? chatId : undefined,
            routingId,
            fromType: options.fromType || 'inner',
            metadata: {
                ...originalMetadata,
                matchedBy: route.matchedBy,
                originalChannel: channel,
                status: 'pending',
                createdAt,
                expiresAt: createdAt + 3600000,
            }
        });
        await redis.publish('wegirl:forward', JSON.stringify(forwardMsg));
        log?.info?.(`${logPrefix} Message forwarded via Redis: agentId=${agentId}, routingId=${routingId}`);
    }
    catch (err) {
        log?.error?.(`${logPrefix} Redis forward failed:`, err.message);
    }
    // ========== 4. finalizeInboundContext ==========
    const body = runtime.channel.reply.formatAgentEnvelope({
        channel: channel,
        from: source,
        timestamp: new Date(),
        body: message,
    });
    // 构建包含 routingId 的消息
    let messageWithRouting = `[ROUTING_ID:${routingId}]\n${message}`;
    // 添加媒体文件信息到消息中
    const mediaFiles = originalMetadata?.mediaFiles;
    if (mediaFiles && Array.isArray(mediaFiles) && mediaFiles.length > 0) {
        messageWithRouting += '\n\n[媒体文件]:';
        for (const media of mediaFiles) {
            if (media.path) {
                messageWithRouting += `\n- ${media.contentType || 'file'}: ${media.path}`;
            }
        }
    }
    // 构建媒体 payload
    let mediaPayload = {};
    if (mediaFiles && Array.isArray(mediaFiles) && mediaFiles.length > 0) {
        if (mediaFiles.length === 1) {
            mediaPayload = {
                MediaPath: mediaFiles[0].path,
                MediaType: mediaFiles[0].contentType || 'application/octet-stream',
            };
        }
        else {
            mediaPayload = {
                MediaPaths: mediaFiles.map(m => m.path),
                MediaTypes: mediaFiles.map(m => m.contentType || 'application/octet-stream'),
            };
        }
    }
    const inboundCtx = runtime.channel.reply.finalizeInboundContext({
        Body: body,
        BodyForAgent: messageWithRouting,
        RawBody: message,
        CommandBody: message,
        From: source,
        To: target,
        SessionKey: sessionKey,
        AccountId: target,
        Provider: 'wegirl',
        Surface: 'wegirl',
        ChatType: chatType,
        GroupSubject: chatType === 'group' ? chatId : undefined,
        SenderId: source,
        SenderName: source,
        MessageSid: messageId,
        Timestamp: Date.now(),
        WasMentioned: true,
        CommandAuthorized: true,
        OriginatingChannel: channel,
        OriginatingTo: (Array.isArray(replyTo) ? replyTo[0] : replyTo) || originalMetadata?.originatingTo || source,
        Model: 'kimi-coding/k2p5',
        ...mediaPayload,
    });
    log?.info?.(`${logPrefix} Dispatching to agent (session=${sessionKey}, replyTo=${channel}:${target})`);
    // ========== 5. createReplyPrefixOptions ==========
    const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
        cfg,
        agentId,
        channel: 'wegirl',
        accountId: target,
    });
    // ========== 6. dispatchReplyWithBufferedBlockDispatcher ==========
    try {
        await runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
            ctx: inboundCtx,
            cfg,
            dispatcherOptions: {
                ...prefixOptions,
                deliver: async (payload) => {
                    // 调用统一的回复处理逻辑
                    await handleAgentReply({
                        payload,
                        flowType,
                        source,
                        target,
                        chatType,
                        groupId,
                        chatId,
                        routingId,
                        originalRoutingId,
                        messageId,
                        createdAt,
                        originalMetadata,
                        cfg,
                        channel,
                        taskId,
                        stepId,
                        agentCount,
                        log,
                    });
                },
                onError: (error, info) => {
                    const errorDetail = error instanceof Error
                        ? `${error.message}\n${error.stack}`
                        : JSON.stringify(error);
                    log?.error?.(`${logPrefix} deliver error [kind=${info?.kind}]: ${errorDetail}`);
                },
            },
            replyOptions: {
                onModelSelected,
            },
        });
        log?.info?.(`${logPrefix} Dispatch complete`);
    }
    catch (err) {
        log?.error?.(`${logPrefix} Dispatch failed: ${err.message}`);
        throw err;
    }
}
//# sourceMappingURL=sessions-send.js.map