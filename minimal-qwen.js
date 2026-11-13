#!/usr/bin/env node
'use strict';

// qwen CLI 在 --output-format stream-json 下按 JSONL 输出（每行一个完整 JSON 事件）。
// 本脚本只关心这几类事件：
//   {"type":"system","subtype":"init","model":...,"session_id":...}        会话元信息
//   {"type":"assistant","message":{"content":[{...}, ...]}}                模型输出，content 是块数组
//        块类型: {type:"text",text} | {type:"thinking",thinking} | {type:"tool_use",name,input}
//   {"type":"user","message":{"content":[{"type":"tool_result",...}]}}      工具执行结果（本脚本忽略）
//   {"type":"result","subtype":"success","is_error":false,"result":...}     终止事件，含最终文本与用量
// 加 --include-partial-messages 后还会出现逐 token 的
//   {"type":"stream_event","event":{"type":"content_block_delta","delta":{...}}}

const { spawn } = require('node:child_process');
const readline = require('node:readline');

const prompt = process.argv.slice(2).join(' ').trim();

if (!prompt) {
  console.error('用法: node minimal-qwen.js "你的提示词"');
  process.exit(1);
}

// headless 下不传审批参数时 qwen 默认 approval-mode=auto，工具调用不会阻塞等待确认；
// 想更保守可加 '--approval-mode', 'plan'（只读分析），想全放开可加 '--yolo'。
const child = spawn('qwen', [prompt, '--output-format', 'stream-json'], {
  stdio: ['ignore', 'pipe', 'pipe'],
});

let sawAssistantText = false;
let finalResult = null;
let finished = false;

// stdout 是行分帧的 JSON，用 readline 把字节流切成一行行事件
const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });

rl.on('line', (line) => {
  const raw = line.trim();
  if (!raw) return;

  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    console.error('[非 JSON 行] ' + raw);
    return;
  }

  switch (event.type) {
    case 'system':
      if (event.subtype === 'init') {
        console.error(`[init] model=${event.model} session=${event.session_id}`);
      }
      break;

    case 'assistant':
      for (const block of event.message?.content ?? []) {
        if (block.type === 'text' && block.text) {
          sawAssistantText = true;
          process.stdout.write(block.text + '\n');
        } else if (block.type === 'tool_use') {
          console.error(`[tool_use] ${block.name} ${JSON.stringify(block.input)}`);
        }
      }
      break;

    case 'result':
      finalResult = event;
      // result 是终止事件，收到就可以收工了，不必等进程自己退出（见 finish 里的说明）
      finish(event.is_error ? 1 : 0, null);
      break;

    default:
      break;
  }
});

child.stderr.pipe(process.stderr);

child.on('error', (err) => {
  console.error(`[spawn 失败] ${err.message}`);
  process.exit(1);
});

child.on('close', (code, signal) => {
  finish(code, signal);
});

function finish(code, signal) {
  if (finished) return;
  finished = true;

  // 没拿到 assistant 文本时（例如中途出错），退回 result 事件里的最终文本
  if (!sawAssistantText && finalResult?.result) {
    process.stdout.write(finalResult.result + '\n');
  }

  if (finalResult) {
    const u = finalResult.usage ?? {};
    console.error(
      `[done] is_error=${finalResult.is_error} turns=${finalResult.num_turns}` +
        ` ${finalResult.duration_ms}ms tokens=${u.total_tokens ?? '?'}`
    );
  }

  console.error(`[exit] code=${code ?? 0} signal=${signal ?? 'none'}`);
  process.exitCode = code ?? 0;

  // qwen 发完 result 事件后并不会立刻退出：它还要等 managed auto-memory 任务
  // （每次都是几万 token 的模型调用）跑完，实测能耗 90s 以上（QwenLM/qwen-code#13851）。
  // 这里主动 SIGKILL 收掉它——SIGTERM 在 stream-json 模式下只中止当前轮次、不会退出。
  // 不用 process.exit()：stdout 接的是管道，写入是异步的，立即退出会截断回复；
  // 杀掉子进程后 stdio 关闭、事件循环自然排空，带着 exitCode 干净退出。
  child.kill('SIGKILL');
}

// Ctrl-C 时把子进程一起收掉，避免 qwen 变成孤儿进程继续跑
process.on('SIGINT', () => {
  child.kill('SIGINT');
});
