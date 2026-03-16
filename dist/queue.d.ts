import type Redis from 'ioredis';
export type TaskStatus = 'pending' | 'approved' | 'rejected' | 'completed' | 'cancelled';
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
export declare class PendingQueue {
    private redis;
    private logger;
    constructor(redis: Redis, logger?: any);
    private key;
    createTask(userId: string, type: Task['type'], title: string, description: string, metadata?: Record<string, any>, priority?: 'urgent' | 'high' | 'normal' | 'low'): Promise<Task>;
    getTask(taskId: string): Promise<Task | null>;
    updateTaskStatus(taskId: string, newStatus: TaskStatus, extra?: {
        decision?: 'approve' | 'reject' | 'custom';
        decisionBy?: string;
        decisionMessage?: string;
    }): Promise<Task | null>;
    processDecision(taskId: string, decision: 'approve' | 'reject', decisionBy: string, message?: string): Promise<Task | null>;
    deleteTask(taskId: string): Promise<boolean>;
    getUserTasks(userId: string, options?: {
        status?: TaskStatus | TaskStatus[];
        limit?: number;
        offset?: number;
    }): Promise<{
        tasks: Task[];
        total: number;
    }>;
    getPendingCount(userId: string): Promise<number>;
    getPendingTasks(userId: string, limit?: number): Promise<Task[]>;
    enqueue(userId: string, envelope: any): Promise<void>;
    dequeue(userId: string, limit?: number): Promise<any[]>;
    peek(userId: string, limit?: number): Promise<any[]>;
    private taskToRedis;
    private redisToTask;
    private priorityToNumber;
    private numberToPriority;
    private calculateScore;
}
//# sourceMappingURL=queue.d.ts.map