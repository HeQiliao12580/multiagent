'use strict';
// 无头 Chrome 的前端确定性检查工具（走 CDP，不依赖 puppeteer/playwright）。
//
// 用法：
//   node scripts/ui-check.js <url> <就绪条件JS表达式> [截图输出路径]
// 例：
//   node scripts/ui-check.js "http://localhost:3000/?room=room-default" \
//     "document.querySelectorAll('.room-item').length>0 && document.querySelectorAll('.bubble').length>0" \
//     /tmp/ui.png
//
// 为什么需要它：Chrome 的 --screenshot + --virtual-time-budget 在 WebSocket 场景下不可靠
// （虚拟时间不等待真实网络握手，截图经常拍在「连接中…」的空白态）。
// 这里改成显式轮询一个就绪条件，满足后才截图，结果可复现。
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const WebSocket = require('ws');

const CHROME =
  process.env.CHROME_BIN ||
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const DEBUG_PORT = Number(process.env.CDP_PORT) || 9333;

const url = process.argv[2];
const readyExpr = process.argv[3];
const outPng = process.argv[4] || '/tmp/ui-check.png';
const timeoutMs = Number(process.argv[5] || 45000);

if (!url || !readyExpr) {
  console.error('用法: node scripts/ui-check.js <url> "<就绪条件JS>" [截图路径] [超时ms]');
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getJson(path) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: DEBUG_PORT, path }, (res) => {
      let b = '';
      res.on('data', (d) => (b += d));
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

(async () => {
  const chrome = spawn(CHROME, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--hide-scrollbars=false',
    `--remote-debugging-port=${DEBUG_PORT}`,
    '--user-data-dir=/tmp/chrome-cdp-profile',
    '--window-size=1400,900',
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'ignore'] });

  const die = async (code, msg) => {
    if (msg) console.error(msg);
    try { chrome.kill('SIGKILL'); } catch { /* 已退出 */ }
    process.exit(code);
  };

  // 等调试端口就绪
  let target = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 15000) {
    try {
      const list = await getJson('/json/list');
      target = list.find((t) => t.type === 'page');
      if (target) break;
    } catch { /* 还没起来 */ }
    await sleep(300);
  }
  if (!target) await die(1, '❌ 无法连上 Chrome 调试端口');

  const cdp = new WebSocket(target.webSocketDebuggerUrl);
  let nextId = 1;
  const pending = new Map();
  const send = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      cdp.send(JSON.stringify({ id, method, params }));
    });
  const evalJs = (expression, awaitPromise) =>
    send('Runtime.evaluate', { expression, awaitPromise: !!awaitPromise, returnByValue: true })
      .then((r) => {
        if (r.exceptionDetails) throw new Error('页面抛异常: ' + JSON.stringify(r.exceptionDetails).slice(0, 300));
        return r.result && r.result.value;
      });

  cdp.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
    }
  });

  await new Promise((res, rej) => { cdp.on('open', res); cdp.on('error', rej); });

  await send('Page.enable');
  await send('Runtime.enable');

  // 收集 console 报错，前端 JS 抛错时能直接看到原因
  const consoleErrors = [];
  cdp.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      consoleErrors.push(msg.params.args.map((a) => a.value || a.description || '').join(' '));
    }
  });

  await send('Page.navigate', { url });

  // 轮询就绪条件
  const deadline = Date.now() + timeoutMs;
  let ready = false;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      ready = await evalJs(`!!(${readyExpr})`);
      if (ready) break;
    } catch (e) {
      lastErr = e;
    }
    await sleep(400);
  }
  if (!ready) {
    console.log('❌ 就绪条件超时未满足: ' + readyExpr);
    if (lastErr) console.log('   ' + lastErr.message);
    if (consoleErrors.length) console.log('   页面 console.error:\n     ' + consoleErrors.slice(0, 5).join('\n     '));
    const state = await evalJs(`JSON.stringify({
      roomItems: document.querySelectorAll('.room-item').length,
      bubbles: document.querySelectorAll('.bubble').length,
      connText: (document.getElementById('connText')||{}).textContent,
      listMsg: (document.querySelector('.room-list-msg')||{}).textContent
    })`).catch(() => null);
    if (state) console.log('   当时页面状态: ' + state);
    await die(1);
  }
  console.log('✅ 就绪条件满足: ' + readyExpr);

  // 等一帧绘制稳定再截图
  await sleep(500);
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(outPng, Buffer.from(shot.data, 'base64'));
  console.log('✅ 截图已保存: ' + outPng);

  // 顺手把关键 DOM 摘要打出来，便于断言
  const summary = await evalJs(`JSON.stringify({
    rooms: [...document.querySelectorAll('.room-item')].map(function (el) {
      return el.dataset.room + (el.classList.contains('active') ? '*' : '');
    }),
    bubbles: document.querySelectorAll('.bubble').length,
    title: document.title,
    conn: (document.getElementById('connText')||{}).textContent
  })`).catch(() => null);
  if (summary) console.log('   DOM 摘要: ' + summary);
  if (consoleErrors.length) console.log('   ⚠ 页面 console.error:\n     ' + consoleErrors.slice(0, 5).join('\n     '));

  await die(0);
})();
