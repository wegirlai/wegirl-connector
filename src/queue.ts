// src/queue.ts - 增强版待办队列管理（支持唯一ID和状态管理）

import type Redis from 'ioredis';
import { randomUUID } from 'crypto';

const KEY_PREFIX = 'wegirl:';

// 任务状态
export type TaskStatus = 'pending' | 'approved' | 'rejected' | 'completed' | 'cancelled';

// 任务数据结构
export interface Task {
  taskId: string;
  userId: string;
  status: TaskStatus;
  type: 'url_review' | 'content_review' | 'approval_required' | 'notification';
  title: string;
  description: string;
  metadata: Record<string, any>;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  decision?: 'approve' | 'reject' | 'custom';
  decisionBy?: string;
  decisionMessage?: string;
  priority: number;
  retryCount: number;
}

export class PendingQueue {
  private redis: Redis;
  private logger: any;

  constructor(redis: Redis, logger?: any) {
    this.redis = redis;
    this.logger = logger || console;
  }

  private key(...parts: string[]): string {
    return `${KEY_PREFIX}${parts.join(':')}`;
  }

  // ========== 核心任务操作 ==========

  async createTask(
    userId: string,
    type: Task['type'],
    title: string,
    description: string,
    metadata: Record<string, any> = {},
    priority: 'urgent' | 'high' | 'normal' | 'low' = 'normal'
  ): Promise<Task> {
    const taskId = `task_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const now = Date.now();
    
    const task: Task = {
      taskId,
      userId,
      status: 'pending',
      type,
      title,
      description,
      metadata,
      createdAt: now,
      updatedAt: now,
      priority: this.priorityToNumber(priority),
      retryCount: 0
    };

    const pipeline = this.redis.pipeline();
    
    // 存储任务详情
    pipeline.hset(this.key('task', taskId), this.taskToRedis(task));
    
    // 添加到用户任务索引
    const score = this.calculateScore(task.status, task.priority, now);
    pipeline.zadd(this.key('tasks', userId, 'by_status'), score, `${task.status}:${taskId}`);
    
    // 添加到全局待办索引
    pipeline.zadd(this.key('tasks', 'all', 'pending'), now, taskId);
    
    // 设置过期时间
    pipeline.expire(this.key('task', taskId), 30 * 24 * 3600);
    
    await pipeline.exec();
    
    this.logger.info(`[Queue] Task created: ${taskId} for user ${userId}, type: ${type}`);
    
    return task;
  }

  async getTask(taskId: string): Promise<Task | null> {
    const data = await this.redis.hgetall(this.key('task', taskId));
    if (!data || Object.keys(data).length === 0) {
      return null;
    }
    return this.redisToTask(data);
  }

  async updateTaskStatus(
    taskId: string,
    newStatus: TaskStatus,
    extra?: {
      decision?: 'approve' | 'reject' | 'custom';
      decisionBy?: string;
      decisionMessage?: string;
    }
  ): Promise<Task | null> {
    const task = await this.getTask(taskId);
    if (!task) return null;

    const oldStatus = task.status;
    const now = Date.now();

    // 更新任务数据
    const updates: any = {
      status: newStatus,
      updatedAt: now.toString()
    };

    if (extra?.decision) updates.decision = extra.decision;
    if (extra?.decisionBy) updates.decisionBy = extra.decisionBy;
    if (extra?.decisionMessage) updates.decisionMessage = extra.decisionMessage;
    if (newStatus === 'completed' || newStatus === 'approved' || newStatus === 'rejected') {
      updates.completedAt = now.toString();
    }

    const pipeline = this.redis.pipeline();
    
    // 更新任务详情
    pipeline.hset(this.key('task', taskId), updates);
    
    // 如果状态改变，更新索引
    if (oldStatus !== newStatus) {
      // 从旧状态索引移除
      pipeline.zrem(this.key('tasks', task.userId, 'by_status'), `${oldStatus}:${taskId}`);
      
      // 添加到新状态索引
      const score = this.calculateScore(newStatus, task.priority, now);
      pipeline.zadd(this.key('tasks', task.userId, 'by_status'), score, `${newStatus}:${taskId}`);
      
      // 更新全局索引
      if (oldStatus === 'pending') {
        pipeline.zrem(this.key('tasks', 'all', 'pending'), taskId);
      }
      if (newStatus === 'pending') {
        pipeline.zadd(this.key('tasks', 'all', 'pending'), now, taskId);
      }
    }
    
    await pipeline.exec();
    
    this.logger.info(`[Queue] Task ${taskId} status: ${oldStatus} -> ${newStatus}`);
    
    return this.getTask(taskId);
  }

  async processDecision(
    taskId: string,
    decision: 'approve' | 'reject',
    decisionBy: string,
    message?: string
  ): Promise<Task | null> {
    return this.updateTaskStatus(
      taskId,
      decision === 'approve' ? 'approved' : 'rejected',
      { decision, decisionBy, decisionMessage: message }
    );
  }

  async deleteTask(taskId: string): Promise<boolean> {
    const task = await this.getTask(taskId);
    if (!task) return false;

    const pipeline = this.redis.pipeline();
    
    // 删除任务详情
    pipeline.del(this.key('task', taskId));
    
    // 从状态索引移除
    pipeline.zrem(this.key('tasks', task.userId, 'by_status'), `${task.status}:${taskId}`);
    
    // 从全局索引移除
    if (task.status === 'pending') {
      pipeline.zrem(this.key('tasks', 'all', 'pending'), taskId);
    }
    
    await pipeline.exec();
    
    this.logger.info(`[Queue] Task deleted: ${taskId}`);
    return true;
  }

  // ========== 查询方法 ==========

  async getUserTasks(
    userId: string,
    options: {
      status?: TaskStatus | TaskStatus[];
      limit?: number;
      offset?: number;
    } = {}
  ): Promise<{ tasks: Task[]; total: number }> {
    const { status, limit = 10, offset = 0 } = options;
    
    const key = this.key('tasks', userId, 'by_status');
    
    // 获取所有条目
    let entries: string[] = await this.redis.zrange(key, 0, -1);
    
    // 状态筛选
    if (status) {
      const statuses = Array.isArray(status) ? status : [status];
      if (statuses.length > 0) {
        entries = entries.filter(e => statuses.some(s => e.startsWith(`${s}:`)));
      }
    }
    
    const total = entries.length;
    
    // 分页
    const paginated = entries.slice(offset, offset + limit);
    
    // 并发获取任务详情
    const tasks = await Promise.all(
      paginated.map(async (entry) => {
        const taskId = entry.split(':').slice(1).join(':');
        return this.getTask(taskId);
      })
    );
    
    return { tasks: tasks.filter(Boolean) as Task[], total };
  }

  async getPendingCount(userId: string): Promise<number> {
    const key = this.key('tasks', userId, 'by_status');
    const entries = await this.redis.zrange(key, 0, -1);
    return entries.filter(e => e.startsWith('pending:')).length;
  }

  async getPendingTasks(userId: string, limit: number = 10): Promise<Task[]> {
    const { tasks } = await this.getUserTasks(userId, { status: 'pending', limit });
    return tasks;
  }

  // ========== 旧接口兼容 ==========

  async enqueue(userId: string, envelope: any): Promise<void> {
    await this.createTask(
      userId,
      'notification',
      envelope.payload?.content?.substring(0, 50) || 'New message',
      envelope.payload?.content || '',
      { legacy: true, envelope },
      'normal'
    );
  }

  async dequeue(userId: string, limit: number = 10): Promise<any[]> {
    const tasks = await this.getPendingTasks(userId, limit);
    for (const task of tasks) {
      await this.updateTaskStatus(task.taskId, 'completed');
    }
    return tasks.map(t => ({
      metadata: { msgId: t.taskId, priority: this.numberToPriority(t.priority) },
      payload: { content: t.description },
      queuedAt: t.createdAt
    }));
  }

  async peek(userId: string, limit: number = 10): Promise<any[]> {
    const tasks = await this.getPendingTasks(userId, limit);
    return tasks.map(t => ({
      metadata: { msgId: t.taskId, priority: this.numberToPriority(t.priority) },
      payload: { content: t.description },
      queuedAt: t.createdAt
    }));
  }

  // ========== 辅助方法 ==========

  private taskToRedis(task: Task): Record<string, string> {
    return {
      taskId: task.taskId,
      userId: task.userId,
      status: task.status,
      type: task.type,
      title: task.title,
      description: task.description,
      metadata: JSON.stringify(task.metadata),
      createdAt: task.createdAt.toString(),
      updatedAt: task.updatedAt.toString(),
      priority: task.priority.toString(),
      retryCount: task.retryCount.toString(),
      ...(task.completedAt && { completedAt: task.completedAt.toString() }),
      ...(task.decision && { decision: task.decision }),
      ...(task.decisionBy && { decisionBy: task.decisionBy }),
      ...(task.decisionMessage && { decisionMessage: task.decisionMessage })
    };
  }

  private redisToTask(data: Record<string, string>): Task {
    return {
      taskId: data.taskId,
      userId: data.userId,
      status: data.status as TaskStatus,
      type: data.type as Task['type'],
      title: data.title,
      description: data.description,
      metadata: JSON.parse(data.metadata || '{}'),
      createdAt: parseInt(data.createdAt),
      updatedAt: parseInt(data.updatedAt),
      priority: parseInt(data.priority),
      retryCount: parseInt(data.retryCount || '0'),
      ...(data.completedAt && { completedAt: parseInt(data.completedAt) }),
      ...(data.decision && { decision: data.decision as Task['decision'] }),
      ...(data.decisionBy && { decisionBy: data.decisionBy }),
      ...(data.decisionMessage && { decisionMessage: data.decisionMessage })
    };
  }

  private priorityToNumber(priority: string): number {
    const map: Record<string, number> = { low: 1, normal: 2, high: 3, urgent: 4 };
    return map[priority] || 2;
  }

  private numberToPriority(num: number): string {
    const map: Record<number, string> = { 1: 'low', 2: 'normal', 3: 'high', 4: 'urgent' };
    return map[num] || 'normal';
  }

  private calculateScore(status: TaskStatus, priority: number, timestamp: number): number {
    const statusWeight = { pending: 1000, approved: 100, rejected: 10, completed: 1, cancelled: 0 };
    const weight = statusWeight[status] || 0;
    return weight * 1000000 + priority * 100000 + timestamp;
  }
}
