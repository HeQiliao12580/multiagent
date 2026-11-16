'use strict';
// 验证「停止协作」这条安全阀。两段测试，都会真实调用 Agent（会烧 token）：
//
//   A 段：触发协作链 -> 等它跑到 depth>=1 -> 发 stop_chain
//         断言：收到 chain_stopped、被杀的那轮报 aborted、之后不再出现更深一轮
//   B 段：再发一条新消息触发链条
//         断言：链条能重新推进到 depth>=1，证明 aborted 标记已被清除
//         （这条最容易漏测 —— 漏了就是「按一次停止，这个房间永久无法协作」）
//
// 用法：node scripts/stop-chain-test.js [roomId]
//   不给 roomId 时用一个一次性的 stop-chain-test 房间，跑完自动删除。
const WebSocket = require('ws');
const http = require('node:http');

const PORT = Number(process.env.PORT) || 3000;
const OWN_ROOM = !process.argv[2];
const ROOM = process.argv[2] || 'stop-chain-test';

const t0 = Date.now();
const at = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`.padStart(9);
let pass = 0;
let fail = 0;
const ok = (m) => { console.log(`${at()} ✅ ${m}`); pass++; };
const no = (m) => { console.log(`${at()} ❌ ${m}`); fail++; };

function api(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(
      { host: 'localhost', port: PORT, path, method,
        headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {} },
      (res) => { let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => resolve({ status: res.statusCode, body: b })); }
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const TASK_A = '@qwen 请让同伴在当前目录创建 stop-a.txt，内容写 A，然后你们来回互相确认至少 6 轮，不要提前结束';
const TASK_B = '@qwen 请让同伴在当前目录创建 stop-b.txt，内容写 B，完成后照常交回给你检查';

let ws = null;
let phase = 'A';
let stopSent = false;
let depthAtStop = -1;
let stopEventIndex = -1;
const events = [];
let maxDepthB = -1;
let settled = false;

const cleanup = async () => {
  try { ws.close(); } catch { /* 已关闭 */ }
  if (OWN_ROOM) {
    const r = await api('DELETE', `/api/rooms/${ROOM}`);
    console.log(`${at()} 已删除一次性房间 ${ROOM}（HTTP ${r.status}）`);
  }
  console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
  process.exit(fail ? 1 : 0);
};

const fail_fast = async (msg) => { no(msg); await cleanup(); };

async function main() {
  if (OWN_ROOM) {
    const r = await api('POST', '/api/rooms', { name: ROOM, id: ROOM });
    if (r.status !== 201) { console.error(`建房间失败 HTTP ${r.status}: ${r.body}`); process.exit(1); }
    console.log(`${at()} 已建一次性房间 ${ROOM}`);
  }

  ws = new WebSocket(`ws://localhost:${PORT}/ws?room=${encodeURIComponent(ROOM)}`);
  ws.on('error', (e) => fail_fast('连接失败: ' + e.message));
  ws.on('open', () => console.log(`${at()} 已连接 ${ROOM}`));
  ws.on('message', (raw) => {
    const ev = JSON.parse(raw.toString());
    events.push(ev);

    if (ev.type === 'history') {
      console.log(`${at()} --- A 段：触发链条后中途终止 ---`);
      ws.send(JSON.stringify({ type: 'chat', text: TASK_A, sender: 'stop-chain-test' }));
      return;
    }

    if (ev.type === 'status') {
      console.log(`${at()} [status] ${ev.agent || '-'} ${ev.state} depth=${ev.depth ?? '-'}`);

      if (ev.state === 'thinking' && ev.depth >= 1) {
        if (phase === 'A' && !stopSent) {
          stopSent = true;
          depthAtStop = ev.depth;
          console.log(`${at()} >>> 链条已到 depth=${ev.depth}，发送 stop_chain`);
          ws.send(JSON.stringify({ type: 'stop_chain' }));
        } else if (phase === 'B' && ev.depth > maxDepthB) {
          maxDepthB = ev.depth;
          // B 段只要证明「能重新推进」就够了，不必等整条链跑完
          if (!settled) {
            settled = true;
            ok(`B 段链条重新推进到 depth=${ev.depth}，aborted 标记已被清除`);
            setTimeout(cleanup, 1500);
          }
        }
      }
      return;
    }

    if (ev.type === 'chain_stopped') {
      stopEventIndex = events.length - 1;
      ok(`收到 chain_stopped，killed=${ev.killed}`);
      // 留 15s 观察窗：链条真停了的话，这期间不该再出现更深一轮的 thinking
      setTimeout(() => {
        const deeper = events.slice(stopEventIndex + 1).some(
          (e) => e.type === 'status' && e.state === 'thinking' && e.depth > depthAtStop
        );
        if (deeper) no(`终止后仍出现了 depth > ${depthAtStop} 的调用`);
        else ok(`终止后没有再出现 depth > ${depthAtStop} 的调用`);

        const aborted = events.some((e) => e.type === 'status' && e.state === 'aborted');
        if (aborted) ok('被杀的那轮上报了 status=aborted（不是 error，前端不会显示成红色故障）');
        else no('没看到 status=aborted 事件');

        console.log(`${at()} --- B 段：验证 aborted 标记会被新用户消息清除 ---`);
        phase = 'B';
        ws.send(JSON.stringify({ type: 'chat', text: TASK_B, sender: 'stop-chain-test' }));
      }, 15000);
      return;
    }

    if (ev.type === 'agent_message') {
      console.log(
        `${at()} [${ev.label}] depth=${ev.depth} by=${ev.triggeredBy}` +
          ` mentions=${JSON.stringify(ev.mentions)}${ev.depthLimited ? ' ❗已达上限' : ''}`
      );
    }
  });

  // B 段兜底：万一链条始终没推进到 depth>=1
  setTimeout(() => {
    if (settled) return;
    settled = true;
    if (phase === 'B') no('B 段链条始终没推进到 depth>=1，aborted 标记可能没被清除');
    else no('A 段超时：链条没跑到 depth>=1，或 stop_chain 没生效');
    cleanup();
  }, 400_000);
}

main();
