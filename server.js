'use strict';

// 阶段 1：常驻后端（HTTP + WebSocket）+ @路由 + Agent 调度器（含超时与错误处理）
// 阶段 2 在 buildPrompt 里注入共享记忆；阶段 3 在 handleIncoming 里加主动感知；
// 阶段 4 把 runAgent 的 cwd 换成共享工作空间目录。

const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { spawn } = require('node:child_process');

const express = require('express');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT) || 3000;
const AGENT_TIMEOUT_MS = Number(process.env.AGENT_TIMEOUT_MS) || 120_000;
// 已经收到回复文本后，再静默这么久就认为 CLI 挂住了，用现有输出收尾
const AGENT_IDLE_MS = Number(process.env.AGENT_IDLE_MS) || 15_000;
const MAX_HISTORY = 200;

// Agent 的工作目录，刻意与后端源码隔离。实测：headless 的 auto 审批模式下 Agent 会
// 对 cwd 里的文件调用 glob / grep_search 等工具，如果 cwd 是项目根目录，它就能读到
// 甚至改到 server.js 自己。阶段 4 的「共享工作空间」就是这个目录。
const WORKSPACE_DIR = path.join(__dirname, 'workspace');

// Agent 注册表：新增一个 Agent 只要在这里加一行，
// @路由、前端的 Agent 芯片列表都会自动跟上。script 必须是「argv[2] 收提示词、
// 回复写 stdout、日志写 stderr、成功退出码 0」的脚本。
const AGENTS = {
  qwen: { script: 'minimal-qwen.js', label: 'Qwen' },
  kimi: { script: 'minimal-kimi.js', label: 'Kimi' },
};

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/agents', (_req, res) => {
  res.json(Object.entries(AGENTS).map(([name, a]) => ({ name, label: a.label })));
});

// 备用入口：不开浏览器也能用 curl 发消息，Agent 回复仍走 WebSocket 广播。
app.post('/api/messages', (req, res) => {
  const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
  if (!text) {
    res.status(400).json({ error: 'text 不能为空' });
    return;
  }
  handleIncoming(text, typeof req.body?.sender === 'string' ? req.body.sender : 'curl');
  res.json({ ok: true, mentions: parseMentions(text) });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

// ==================== 消息总线 ====================
// 常驻服务，历史条数必须有上限，否则内存只涨不落。
const messages = [];

function broadcast(event) {
  const payload = JSON.stringify(event);
  for (const client of wss.clients) {
    if (client.readyState === client.OPEN) client.send(payload);
  }
}

// 只有 type=message 的事件进历史；status（思考中/出错）是瞬态的，不落库。
function publish(event) {
  if (event.type === 'message') {
    messages.push(event);
    if (messages.length > MAX_HISTORY) messages.splice(0, messages.length - MAX_HISTORY);
  }
  broadcast(event);
  return event;
}

wss.on('connection', (ws) => {
  // 新客户端连上先补发历史，刷新页面不会丢上下文
  ws.send(JSON.stringify({ type: 'history', messages }));

  ws.on('message', (raw) => {
    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch {
      return; // 非 JSON 帧直接丢弃
    }
    if (data.type === 'chat' && typeof data.text === 'string' && data.text.trim()) {
      handleIncoming(data.text.trim(), typeof data.sender === 'string' ? data.sender : 'user');
    }
  });
});

// ============ 入站消息 → @路由 → Agent 调度 ============
function handleIncoming(text, sender) {
  publish({
    id: crypto.randomUUID(),
    type: 'message',
    from: 'user',
    sender,
    text,
    ts: Date.now(),
  });

  // ---------- 这里是 @路由 ----------
  const targets = parseMentions(text);

  if (targets.length === 0) {
    // 阶段 3 会在这里让「未被 @ 的 Agent」自行评估要不要插话；阶段 1 到此结束。
    return;
  }

  // 多个 Agent 并发跑、互不 await，所以一个慢不会挡住另一个；
  // 每个调用各自带超时，卡死只影响它自己，不会拖垮后端事件循环。
  for (const name of targets) {
    dispatchToAgent(name, text).catch((err) => {
      console.error(`[dispatch:${name}] 未预期的异常:`, err);
    });
  }
}

// 只认注册表里存在的名字，@小明 这种未知提及会被忽略。
function parseMentions(text) {
  const found = [];
  for (const match of text.matchAll(/@([A-Za-z0-9_-]+)/g)) {
    const name = match[1].toLowerCase();
    if (AGENTS[name] && !found.includes(name)) found.push(name);
  }
  return found;
}

// 同一个 Agent 同时只允许一个调用在跑。实测：CLI 进程每个约 230MB，且并发打模型
// 容易触发限流（连发 4 个请求后有 3 个 40s 仍未返回）。阶段 1 直接回「忙」，
// 之后要排队再换成有界队列。
const running = new Set();

async function dispatchToAgent(name, sourceText) {
  if (running.has(name)) {
    console.warn(`[agent:${name}] 正忙，跳过本次调用`);
    publish({ type: 'status', agent: name, state: 'busy', ts: Date.now() });
    return;
  }

  running.add(name);
  const started = Date.now();
  publish({ type: 'status', agent: name, state: 'thinking', ts: started });

  // ---------- 这里是记忆注入 ----------
  // 阶段 2：把共享对话历史拼进 prompt。阶段 1 只透传用户当前这句话。
  const prompt = buildPrompt(sourceText);

  try {
    const { text, degraded } = await runAgent(name, prompt);
    if (degraded) console.warn(`[agent:${name}] 降级返回：${degraded}`);
    publish({
      id: crypto.randomUUID(),
      type: 'message',
      from: 'agent',
      agent: name,
      label: AGENTS[name].label,
      text,
      degraded: degraded || null,
      ts: Date.now(),
      ms: Date.now() - started,
    });
  } catch (err) {
    // Agent 失败只广播错误、不抛出：后端必须继续服务其他消息
    console.error(`[agent:${name}] ${err.message}`);
    publish({ type: 'status', agent: name, state: 'error', error: err.message, ts: Date.now() });
  } finally {
    running.delete(name);
    publish({ type: 'status', agent: name, state: 'idle', ts: Date.now() });
  }
}

function buildPrompt(sourceText) {
  return sourceText;
}

// ==================== Agent 调度器 ====================
// 实测坑：qwen CLI 有概率在输出完答案后既不发 result 事件也不退出（裸跑脚本即可复现，
// 三次里挂两次），而 kimi 正常。所以这里不把「子进程正常退出」当作拿到回复的前提：
// 只要已经收到文本，静默一段时间后就按现有输出收尾，并把降级原因一并回传。
const activeChildren = new Set();

// 用 process.execPath 拉起包装脚本，避免子进程的 node 不在 PATH 里（例如 nvm 环境）
function runAgent(name, prompt) {
  const agent = AGENTS[name];

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, agent.script), prompt], {
      cwd: WORKSPACE_DIR, // 共享工作空间：Agent 只看得到这里，碰不到后端源码
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env, // 子脚本要靠它找到 qwen / kimi 可执行文件
      detached: true, // 独立进程组：超时时能把内层 CLI 一起杀掉，不留孤儿
    });

    activeChildren.add(child);

    let stdout = '';
    let stderr = '';
    let settled = false;
    let gotText = false;
    let idleTimer = null;

    const killTree = () => {
      try {
        process.kill(-child.pid, 'SIGKILL'); // 负 pid = 整个进程组
      } catch {
        try { child.kill('SIGKILL'); } catch { /* 已经没了 */ }
      }
    };

    const settle = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimer);
      clearTimeout(idleTimer);
      activeChildren.delete(child);
      fn(arg);
    };

    // 硬上限：整体最长等待时间
    const hardTimer = setTimeout(() => {
      killTree();
      if (stdout.trim()) {
        settle(resolve, { text: stdout.trim(), degraded: `硬超时 ${AGENT_TIMEOUT_MS / 1000}s，按已收到的输出返回` });
      } else {
        settle(reject, new Error(describeFailure(`${name} 超过 ${AGENT_TIMEOUT_MS / 1000}s 无任何输出，已强制终止`)));
      }
    }, AGENT_TIMEOUT_MS);

    // 已经拿到文本后的静默判定：CLI 不再产出且迟迟不退出，就用现有输出收尾。
    // stdout 和 stderr 都算「活动」（工具调用期间包装脚本会往 stderr 打 [tool_use]），
    // 避免把正常的长耗时工具轮次误判成挂死。
    const armIdleTimer = () => {
      if (!gotText) return;
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        killTree();
        settle(resolve, {
          text: stdout.trim(),
          degraded: `CLI 已给出回复但 ${AGENT_IDLE_MS / 1000}s 内无输出且未退出，按已收到的输出返回`,
        });
      }, AGENT_IDLE_MS);
    };

    const describeFailure = (head) => {
      const tail = stderr.trim() ? `\nstderr 尾部: ${stderr.trim().slice(-500)}` : '';
      return new Error(head + tail);
    };

    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (!gotText && stdout.trim()) gotText = true;
      armIdleTimer();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      armIdleTimer();
    });

    child.on('error', (err) => {
      settle(reject, new Error(`无法启动 ${agent.script}: ${err.message}`));
    });

    child.on('close', (code, signal) => {
      const text = stdout.trim();
      // 有文本就交付，哪怕退出码非 0（降级标注），别把已经算出来的答案丢掉
      if (text) {
        settle(resolve, {
          text,
          degraded: code === 0 ? null : `退出码 ${code}${signal ? ` (signal=${signal})` : ''}，但已收到完整输出`,
        });
        return;
      }
      const detail = signal ? ` (signal=${signal})` : '';
      settle(reject, describeFailure(`${name} 退出码 ${code}${detail} 且没有返回任何内容`));
    });
  });
}

// 后端自身退出时把所有还在跑的 Agent 子进程收掉（detached 的进程组不会跟着 Ctrl-C 走）
function shutdown(reason) {
  console.log(`\n[multiagent] ${reason}，清理 ${activeChildren.size} 个 Agent 子进程…`);
  for (const child of activeChildren) {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* 已经没了 */ }
  }
  activeChildren.clear();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('收到 SIGINT'));
process.on('SIGTERM', () => shutdown('收到 SIGTERM'));

// ==================== 启动 ====================
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[multiagent] 端口 ${PORT} 已被占用，换一个：PORT=3001 npm start`);
  } else {
    console.error('[multiagent] 服务启动失败:', err.message);
  }
  process.exit(1);
});

fs.mkdirSync(WORKSPACE_DIR, { recursive: true });

server.listen(PORT, () => {
  console.log(`[multiagent] 前端 http://localhost:${PORT}   WebSocket ws://localhost:${PORT}/ws`);
  console.log(
    `[multiagent] agents=${Object.keys(AGENTS).join(',')}  硬超时=${AGENT_TIMEOUT_MS}ms` +
      `  静默判定=${AGENT_IDLE_MS}ms  node=${process.execPath}`
  );
  console.log(`[multiagent] Agent 工作空间 ${WORKSPACE_DIR}`);
});
