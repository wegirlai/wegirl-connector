// src/protocol.ts - wegirl 消息协议定义

export const PROTOCOL_VERSION = '1.0';

// 地址类型
export type AddressType = 'agent' | 'human' | 'system' | 'broadcast';

// 消息类型
export type MessageType = 'request' | 'response' | 'event' | 'error' | 'heartbeat' | 'register';

// 路由模式
export type RoutingMode = 'agent' | 'capability' | 'workflow' | 'broadcast' | 'human';

// 能力匹配策略
export type CapabilityStrategy = 'first' | 'round-robin' | 'least-load' | 'random';

// 地址结构
export interface Address {
  type: AddressType;
  agentId?: string;
  instanceId?: string;
  sessionKey?: string;
  userId?: string;
}

// 元数据
export interface MessageMetadata {
  msgId: string;
  traceId?: string;
  timestamp: number;
  ttl?: number;
  priority?: 'low' | 'normal' | 'high' | 'urgent';
  version?: string;
  replyTo?: string;  // 回复哪条消息
}

// 路由目标
export interface RoutingTarget {
  mode: RoutingMode;
  // agent mode
  agentId?: string;
  // capability mode
  capability?: string;
  strategy?: CapabilityStrategy;
  // workflow mode
  workflowId?: string;
  step?: number;
  action?: 'next' | 'retry' | 'skip' | 'cancel';
  // human mode
  userId?: string;
  // broadcast mode
  filter?: {
    capabilities?: string[];
    instanceId?: string;
    departments?: string[];
  };
}

// 工作流上下文
export interface WorkflowContext {
  workflowId: string;
  step: number;
  totalSteps?: number;
  history?: WorkflowStep[];
  variables?: Record<string, unknown>;
}

export interface WorkflowStep {
  step: number;
  agentId: string;
  result: string;
  timestamp: number;
}

// 消息上下文
export interface MessageContext {
  workflow?: WorkflowContext;
  session?: Record<string, unknown>;
  custom?: Record<string, unknown>;
}

// 消息信封（所有消息的通用外壳）
export interface MessageEnvelope {
  metadata: MessageMetadata;
  from: Address;
  to: Address;
  type: MessageType;
  payload: MessagePayload;
  context?: MessageContext;
  routing?: RoutingTarget;
}

// 消息负载（根据 type 不同而不同）
export interface MessagePayload {
  // 通用字段
  content?: string;
  format?: 'text' | 'json' | 'markdown' | 'card';
  attachments?: Attachment[];
  
  // request/response 特有
  status?: 'pending' | 'approved' | 'rejected' | 'completed' | 'failed';
  metadata?: Record<string, unknown>;
  
  // error 特有
  code?: string;
  message?: string;
  retryable?: boolean;
  originalMsgId?: string;
  
  // event 特有
  eventType?: string;
  data?: unknown;
  
  // heartbeat 特有
  load?: number;
  activeSessions?: number;
  capabilities?: string[];
  
  // register 特有
  agentInfo?: AgentInfo;
  instanceInfo?: InstanceInfo;
}

export interface Attachment {
  type: string;
  name: string;
  url?: string;
  content?: string;
  mimeType?: string;
}

// Agent 信息
export interface AgentInfo {
  agentId: string;
  name: string;
  capabilities: string[];
  maxConcurrent: number;
  supportedModels?: string[];
  metadata?: Record<string, unknown>;
}

// 实例信息
export interface InstanceInfo {
  instanceId: string;
  version: string;
  region?: string;
  host?: string;
}

// 人类用户信息
export interface HumanInfo {
  type: 'human';
  userId: string;
  name: string;
  capabilities: string[];
  departments?: string[];
  availability: {
    status: 'online' | 'busy' | 'offline' | 'dnd';
    workHours?: string;
    timezone?: string;
  };
  load?: {
    pendingTasks: number;
    maxConcurrent: number;
  };
  skills?: Record<string, SkillInfo>;
}

export interface SkillInfo {
  level: 'junior' | 'senior' | 'expert';
  years?: number;
  authorized?: boolean;
}

// 待办队列项
export interface PendingItem {
  metadata: MessageMetadata;
  from: Address;
  originalTarget: string;
  payload: MessagePayload;
  queuedAt: number;
  retryCount: number;
  priority: number;
}

// wegirl_send 工具参数
export interface WeGirlSendParams {
  target: string;  // 支持多种格式：agent:xxx, capability:xxx, workflow:xxx, ou_xxx, source:xxx
  message: string;
  context?: {
    workflowId?: string;
    step?: number;
    timeout?: number;
    requirements?: Record<string, unknown>;
  };
  options?: {
    waitForReply?: boolean;
    priority?: 'low' | 'normal' | 'high' | 'urgent';
    ttl?: number;
  };
}

// 统一的 Staff 信息（替代 AgentInfo/HumanInfo）
export interface StaffInfo {
  staffId: string;
  type: 'agent' | 'human';
  name: string;
  capabilities?: string[];
  maxConcurrent?: number;
  instanceId?: string;
  metadata?: Record<string, unknown>;
  // 向后兼容
  agentId?: string;  // 对于 agent 类型，等于 staffId
  userId?: string;   // 对于 human 类型，等于 staffId
  // 人类特有字段
  departments?: string[];
  availability?: {
    status: 'online' | 'busy' | 'offline' | 'dnd';
    workHours?: string;
    timezone?: string;
  };
  skills?: Record<string, SkillInfo>;
}

// 注册信息（存储在 Redis）- 统一使用 staffId
export interface RegistryEntry {
  staffId: string;
  type: 'agent' | 'human';
  instanceId: string;
  name: string;
  capabilities: string[];
  maxConcurrent: number;
  status: 'online' | 'offline' | 'busy';
  lastHeartbeat: number;
  metadata?: Record<string, unknown>;
  load?: {
    activeTasks: number;
    pendingTasks: number;
  };
  // 向后兼容字段
  agentId?: string;  // 对于 agent 类型，staffId 和 agentId 相同
  userId?: string;   // 对于 human 类型，staffId 和 userId 相同
}
