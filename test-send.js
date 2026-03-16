#!/usr/bin/env node
// test-send.js - 测试 wegirl send 功能

const testPayload = {
  target: "agent:scout",
  message: "请分析 https://rekotechnology.com/",
  channel: "feishu",
  accountId: "scout-notifier",
  chatId: "oc_2bdd011945222656cb3848d5750840aa",
  chatType: "direct"
};

console.log('测试 payload:');
console.log(JSON.stringify(testPayload, null, 2));
console.log('\n执行命令:');
console.log(`node wegirl-cli.js send --target "${testPayload.target}" --message "${testPayload.message}" --channel "${testPayload.channel}" --accountId "${testPayload.accountId}" --chatId "${testPayload.chatId}" --chatType "${testPayload.chatType}" --from cli`);

// 实际执行
import('./wegirl-cli.js').catch(() => {
  // 通过 child_process 执行
  const { spawn } = require('child_process');
  
  const args = [
    'send',
    '--target', testPayload.target,
    '--message', testPayload.message,
    '--channel', testPayload.channel,
    '--accountId', testPayload.accountId,
    '--chatId', testPayload.chatId,
    '--chatType', testPayload.chatType,
    '--from', 'cli'
  ];
  
  console.log('\n实际执行中...\n');
  
  const proc = spawn('node', ['wegirl-cli.js', ...args], {
    cwd: '/root/.openclaw/extensions/wegirl-connector',
    env: { ...process.env, REDIS_DB: '1' }
  });
  
  proc.stdout.on('data', (data) => console.log(data.toString()));
  proc.stderr.on('data', (data) => console.error(data.toString()));
  proc.on('close', (code) => console.log(`\n退出码: ${code}`));
});
