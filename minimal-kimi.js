#!/usr/bin/env node

const { spawn } = require('node:child_process');
const readline = require('node:readline');

const prompt = process.argv[2];

if (!prompt) {
  console.error('用法: node minimal-kimi.js "你的问题"');
  process.exit(1);
}

const child = spawn('kimi', ['-p', prompt, '--output-format', 'stream-json'], {
  stdio: ['ignore', 'pipe', 'pipe'],
});

let stderr = '';

const rl = readline.createInterface({
  input: child.stdout,
  crlfDelay: Infinity,
});

rl.on('line', (line) => {
  const text = line.trim();

  // 工具输出等非 JSON 内容会直接写到 stdout，跳过
  if (!text.startsWith('{')) return;

  let event;
  try {
    event = JSON.parse(text);
  } catch {
    return;
  }

  // assistant 事件形如: { "role": "assistant", "content": "..." }
  // 带工具调用的事件只有 tool_calls，没有 content，会被忽略
  if (event.role === 'assistant' && typeof event.content === 'string') {
    process.stdout.write(event.content + '\n');
  }
});

child.stderr.on('data', (chunk) => {
  stderr += chunk;
});

child.on('error', (err) => {
  console.error(`无法启动 kimi: ${err.message}`);
  process.exit(1);
});

child.on('close', (code, signal) => {
  if (code !== 0) {
    console.error(`kimi 异常退出 (code=${code}, signal=${signal})`);
    if (stderr.trim()) console.error(stderr.trim());
    process.exit(code ?? 1);
  }
});
