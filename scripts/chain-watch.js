'use strict';
// 观察一条 Agent 协作链：发一条消息，把每一轮的 depth / triggeredBy / mentions 按时间打出来。
//
// 用法：
//   node scripts/chain-watch.js <roomId> "<消息>" [最长等待秒数]
// 例：
//   node scripts/chain-watch.js room-default "@qwen 请在当前目录创建 hello.py，打印 hello world，并实际运行一次"
//
// 结束条件：最后一个事件之后静默 90s（qwen 带工具核验时单轮可到 80s，窗口不能再短），
// 或超过最长等待时间。收到过 Agent 回复则退出码 0。
const WebSocket = require('ws');

const room = process.argv[2];
const text = process.argv[3];
const maxSec = Number(process.argv[4] || 420);

if (!room || !text) {
  console.error('用法: node scripts/chain-watch.js <roomId> "<消息>" [最长等待秒数]');
  console.error('房间列表: curl -s localhost:3000/api/rooms');
  process.exit(2);
}

// 静默窗口默认 90s：qwen 带工具核验时单轮可到 80s，再短会把还在跑的链条误判成已结束。
// 只是快速验证一次单轮调用时可以用 CHAIN_IDLE_MS 调小，例如 CHAIN_IDLE_MS=15000。
const IDLE_MS = Number(process.env.CHAIN_IDLE_MS) || 90_000;
const ws = new WebSocket(`ws://localhost:3000/ws?room=${encodeURIComponent(room)}`);
const t0 = Date.now();
const at = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`.padStart(9);

let agentMessages = 0;
let maxDepth = -1;
let sawLimit = false;
let idleTimer = null;

const finish = (why) => {
  console.log(`\n${at()} === 结束（${why}）===`);
  console.log(`Agent 消息 ${agentMessages} 条，最大 depth=${maxDepth}${sawLimit ? '，出现过深度上限截断' : ''}`);
  clearTimeout(idleTimer);
  clearTimeout(hardTimer);
  try { ws.close(); } catch { /* 已关闭 */ }
  process.exit(agentMessages > 0 ? 0 : 1);
};
const arm = () => {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => finish(`静默 ${IDLE_MS / 1000}s，链条应已结束`), IDLE_MS);
};

const hardTimer = setTimeout(() => finish(`超过最长等待 ${maxSec}s`), maxSec * 1000);

ws.on('open', () => console.log(`${at()} 已连接房间 ${room}`));
ws.on('error', (e) => {
  console.log(`${at()} ❌ 连接失败: ${e.message}`);
  console.log('   提示：room 参数必须是已存在的房间，否则握手会被回 400');
  process.exit(1);
});

ws.on('message', (raw) => {
  const ev = JSON.parse(raw.toString());
  arm();

  if (ev.type === 'history') {
    console.log(`${at()} history ${ev.messages.length} 条（已有上下文会一起注入给 Agent）`);
    console.log(`${at()} 发送: ${text.slice(0, 80)}${text.length > 80 ? '…' : ''}\n`);
    ws.send(JSON.stringify({ type: 'chat', text, sender: 'chain-watch' }));
    return;
  }

  if (ev.type === 'status') {
    const from = ev.triggeredBy === 'agent_mention' ? ' ← 同伴召唤' : '';
    const extra = ev.state === 'busy' ? '  ⚠ 并发闸拦下，链条会在此中断' : '';
    console.log(
      `${at()} [status] ${ev.agent} ${ev.state} depth=${ev.depth ?? '-'}${from}${extra}` +
        (ev.error ? `  err=${String(ev.error).slice(0, 140)}` : '')
    );
    return;
  }

  if (ev.type === 'chain_stopped') {
    console.log(`${at()} [chain_stopped] 协作已被终止，杀掉 ${ev.killed} 个子进程`);
    return;
  }

  if (ev.type === 'user_message' || ev.type === 'message') return; // 自己发的回声

  if (ev.type === 'agent_message') {
    agentMessages++;
    if ((ev.depth ?? 0) > maxDepth) maxDepth = ev.depth;
    if (ev.depthLimited) sawLimit = true;

    const flags = [
      `depth=${ev.depth}`,
      `by=${ev.triggeredBy}`,
      `mentions=${JSON.stringify(ev.mentions)}`,
      ev.depthLimited ? '❗已达上限' : null,
      ev.degraded ? `⚠降级(${ev.degraded})` : null,
      `${(ev.ms / 1000).toFixed(1)}s`,
    ].filter(Boolean).join(' ');

    console.log(`${at()} [${ev.label}] ${flags}`);
    // 首行最关键：行首的 @同伴名 就是触发下一轮的那个
    console.log(`          首行: ${ev.text.split('\n')[0].slice(0, 130)}`);
  }
});
