interface InstallResult {
    skillId: string;
    action: 'installed' | 'updated' | 'removed' | 'skipped' | 'failed';
    filesAdded: string[];
    filesRemoved: string[];
    filesUpdated: string[];
    error?: string;
}
interface SkillSyncResult {
    success: boolean;
    agentId: string;
    skillsDir: string;
    installed: number;
    updated: number;
    removed: number;
    failed: number;
    details: InstallResult[];
    error?: string;
}
/**
 * 主入口：同步技能
 */
export declare function installSkills(agentId: string, options?: {
    forceUpdate?: boolean;
    logger?: any;
}): Promise<SkillSyncResult>;
/**
 * 格式化同步结果为易读的文本
 */
export declare function formatSyncResult(result: SkillSyncResult): string;
export {};
//# sourceMappingURL=skill-install.d.ts.map