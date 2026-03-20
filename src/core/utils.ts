// src/core/utils.ts - 工具函数

import type { 
  FlowType, 
  ChatType, 
  StaffId, 
  WeGirlSendOptions, 
  SessionContext 
} from './types.js';

/**
 * 生成唯一ID
 */
export function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).substring(2, 10)}`;
}

/**
 * 验证选项
 */
export function validateOptions(options: WeGirlSendOptions): void {
  // 1. 必填字段
  if (!options.flowType) {
    throw new Error('flowType is required');
  }
  if (!options.source) {
    throw new Error('source is required');
  }
  if (!options.target) {
    throw new Error('target is required');
  }
  if (!options.message) {
    throw new Error('message is required');
  }
  
  // 2. 验证 flowType
  const validFlowTypes: FlowType[] = ['H2A', 'A2A', 'A2H'];
  if (!validFlowTypes.includes(options.flowType)) {
    throw new Error(`Invalid flowType: ${options.flowType}`);
  }
  
  // 3. 群聊必须有 groupId
  if (options.chatType === 'group' && !options.groupId) {
    throw new Error('groupId is required when chatType=group');
  }
  
  // 4. 单聊不允许自说自话
  if (options.chatType !== 'group' && options.source === options.target) {
    throw new Error('direct chat does not allow self-talk (source !== target)');
  }
  
  // 5. 有 stepId 必须有 taskId
  if (options.stepId && !options.taskId) {
    throw new Error('taskId is required when stepId is provided');
  }
  
  // 6. 有 stepTotalAgents 必须有 stepId
  if (options.stepTotalAgents !== undefined && !options.stepId) {
    throw new Error('stepId is required when stepTotalAgents is provided');
  }
  
  // 7. 验证 replyTo
  if (options.replyTo !== undefined) {
    const isValid = typeof options.replyTo === 'string' || 
      (Array.isArray(options.replyTo) && options.replyTo.every(r => typeof r === 'string'));
    if (!isValid) {
      throw new Error('replyTo must be string or string[]');
    }
  }
}

/**
 * 获取默认 replyTo
 */
export function getDefaultReplyTo(
  flowType: FlowType,
  chatType: ChatType,
  source: StaffId,
  target: StaffId
): StaffId[] {
  // 群聊：默认回复到群里（target）
  // 单聊：默认回复给 source
  const defaultTarget = chatType === 'group' ? target : source;
  return [defaultTarget];
}

/**
 * 解析 replyTo
 */
export function resolveReplyTo(
  replyTo: StaffId | StaffId[] | undefined,
  flowType: FlowType,
  chatType: ChatType,
  source: StaffId,
  target: StaffId
): StaffId[] {
  // 如果未指定，使用默认值
  if (replyTo === undefined) {
    return getDefaultReplyTo(flowType, chatType, source, target);
  }
  
  // 统一转为数组
  return Array.isArray(replyTo) ? replyTo : [replyTo];
}

/**
 * 创建 Session 上下文
 */
export function createSessionContext(
  options: WeGirlSendOptions,
  routingId: string
): SessionContext {
  const chatType = options.chatType || 'direct';
  const replyTo = resolveReplyTo(
    options.replyTo,
    options.flowType,
    chatType,
    options.source,
    options.target
  );
  
  return {
    flowType: options.flowType,
    source: options.source,
    target: options.target,
    chatType,
    groupId: options.groupId,
    replyTo,
    taskId: options.taskId,
    stepId: options.stepId,
    stepTotalAgents: options.stepTotalAgents,
    routingId,
  };
}

/**
 * 创建 Session Key
 */
export function createSessionKey(
  target: StaffId,
  chatType: ChatType,
  groupId?: string
): string {
  if (chatType === 'group' && groupId) {
    // 群聊：使用 groupId 创建稳定 session
    return `agent:${target}:wegirl:group:${groupId}`;
  }
  // 单聊：使用随机 ID 创建临时 session
  return `agent:${target}:wegirl:p2p:${generateId()}`;
}

/**
 * 根据 flowType 推断 source/target 类型
 */
export function inferEntityType(
  flowType: FlowType,
  role: 'source' | 'target'
): 'agent' | 'human' {
  switch (flowType) {
    case 'H2A':
      // H2A: source=human, target=agent
      return role === 'source' ? 'human' : 'agent';
    case 'A2A':
      // A2A: source=agent, target=agent
      return 'agent';
    case 'A2H':
      // A2H: source=agent, target=human
      return role === 'source' ? 'agent' : 'human';
    default:
      throw new Error(`Unknown flowType: ${flowType}`);
  }
}

/**
 * 检查是否为 NO_REPLY
 */
export function isNoReply(replyTo: StaffId[]): boolean {
  return replyTo.length === 1 && replyTo[0] === 'system:no_reply';
}
