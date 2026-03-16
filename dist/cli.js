#!/usr/bin/env node
// src/cli.ts - WeGirl CLI 工具
import Redis from 'ioredis';
const KEY_PREFIX = 'wegirl:';
function parseArgs() {
    const args = process.argv.slice(2);
    const command = args[0] || 'status';
    const options = {
        redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
        redisPassword: process.env.REDIS_PASSWORD,
        redisDb: parseInt(process.env.REDIS_DB || '1'),
        instanceId: process.env.OPENCLAW_INSTANCE_ID || 'instance-local',
    };
    for (let i = 1; i < args.length; i++) {
        const arg = args[i];
        if (arg === '--redis-url' || arg === '-r') {
            options.redisUrl = args[++i];
        }
        else if (arg === '--redis-password' || arg === '-p') {
            options.redisPassword = args[++i];
        }
        else if (arg === '--redis-db' || arg === '-d') {
            options.redisDb = parseInt(args[++i]);
        }
        else if (arg === '--instance-id' || arg === '-i') {
            options.instanceId = args[++i];
        }
    }
    return { command, options };
}
async function connectRedis(options) {
    const redisOptions = { db: options.redisDb };
    if (options.redisPassword)
        redisOptions.password = options.redisPassword;
    const redis = new Redis(options.redisUrl, redisOptions);
    await redis.ping();
    return redis;
}
async function getStatus(redis, options) {
    const streamKey = `${KEY_PREFIX}stream:instance:${options.instanceId}`;
    const consumerGroup = 'wegirl-consumers';
    console.log(`\n📊 WeGirl Status (Instance: ${options.instanceId})`);
    console.log('='.repeat(50));
    // 1. Stream 信息
    try {
        const streamInfo = await redis.xinfo('STREAM', streamKey);
        const infoMap = {};
        for (let i = 0; i < streamInfo.length; i += 2) {
            infoMap[streamInfo[i]] = streamInfo[i + 1];
        }
        console.log(`\n📦 Stream: ${streamKey}`);
        console.log(`   Messages: ${infoMap.length || 0}`);
        console.log(`   Groups: ${infoMap.groups || 0}`);
        console.log(`   Last ID: ${infoMap['last-generated-id'] || 'N/A'}`);
    }
    catch (err) {
        if (err.message?.includes('no such key')) {
            console.log(`\n📦 Stream: ${streamKey}`);
            console.log('   Status: Empty (no messages yet)');
        }
        else {
            console.log(`\n❌ Stream error: ${err.message}`);
        }
    }
    // 2. Consumer Groups
    try {
        const groupInfo = await redis.xinfo('GROUPS', streamKey);
        console.log(`\n👥 Consumer Groups:`);
        if (groupInfo.length === 0) {
            console.log('   No consumer groups');
        }
        for (const group of groupInfo) {
            const groupMap = {};
            for (let i = 0; i < group.length; i += 2) {
                groupMap[group[i]] = group[i + 1];
            }
            console.log(`   📌 ${groupMap.name}`);
            console.log(`      Consumers: ${groupMap.consumers || 0}`);
            console.log(`      Pending: ${groupMap.pending || 0}`);
            console.log(`      Last delivered: ${groupMap['last-delivered-id'] || 'N/A'}`);
        }
    }
    catch (err) {
        console.log(`\n👥 Consumer Groups: ${err.message}`);
    }
    // 3. Pending 消息
    try {
        const pending = await redis.xpending(streamKey, consumerGroup);
        if (pending && pending[0] > 0) {
            console.log(`\n⏳ Pending Messages: ${pending[0]}`);
            console.log(`   Min ID: ${pending[1]}`);
            console.log(`   Max ID: ${pending[2]}`);
            const details = await redis.xpending(streamKey, consumerGroup, '-', '+', 5);
            for (const p of details) {
                console.log(`   - ${p[0]} | Consumer: ${p[1]} | Idle: ${p[2]}ms | Retries: ${p[3]}`);
            }
        }
        else {
            console.log(`\n⏳ Pending Messages: 0`);
        }
    }
    catch (err) {
        console.log(`\n⏳ Pending: ${err.message}`);
    }
    // 4. Agents
    try {
        const agentKeys = await redis.keys(`${KEY_PREFIX}agents:*`);
        console.log(`\n🤖 Registered Agents: ${agentKeys.length}`);
        for (const key of agentKeys) {
            const agentId = key.replace(`${KEY_PREFIX}agents:`, '');
            const data = await redis.hgetall(key);
            const caps = data.capabilities?.split(',').filter((c) => c) || [];
            console.log(`   • ${agentId}`);
            console.log(`     Status: ${data.status || 'unknown'}`);
            console.log(`     Capabilities: ${caps.join(', ') || 'none'}`);
            console.log(`     Instance: ${data.instanceId || 'unknown'}`);
        }
    }
    catch (err) {
        console.log(`\n🤖 Agents error: ${err.message}`);
    }
    // 5. Capabilities
    try {
        const capKeys = await redis.keys(`${KEY_PREFIX}capability:*`);
        console.log(`\n🎯 Capabilities:`);
        for (const key of capKeys) {
            const cap = key.replace(`${KEY_PREFIX}capability:`, '');
            const count = await redis.scard(key);
            const agents = await redis.smembers(key);
            console.log(`   ${cap}: ${count} agent(s) [${agents.join(', ')}]`);
        }
    }
    catch (err) {
        console.log(`\n🎯 Capabilities error: ${err.message}`);
    }
    console.log('\n' + '='.repeat(50));
}
async function getAgents(redis) {
    console.log('\n🤖 WeGirl Agents');
    console.log('='.repeat(50));
    try {
        const agentKeys = await redis.keys(`${KEY_PREFIX}agents:*`);
        if (agentKeys.length === 0) {
            console.log('No agents registered');
            return;
        }
        for (const key of agentKeys) {
            const data = await redis.hgetall(key);
            console.log(`\n📌 ${data.name || data.agentId}`);
            console.log(`   ID: ${data.agentId}`);
            console.log(`   Status: ${data.status || 'unknown'}`);
            console.log(`   Instance: ${data.instanceId}`);
            console.log(`   Max Concurrent: ${data.maxConcurrent || 'default'}`);
            console.log(`   Capabilities: ${data.capabilities || 'none'}`);
            console.log(`   Last Heartbeat: ${data.lastHeartbeat ? new Date(parseInt(data.lastHeartbeat)).toISOString() : 'N/A'}`);
        }
    }
    catch (err) {
        console.error(`Error: ${err.message}`);
    }
}
async function getHealth(redis) {
    console.log('\n🏥 WeGirl Health Check');
    console.log('='.repeat(50));
    try {
        await redis.ping();
        console.log('✅ Redis: Connected');
    }
    catch (err) {
        console.log('❌ Redis:', err.message);
        process.exit(1);
    }
    try {
        const agentCount = (await redis.keys(`${KEY_PREFIX}agents:*`)).length;
        console.log(`✅ Agents: ${agentCount} registered`);
    }
    catch (err) {
        console.log(`❌ Agents: ${err.message}`);
    }
    console.log('\n🟢 All systems operational');
}
async function clearStream(redis, options) {
    const streamKey = `${KEY_PREFIX}stream:instance:${options.instanceId}`;
    console.log(`\n⚠️  This will delete all messages in ${streamKey}`);
    console.log('Press Ctrl+C to cancel, or wait 3 seconds to proceed...');
    await new Promise(r => setTimeout(r, 3000));
    try {
        await redis.del(streamKey);
        console.log(`✅ Stream ${streamKey} cleared`);
    }
    catch (err) {
        console.error(`❌ Error: ${err.message}`);
    }
}
function showHelp() {
    console.log(`
WeGirl CLI - Multi-Agent Orchestration Hub

Usage: wegirl-cli <command> [options]

Commands:
  status      Show full status (default)
  agents      List all registered agents
  health      Quick health check
  clear       Clear stream messages (dangerous!)
  help        Show this help

Options:
  -r, --redis-url <url>       Redis URL (default: redis://localhost:6379)
  -p, --redis-password <pwd>  Redis password
  -d, --redis-db <num>        Redis database (default: 1)
  -i, --instance-id <id>      Instance ID (default: instance-local)

Environment Variables:
  REDIS_URL, REDIS_PASSWORD, REDIS_DB, OPENCLAW_INSTANCE_ID

Examples:
  wegirl-cli status
  wegirl-cli agents -r redis://192.168.1.100:6379
  wegirl-cli health
`);
}
async function main() {
    const { command, options } = parseArgs();
    if (command === 'help' || command === '-h' || command === '--help') {
        showHelp();
        process.exit(0);
    }
    let redis = null;
    try {
        redis = await connectRedis(options);
        switch (command) {
            case 'status':
                await getStatus(redis, options);
                break;
            case 'agents':
                await getAgents(redis);
                break;
            case 'health':
                await getHealth(redis);
                break;
            case 'clear':
                await clearStream(redis, options);
                break;
            default:
                console.error(`Unknown command: ${command}`);
                showHelp();
                process.exit(1);
        }
    }
    catch (err) {
        console.error(`\n❌ Error: ${err.message}`);
        process.exit(1);
    }
    finally {
        if (redis)
            await redis.quit();
    }
}
main();
//# sourceMappingURL=cli.js.map