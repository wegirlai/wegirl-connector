// src/core/sessions-send.ts - 发送消息到 Agent (V1 核心层)
import Redis from 'ioredis';
import { getWeGirlRuntime } from "../runtime.js";
// Redis 连接缓存
let redisClient = null;
let redisConnectPromise = null;
async function getRedisPublisher(cfg) {
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
 * 发送消息到 Agent
 *
 * 流程:
 * 1. 获取 PluginRuntime
 * 2. 使用 resolveAgentRoute 查找 agent
 * 3. 构建 inbound context（设置 OriginatingChannel 用于回复路由）
 * 4. 调用 dispatchReplyFromConfig 发送消息给 Agent
 * 5. Gateway 自动处理 Agent 回复的路由
 */
export async function wegirlSessionsSend(options) {
    const { message, cfg: originalCfg, channel, target, source, groupId, chatType, log, taskId, stepTotalAgents, stepId, routingId: originalRoutingId, msgType, payload, metadata: originalMetadata } = options;
    // 内部变量映射（保持与旧代码兼容）
    const accountId = target;
    const from = source;
    const chatId = groupId || target;
    const agentCount = stepTotalAgents;
    const currentAgentId = stepId;
    const routingId = originalRoutingId;
    const messageId = originalMetadata?.messageId;
    const originalMessageId = messageId;
    // 添加模型配置到 cfg
    const cfg = {
        ...originalCfg,
        models: {
            mode: 'merge',
            provider: 'kimi-coding',
            modelId: 'k2p5',
        },
    };
    log?.info?.(`[WeGirl SessionsSend] Called: channel=${channel}, accountId=${accountId}, chatId=${chatId}, chatType=${chatType}${taskId ? `, taskId=${taskId}` : ''}${originalRoutingId ? `, originalRoutingId=${originalRoutingId}` : ''}`);
    // 获取 PluginRuntime
    const runtime = getWeGirlRuntime();
    if (!runtime) {
        log?.error?.('[WeGirl SessionsSend] No runtime available');
        return;
    }
    // 检查 runtime 结构完整性
    if (!runtime.channel) {
        log?.error?.('[WeGirl SessionsSend] Runtime has no channel');
        return;
    }
    if (!runtime.channel.routing) {
        log?.error?.('[WeGirl SessionsSend] Runtime has no channel.routing');
        return;
    }
    if (!runtime.channel.reply) {
        log?.error?.('[WeGirl SessionsSend] Runtime has no channel.reply');
        return;
    }
    if (typeof runtime.channel.reply.dispatchReplyFromConfig !== 'function') {
        log?.error?.('[WeGirl SessionsSend] Runtime has no dispatchReplyFromConfig method');
        return;
    }
    log?.debug?.('[WeGirl SessionsSend] Runtime check passed');
    try {
        // 1. 使用 resolveAgentRoute 查找 agent
        // 关键：如果 chatId 为空，则不传入 peer 参数，避免影响路由判断
        const resolveParams = {
            cfg,
            channel,
            accountId,
        };
        if (chatId) {
            resolveParams.peer = {
                kind: chatType,
                id: chatId,
            };
        }
        const route = runtime.channel.routing.resolveAgentRoute(resolveParams);
        // 检查 route 是否为空
        if (!route || !route.agentId) {
            log?.error?.(`[WeGirl SessionsSend] Failed to resolve agent route: channel=${channel}, accountId=${accountId}, chatId=${chatId}`);
            return;
        }
        const sessionKey = route.sessionKey;
        const agentId = route.agentId;
        log?.info?.(`[WeGirl SessionsSend] Route resolved: agentId=${agentId}, sessionKey=${sessionKey}, matchedBy=${route.matchedBy}`);
        // 使用原始消息的 routingId 和 messageId（如果提供），否则生成新的
        const routingId = originalRoutingId || `routing_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;
        const messageId = originalMessageId || `wegirl-${Date.now()}`;
        const createdAt = Date.now();
        // 2. 发送 Redis 消息（包含 sessionKey 和 agentId，用于监控）
        try {
            const redis = await getRedisPublisher(cfg);
            const forwardMsg = {
                type: 'forward',
                routingId,
                messageId,
                message,
                channel,
                accountId,
                from,
                chatId,
                chatType,
                agentId,
                sessionKey,
                status: 'pending',
                source: 'wegirl-connector',
                priority: 'normal',
                createdAt,
                expiresAt: createdAt + 3600000, // 1小时后过期
                metadata: {
                    ...originalMetadata, // 保留原始 metadata（包含 feishuOpenId 等）
                    matchedBy: route.matchedBy,
                    originalChannel: channel,
                },
                workflowId: undefined, // 预留：用于工作流编排
                error: undefined, // 预留：处理失败时填充
                timestamp: Date.now()
            };
            await redis.publish('wegirl:forward', JSON.stringify(forwardMsg));
            log?.info?.(`[WeGirl SessionsSend forward] Message forwarded via Redis: agentId=${agentId}, sessionKey=${sessionKey}, routingId=${routingId}`);
        }
        catch (err) {
            log?.error?.('[WeGirl SessionsSend forward] Redis forward failed:', err.message);
        }
        // 3. 构建 envelope
        const body = runtime.channel.reply.formatAgentEnvelope({
            channel: '微妞AI',
            from: from,
            timestamp: new Date(),
            body: message,
        });
        // 构建 inbound context
        // Provider/Surface: wegirl（当前渠道）
        // OriginatingChannel/OriginatingTo: 目标渠道，Gateway 会自动路由回复到该渠道
        // 使用 metadata 中的 originatingChannel/originatingTo 设置回复路由
        const inboundCtx = runtime.channel.reply.finalizeInboundContext({
            Body: body,
            BodyForAgent: message,
            RawBody: message,
            CommandBody: message,
            From: from,
            To: chatId,
            SessionKey: sessionKey,
            AccountId: accountId,
            Provider: 'wegirl',
            Surface: 'wegirl',
            ChatType: chatType,
            GroupSubject: chatType === 'group' ? chatId : undefined,
            SenderId: from,
            SenderName: from,
            MessageSid: messageId,
            Timestamp: Date.now(),
            WasMentioned: true,
            CommandAuthorized: true,
            // 关键：设置 OriginatingChannel 和 OriginatingTo，让回复能路由回发送者
            OriginatingChannel: originalMetadata?.originatingChannel || channel,
            OriginatingTo: originalMetadata?.originatingTo || from,
            // 强制指定模型，避免使用默认的 anthropic
            Model: 'kimi-coding/k2p5',
        });
        log?.info?.(`[WeGirl SessionsSend] dispatching to agent (session=${sessionKey}, replyTo=${channel}:${accountId})`);
        // 创建 dispatcher，处理 Agent 回复
        // 当 channel="wegirl" 时，通过 outbound 发送；其他情况交由 Gateway 自动路由
        const { dispatcher, replyOptions: baseReplyOptions, markDispatchIdle } = runtime.channel.reply.createReplyDispatcherWithTyping({
            deliver: async (payload, info) => {
                const text = payload.text ?? '';
                log?.debug?.(`[WeGirl SessionsSend] agent reply: kind=${info?.kind}, channel=${channel}, text=${text.substring(0, 50)}`);
                // 只处理最终回复
                if (info?.kind !== 'final' || !text.trim()) {
                    return;
                }
                // ========== 群聊多 agent 处理 ==========
                // 每个 agent 完成时立即回复（不等待聚合）
                if (chatType === 'group' && taskId && agentCount && agentCount > 1) {
                    const effectiveAgentId = currentAgentId || agentId;
                    log?.info?.(`[WeGirl SessionsSend] Group multi-agent reply: taskId=${taskId}, agent=${effectiveAgentId}`);
                    try {
                        const pub = await getRedisPublisher(cfg);
                        if (!pub) {
                            log?.error?.(`[WeGirl SessionsSend] Redis publisher not connected`);
                            return;
                        }
                        // 分析回复内容确定状态
                        let replyStatus;
                        if (text.startsWith('NO_REPLY') || text.trim() === '') {
                            replyStatus = 'no_reply'; // Agent 选择不回复
                        }
                        else if (text.startsWith('ERROR:') || text.includes('失败') || text.includes('错误')) {
                            replyStatus = 'error'; // 明确错误
                        }
                        else if (text.includes('超时') || text.includes('timeout')) {
                            replyStatus = 'timeout'; // 超时
                        }
                        else {
                            replyStatus = 'completed'; // 正常完成
                        }
                        // 直接发送当前 agent 的回复（不聚合）
                        const replyId = `wegirl-reply-${Date.now()}`;
                        const replyMessage = {
                            id: replyId,
                            type: 'message',
                            routingId: routingId,
                            inReplyTo: messageId,
                            content: text,
                            to: chatId,
                            from: 'agent',
                            agentId: accountId, // 发送者
                            sessionId: sessionKey,
                            accountId: accountId, // 发送者
                            status: replyStatus,
                            isFinal: true,
                            replyType: 'text',
                            processedAt: Date.now(),
                            duration: Date.now() - createdAt,
                            taskId: taskId,
                            workflowId: undefined,
                            error: replyStatus === 'error' || replyStatus === 'timeout' ? text : undefined,
                            timestamp: Date.now(),
                        };
                        await pub.publish('wegirl:replies', JSON.stringify(replyMessage));
                        log?.info?.(`[WeGirl SessionsSend] Group reply published to wegirl:replies from ${accountId}`);
                        return; // 群聊多 agent 模式已处理，不执行后续单 agent 逻辑
                    }
                    catch (err) {
                        log?.error?.(`[WeGirl SessionsSend] Group reply failed:`, err.message);
                    }
                    return;
                }
                // ========== 单 agent 回复（原有逻辑）==========
                // 只有 channel="wegirl" 或 originatingChannel="wegirl" 时才通过 outbound 发送
                // 其他 channel（如 feishu）由 Gateway 自动路由，不处理
                const effectiveChannel = originalMetadata?.originatingChannel || channel;
                if (effectiveChannel !== 'wegirl') {
                    log?.debug?.(`[WeGirl SessionsSend] effectiveChannel=${effectiveChannel} !== 'wegirl', skip outbound delivery (Gateway will handle)`);
                    return;
                }
                log?.info?.(`[WeGirl SessionsSend replies] channel='wegirl', sending reply via outbound: ${text.substring(0, 50)}...`);
                try {
                    const pub = await getRedisPublisher(cfg);
                    if (!pub) {
                        log?.error?.(`[WeGirl SessionsSend replies] Redis publisher not connected`);
                        return;
                    }
                    const replyId = `wegirl-reply-${Date.now()}`;
                    const replyMessage = {
                        id: replyId,
                        type: 'message',
                        routingId: routingId, // 关联请求
                        inReplyTo: messageId, // 回复哪条消息
                        content: text,
                        to: chatId,
                        from: 'agent',
                        agentId: accountId, // 发送者（scout）
                        sessionId: sessionKey,
                        accountId: accountId, // 发送者（scout）
                        status: 'completed',
                        isFinal: true,
                        replyType: 'text',
                        processedAt: Date.now(),
                        duration: Date.now() - createdAt,
                        workflowId: undefined, // 预留：工作流编排
                        error: undefined, // 预留：错误信息
                        timestamp: Date.now(),
                    };
                    //log?.info?.(`[WeGirl SessionsSend] replyMessage params:`, JSON.stringify(replyMessage, null, 2));
                    // 使用 console.log 输出到 stderr（Gateway 日志会捕获）
                    console.log('[WeGirl SessionsSend replies]', JSON.stringify(replyMessage, null, 2));
                    // 写入文件以便查看真实数据
                    try {
                        const fs = require('fs');
                        const path = require('path');
                        const logPath = path.join(process.env.HOME || '/root', '.openclaw', 'wegirl-reply-debug.json');
                        fs.writeFileSync(logPath, JSON.stringify(replyMessage, null, 2));
                        log?.info?.(`[WeGirl SessionsSend replies] replyMessage written to ${logPath}`);
                    }
                    catch (e) {
                        log?.error?.(`[WeGirl SessionsSend replies] Failed to write replyMessage:`, e.message);
                    }
                    await pub.publish('wegirl:replies', JSON.stringify(replyMessage));
                    log?.info?.(`[WeGirl SessionsSend replies] Reply published to wegirl:replies`);
                }
                catch (err) {
                    // 发送失败，发布错误回复
                    try {
                        const pub = await getRedisPublisher(cfg);
                        if (pub) {
                            const errorReply = {
                                id: `wegirl-reply-error-${Date.now()}`,
                                type: 'message',
                                routingId: routingId,
                                inReplyTo: messageId,
                                content: '',
                                to: chatId,
                                from: 'agent',
                                agentId: accountId, // 使用 accountId（如 scout-notifier）而非 agentId（如 scout）
                                sessionId: sessionKey,
                                accountId: accountId,
                                status: 'failed',
                                isFinal: true,
                                replyType: 'error',
                                processedAt: Date.now(),
                                duration: Date.now() - createdAt,
                                workflowId: undefined, // 预留：工作流编排
                                error: err.message,
                                errorCode: 'REPLY_PUBLISH_FAILED',
                                timestamp: Date.now(),
                            };
                            await pub.publish('wegirl:replies', JSON.stringify(errorReply));
                        }
                    }
                    catch { }
                    log?.error?.(`[WeGirl SessionsSend replies] Failed to publish reply: ${err.message}`);
                }
            },
            onError: (error, info) => {
                log?.error?.(`[WeGirl SessionsSend] deliver error: ${error}`);
            },
        });
        // 合并 replyOptions，添加模型设置
        const replyOptions = {
            ...baseReplyOptions,
            Model: 'kimi-coding/k2p5',
        };
        // 调用 dispatchReplyFromConfig 发送消息给 Agent
        const result = await runtime.channel.reply.dispatchReplyFromConfig({
            ctx: inboundCtx,
            cfg,
            dispatcher,
            replyOptions,
        });
        markDispatchIdle();
        log?.info?.(`[WeGirl SessionsSend] dispatch complete (queuedFinal=${result.queuedFinal}, replies=${result.counts?.final ?? 0})`);
    }
    catch (err) {
        log?.error?.(`[WeGirl SessionsSend] Failed: ${err.message}`);
        throw err;
    }
}
/**
 * 聚合群聊多 agent 结果
 * @param results - 各 agent 的结果 {agentId: result}
 * @param taskId - 任务标识
 * @returns 聚合后的消息
 */
function aggregateGroupResults(results, taskId) {
    const agentIds = Object.keys(results);
    if (agentIds.length === 1) {
        return results[agentIds[0]];
    }
    // 多 agent 结果聚合
    const sections = [];
    sections.push(`【多 Agent 协作结果】任务: ${taskId}`);
    sections.push('');
    for (const [agentId, result] of Object.entries(results)) {
        sections.push(`【${agentId}】`);
        sections.push(result);
        sections.push('');
    }
    return sections.join('\n');
}
//# sourceMappingURL=sessions-send.js.map