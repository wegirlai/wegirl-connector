import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync, rmSync } from 'fs';
import { join, dirname } from 'path';
const DASHBOARD_BASE_URL = 'http://dashboard.weiniuai.com';
/**
 * 获取 agent 工作目录路径
 */
function getAgentWorkspace(agentId) {
    // 优先使用环境变量 OPENCLAW_HOME
    const openClawHome = process.env.OPENCLAW_HOME || '/root/.openclaw';
    return join(openClawHome, 'agents', agentId);
}
/**
 * 获取本地 skills 目录路径
 */
function getLocalSkillsDir(agentId) {
    return join(getAgentWorkspace(agentId), 'skills');
}
/**
 * 获取 dashboard 配置的基础 URL（支持覆盖）
 */
function getDashboardBaseUrl() {
    return process.env.DASHBOARD_API_URL || DASHBOARD_BASE_URL;
}
/**
 * 调用接口获取远程技能列表
 */
async function fetchRemoteSkills(agentId) {
    const baseUrl = getDashboardBaseUrl();
    const url = `${baseUrl}/api/server/agents/${agentId}/skills`;
    const res = await fetch(url, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
    });
    if (!res.ok) {
        throw new Error(`Failed to fetch skills list: ${res.status} ${res.statusText}`);
    }
    const data = await res.json();
    if (data.code !== 200 || !data.data?.skills) {
        throw new Error(`Invalid response: ${data.message || 'unknown error'}`);
    }
    return data.data.skills;
}
/**
 * 下载单个技能文件
 */
async function downloadSkillFile(skillId, filePath) {
    const baseUrl = getDashboardBaseUrl();
    const encodedPath = encodeURIComponent(filePath);
    const url = `${baseUrl}/api/server/skills/${skillId}/download?path=${encodedPath}`;
    const res = await fetch(url, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
    });
    if (!res.ok) {
        throw new Error(`Failed to download ${filePath}: ${res.status} ${res.statusText}`);
    }
    const data = await res.json();
    if (data.code !== 200 || !data.data?.content) {
        throw new Error(`Invalid download response for ${filePath}: ${data.message || 'unknown error'}`);
    }
    return {
        path: data.data.path || filePath,
        content: data.data.content,
        size: data.data.size || 0,
    };
}
/**
 * 获取本地 skill 的文件列表
 */
function getLocalSkillFiles(skillDir) {
    if (!existsSync(skillDir)) {
        return [];
    }
    const files = [];
    function walk(dir, prefix) {
        const entries = readdirSync(dir);
        for (const entry of entries) {
            const fullPath = join(dir, entry);
            const relativePath = prefix ? `${prefix}/${entry}` : entry;
            const stat = statSync(fullPath);
            if (stat.isDirectory()) {
                walk(fullPath, relativePath);
            }
            else {
                files.push(relativePath);
            }
        }
    }
    walk(skillDir, '');
    return files;
}
/**
 * 确保目录存在
 */
function ensureDir(dir) {
    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
    }
}
/**
 * 同步单个技能：远程 vs 本地
 */
async function syncSkill(skill, skillsDir, logger, forceUpdate) {
    const skillDir = join(skillsDir, skill.id);
    const remoteFiles = new Set(skill.files);
    const result = {
        skillId: skill.id,
        action: 'skipped',
        filesAdded: [],
        filesRemoved: [],
        filesUpdated: [],
    };
    try {
        // 获取本地文件列表
        const localFiles = getLocalSkillFiles(skillDir);
        const localFilesSet = new Set(localFiles);
        // 1. 本地有但远程没有 → 删除
        for (const localFile of localFiles) {
            if (!remoteFiles.has(localFile)) {
                const fullPath = join(skillDir, localFile);
                try {
                    rmSync(fullPath);
                    result.filesRemoved.push(localFile);
                    logger?.info?.(`[skill_install] Removed extra file: ${localFile} from ${skill.id}`);
                }
                catch (err) {
                    logger?.warn?.(`[skill_install] Failed to remove ${localFile}: ${err.message}`);
                }
            }
        }
        // 清理空目录
        cleanupEmptyDirs(skillDir);
        // 2. 远程有 → 下载或更新
        for (const remoteFile of skill.files) {
            const fullPath = join(skillDir, remoteFile);
            const existsLocally = localFilesSet.has(remoteFile);
            const needsDownload = !existsLocally || forceUpdate;
            if (!needsDownload) {
                // 文件存在且未开启强制更新，跳过
                continue;
            }
            try {
                const downloaded = await downloadSkillFile(skill.id, remoteFile);
                ensureDir(dirname(fullPath));
                writeFileSync(fullPath, downloaded.content, 'utf-8');
                if (existsLocally) {
                    result.filesUpdated.push(remoteFile);
                }
                else {
                    result.filesAdded.push(remoteFile);
                }
                logger?.info?.(`[skill_install] ${existsLocally ? 'Updated' : 'Downloaded'}: ${remoteFile} (${downloaded.size} bytes) for ${skill.id}`);
            }
            catch (err) {
                result.error = `Failed to download ${remoteFile}: ${err.message}`;
                logger?.error?.(`[skill_install] ${result.error}`);
                result.action = 'failed';
                return result;
            }
        }
        // 判断动作类型
        if (result.filesAdded.length > 0 || result.filesRemoved.length > 0) {
            if (localFiles.length === 0) {
                result.action = 'installed';
            }
            else {
                result.action = 'updated';
            }
        }
        else {
            result.action = 'skipped';
        }
        return result;
    }
    catch (err) {
        result.action = 'failed';
        result.error = err.message;
        logger?.error?.(`[skill_install] Failed to sync skill ${skill.id}: ${err.message}`);
        return result;
    }
}
/**
 * 清理空目录
 */
function cleanupEmptyDirs(dir) {
    if (!existsSync(dir))
        return;
    const entries = readdirSync(dir);
    for (const entry of entries) {
        const fullPath = join(dir, entry);
        const stat = statSync(fullPath);
        if (stat.isDirectory()) {
            cleanupEmptyDirs(fullPath);
            // 如果目录为空，删除
            try {
                const remaining = readdirSync(fullPath);
                if (remaining.length === 0) {
                    rmSync(fullPath, { recursive: true });
                }
            }
            catch {
                // ignore
            }
        }
    }
}
/**
 * 删除本地技能目录
 */
function removeLocalSkill(skillDir, skillId, logger) {
    const fullPath = join(skillDir, skillId);
    if (existsSync(fullPath)) {
        try {
            rmSync(fullPath, { recursive: true, force: true });
            logger?.info?.(`[skill_install] Removed skill directory: ${skillId}`);
            return true;
        }
        catch (err) {
            logger?.error?.(`[skill_install] Failed to remove skill ${skillId}: ${err.message}`);
            return false;
        }
    }
    return false;
}
/**
 * 主入口：同步技能
 */
export async function installSkills(agentId, options) {
    const logger = options?.logger;
    const skillsDir = getLocalSkillsDir(agentId);
    logger?.info?.(`[skill_install] Starting skill sync for agent: ${agentId}`);
    logger?.info?.(`[skill_install] Local skills dir: ${skillsDir}`);
    try {
        // 1. 获取远程技能列表
        const remoteSkills = await fetchRemoteSkills(agentId);
        logger?.info?.(`[skill_install] Remote skills: ${remoteSkills.map(s => s.id).join(', ')}`);
        // 2. 确保本地 skills 目录存在
        ensureDir(skillsDir);
        // 3. 获取本地已有的技能目录
        const localSkillIds = existsSync(skillsDir)
            ? readdirSync(skillsDir).filter(entry => {
                const fullPath = join(skillsDir, entry);
                return statSync(fullPath).isDirectory();
            })
            : [];
        const remoteSkillIds = new Set(remoteSkills.map(s => s.id));
        // 4. 处理本地有但远程没有的技能 → 删除
        const removedResults = [];
        for (const localSkillId of localSkillIds) {
            if (!remoteSkillIds.has(localSkillId)) {
                const removed = removeLocalSkill(skillsDir, localSkillId, logger);
                removedResults.push({
                    skillId: localSkillId,
                    action: 'removed',
                    filesAdded: [],
                    filesRemoved: [],
                    filesUpdated: [],
                });
            }
        }
        // 5. 逐个同步远程技能
        const syncResults = [];
        for (const skill of remoteSkills) {
            const result = await syncSkill(skill, skillsDir, logger, options?.forceUpdate);
            syncResults.push(result);
        }
        const allResults = [...removedResults, ...syncResults];
        const installed = allResults.filter(r => r.action === 'installed').length;
        const updated = allResults.filter(r => r.action === 'updated').length;
        const removed = allResults.filter(r => r.action === 'removed').length;
        const failed = allResults.filter(r => r.action === 'failed').length;
        logger?.info?.(`[skill_install] Sync complete: ${installed} installed, ${updated} updated, ${removed} removed, ${failed} failed`);
        return {
            success: failed === 0,
            agentId,
            skillsDir,
            installed,
            updated,
            removed,
            failed,
            details: allResults,
        };
    }
    catch (err) {
        logger?.error?.(`[skill_install] Sync failed: ${err.message}`);
        return {
            success: false,
            agentId,
            skillsDir,
            installed: 0,
            updated: 0,
            removed: 0,
            failed: 0,
            details: [],
            error: err.message,
        };
    }
}
/**
 * 格式化同步结果为易读的文本
 */
export function formatSyncResult(result) {
    if (!result.success && result.error) {
        return `❌ 技能同步失败: ${result.error}`;
    }
    const lines = ['📦 技能同步结果', ''];
    lines.push(`Agent: ${result.agentId}`);
    lines.push(`本地目录: ${result.skillsDir}`);
    lines.push('');
    if (result.details.length === 0) {
        lines.push('没有技能需要同步');
        return lines.join('\n');
    }
    for (const detail of result.details) {
        const icon = detail.action === 'installed' ? '🆕'
            : detail.action === 'updated' ? '🔄'
                : detail.action === 'removed' ? '🗑️'
                    : detail.action === 'failed' ? '❌'
                        : '✅';
        lines.push(`${icon} ${detail.skillId} [${detail.action}]`);
        if (detail.filesAdded.length > 0) {
            lines.push(`  + 新增 ${detail.filesAdded.length} 个文件:`);
            for (const f of detail.filesAdded.slice(0, 5)) {
                lines.push(`    - ${f}`);
            }
            if (detail.filesAdded.length > 5) {
                lines.push(`    ... 等共 ${detail.filesAdded.length} 个文件`);
            }
        }
        if (detail.filesUpdated.length > 0) {
            lines.push(`  ~ 更新 ${detail.filesUpdated.length} 个文件:`);
            for (const f of detail.filesUpdated.slice(0, 5)) {
                lines.push(`    - ${f}`);
            }
            if (detail.filesUpdated.length > 5) {
                lines.push(`    ... 等共 ${detail.filesUpdated.length} 个文件`);
            }
        }
        if (detail.filesRemoved.length > 0) {
            lines.push(`  - 删除 ${detail.filesRemoved.length} 个文件:`);
            for (const f of detail.filesRemoved.slice(0, 5)) {
                lines.push(`    - ${f}`);
            }
            if (detail.filesRemoved.length > 5) {
                lines.push(`    ... 等共 ${detail.filesRemoved.length} 个文件`);
            }
        }
        if (detail.error) {
            lines.push(`  ⚠️ 错误: ${detail.error}`);
        }
        lines.push('');
    }
    lines.push(`📊 统计: ${result.installed} 安装 / ${result.updated} 更新 / ${result.removed} 删除 / ${result.failed} 失败`);
    return lines.join('\n');
}
//# sourceMappingURL=skill-install.js.map