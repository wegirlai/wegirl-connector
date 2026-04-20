import Redis from 'ioredis';

const redis = new Redis({
  host: '10.8.0.1',
  port: 6379,
  db: 1,
  password: 'microsoul**'
});

async function handleListAgents() {
  const KEY_PREFIX = 'wegirl:';
  const keys = await redis.keys(`${KEY_PREFIX}staff:*`);
  const staffKeys = keys.filter(k => {
    const parts = k.split(':');
    return parts.length === 3 && !k.includes(':by-type:') && !k.includes(':capability:') && !k.includes(':personality:');
  });

  console.log('[TEST] Staff keys count:', staffKeys.length);
  console.log('[TEST] Has sitemap:', staffKeys.includes('wegirl:staff:sitemap'));

  const agents = await Promise.all(
    staffKeys.map(async (key) => {
      try {
        const keyType = await redis.type(key);
        if (keyType !== 'hash') {
          console.log('[TEST] Skipping non-hash:', key);
          return null;
        }

        const data = await redis.hgetall(key);
        
        if (data.staffId === 'sitemap') {
          console.log('[TEST] Processing sitemap, data.type:', data.type);
        }
        
        if (data.type !== 'agent' && data.type !== 'human' && data.type !== 'npc') {
          console.log('[TEST] Skipping wrong type:', key, 'data.type:', data.type);
          return null;
        }

        let capabilities = [];
        try {
          if (data.capabilities) {
            capabilities = JSON.parse(data.capabilities);
          }
        } catch (e) {
          capabilities = data.capabilities?.split(',').filter(Boolean) || [];
        }

        return {
          accountId: data.staffId,
          name: data.name,
          type: data.type,
          role: data.role || '-',
          instanceId: data.instanceId,
          status: data.status,
          capabilities: capabilities.slice(0, 3),
          capabilityCount: capabilities.length,
          lastHeartbeat: data.lastHeartbeat
        };
      } catch (err) {
        console.log('[TEST] Error reading key', key, ':', err.message);
        return null;
      }
    })
  );

  const validAgents = agents.filter(a => a !== null);
  
  // Debug: 检查 sitemap 是否在 validAgents 中
  const sitemapAgent = validAgents.find((a) => a?.accountId === 'sitemap');
  console.log(`[TEST] Sitemap in validAgents: ${sitemapAgent ? 'YES' : 'NO'}, total: ${validAgents.length}`);
  
  // 按 instanceId 排序
  validAgents.sort((a, b) => {
    if (a.instanceId < b.instanceId) return -1;
    if (a.instanceId > b.instanceId) return 1;
    return 0;
  });
  
  console.log('[TEST] Returning', validAgents.length, 'agents');
  
  return {
    success: true,
    count: validAgents.length,
    agents: validAgents
  };
}

handleListAgents().then(result => {
  console.log('\n[TEST] Final result count:', result.count);
  console.log('[TEST] Sitemap in result:', result.agents.some(a => a.accountId === 'sitemap'));
  redis.disconnect();
});
