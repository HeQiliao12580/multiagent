# 快速上手：用你自己的 CLI 配置本项目

面向**第一次拿到这个仓库、想用自家 AI CLI（claude / gemini / 通义 / 其他）**的人。
默认配置用的是 `qwen` 和 `kimi`，如果你本机没有它们，照第 3 节换成自己的即可。

预计耗时：15–30 分钟（其中大部分是让 AI 帮你生成 wrapper 脚本 + 一次真实调用验证）。

---

## 1. 前置条件

| 依赖 | 说明 |
|---|---|
| Node.js ≥ 18 | 用到 `node:` 内置模块、可选链、`matchAll` |
| 你的 AI CLI | 已安装、已登录、能独立跑通一次非交互调用 |
| npm 网络 | `npm install` 需要拉 express + ws（共 66 个包） |

⚠️ **PATH 陷阱（最常见的坑）**：如果你的 node 来自 nvm、CLI 装在 `~/.local/bin` 之类的地方，
那么**非交互式 shell（cron / launchd / CI）里 PATH 通常不含它们**，会报 `command not found`
而且看不出原因。启动前显式导出：

```bash
export PATH="$HOME/.nvm/versions/node/<版本>/bin:$HOME/.local/bin:$PATH"
```

---

## 2. 先跑起来看看（3 分钟）

```bash
git clone git@github.com:HeQiliao12580/multiagent.git
cd multiagent
npm install
npm start
open http://localhost:3000
```

如果你**没有** qwen / kimi：服务照样能启动、界面照样能用，只是发消息 `@qwen` 时
会在聊天区看到一条错误提示（`spawn qwen ENOENT` 之类）。这是设计好的优雅降级，不是崩溃。
接下来按第 3 节换成你自己的 CLI。

界面上你会看到：

- **左侧深色侧边栏**：房间列表（每个房间有独立的历史、独立的工作目录、独立的 WebSocket）
  + 底部「⚙ Agent 管理」和「＋ 新建房间」
- **右侧聊天区**：消息流 + 输入框。用 `@名字` 召唤 Agent
- Agent 之间也能互相 `@`，形成协作链（顶部会出现「协作中… 第 N 轮」横幅和停止按钮）

---

## 3. 换成你自己的 CLI

一共四步：**生成 wrapper → 单独验证 → 登记白名单 → 界面上加 Agent**。

### 3.1 先摸清你的 CLI 怎么输出（别跳过这步）

各家 CLI 的流式输出格式**完全不同**，字段名、终止事件、审批机制都不一样。
先手动跑一次，把真实输出留下来，下一步给 AI 看：

```bash
# 以 qwen 为例。换成你的 CLI 和它对应的非交互/流式参数
qwen "say hi" --output-format stream-json --yolo > /tmp/probe.jsonl 2>&1
cat /tmp/probe.jsonl | head -20
```

重点看三件事：

1. **每行是什么结构**（`{"type":"assistant","message":{"content":[...]}}` 之类）
2. **哪个事件代表"回答完了"**（qwen 是 `type:"result"`）——wrapper 必须在这里收尾
3. **content 里有哪些块类型**（可能有 `thinking` / `tool_use` / `text`，只有 `text` 是回复）

### 3.2 用这段提示词让 AI 生成 wrapper

把下面整段发给任意编码助手，**把 `<xxx>` 换成你的 CLI 名，并把 3.1 探测到的真实输出贴进去**：

````text
我想写一个 Node.js 脚本，用 child_process.spawn() 调用 <xxx> CLI，并解析它的流式输出。

## 这是该 CLI 的真实输出样本（我实际跑出来的，请据此写解析，不要凭猜测）
<把 3.1 的输出粘贴在这里>

## 要求
1. 创建一个 `minimal-<xxx>.js` 文件
2. 使用 Node.js 原生的 `child_process.spawn()`
3. 使用 `readline` 模块逐行解析 stdout（每行是一个完整的 JSON 事件）
4. 解析 JSON，提取 `assistant` 类型事件中的文本内容
   注意：`message.content` 通常是**块数组**，可能混有 `thinking` / `tool_use` 等块，
   只取 `type === "text"` 的 `text` 字段
5. 收到终止事件（如 `result`）就立刻收尾，不要等子进程自己退出
6. 处理进程退出与错误

## 硬性契约（调用方依赖这些，务必逐条满足）
- 提示词从 `process.argv[2]` 读取，可能含空格和换行
- **最终回复写 stdout；所有诊断日志（初始化信息、工具调用、耗时统计）写 stderr**
  调用方会用 `2>/dev/null` 取回复，所以 stdout 必须是纯净的回复文本
- 成功时退出码 0，失败时非 0 并把原因写到 stderr
- spawn 子 CLI 时 `stdio` 用 `['ignore', 'pipe', 'pipe']`，避免子进程等 stdin 而挂住
- **不要用 `process.exit()` 收尾**：stdout 接管道时写入是异步的，立即退出会截断回复。
  正确做法是设置 `process.exitCode`、杀掉子进程，让事件循环自然排空后退出
- 收尾时用 `SIGKILL` 杀子进程（很多 CLI 收到 SIGTERM 只中止当前轮次、并不退出）
- 子 CLI 必须以非交互（headless）模式运行，不能期待 TTY；
  如果它默认需要人工审批工具调用，请显式传自动审批参数，并在注释里写清这意味着什么

## 运行方式
node minimal-<xxx>.js "你好，请用一句话介绍自己"

## 不需要
- 不需要 TypeScript
- 不需要任何 npm 依赖（纯原生 Node.js）
- 不需要错误重试（超时和降级由调用方处理）

## 交付
请附上：① 你从样本里识别出的事件类型清单；② 关键部分的代码解释；
③ 一条能验证「stdout 是纯净回复」的命令。
````

> 参考实现：仓库里的 `minimal-qwen.js` 就是这套契约的完整样板，
> 尤其看它收到 `result` 事件后的 `finish()` 收尾逻辑和那段解释"为什么不用 process.exit"的注释。

### 3.3 单独验证 wrapper（三条命令，务必都跑）

```bash
# ① 能跑通、退出码 0
node minimal-<xxx>.js "只回复两个字：收到"; echo "exit=$?"

# ② stdout 是纯净回复（诊断日志必须全在 stderr）
node minimal-<xxx>.js "只回复两个字：收到" 2>/dev/null

# ③ 不会挂着不退出：墙上时间应接近 CLI 自报的耗时
time node minimal-<xxx>.js "只回复一个字：好"
```

第 ③ 条很重要：如果 CLI 自报 2 秒但墙上时间几十秒甚至永不退出，说明它发完结果后
还在做别的事（qwen 就是这样，被 auto-memory 任务吊住 90s+）。wrapper 必须在收到
终止事件时主动 SIGKILL 子进程，否则后端每次调用都要白等。

### 3.4 登记到 SCRIPTS 白名单

编辑 `server.js` 顶部的 `SCRIPTS` 常量，加一行（或替换掉用不上的 qwen/kimi）：

```js
const SCRIPTS = [
  { id: 'qwen', path: './minimal-qwen.js', description: 'Qwen CLI 调用脚本' },
  { id: 'kimi', path: './minimal-kimi.js', description: 'Kimi CLI 调用脚本' },
  { id: 'claude', path: './minimal-claude.js', description: 'Claude CLI 调用脚本' },  // ← 加这行
];
```

- `id`：之后在界面下拉框里选的就是它，也是 `agents.json` 里存的值
- `path`：**仓库内相对路径**。这是刻意的安全设计——配置文件里只存 id 不存路径，
  所以改了 `agents.json` 也无法让后端 spawn 任意文件
- 删掉 qwen/kimi 也安全：首次启动会按新的 `SCRIPTS` 生成种子 Agent（没有调教过
  prompt 的 id 会得到一份通用模板，之后在界面里改）

然后重启后端：`npm start`。

### 3.5 在界面上加 Agent

1. 浏览器打开 `http://localhost:3000`（改过前端记得硬刷新 Cmd+Shift+R）
2. 侧边栏底部 **⚙ Agent 管理** → **＋ 新增 Agent**
3. 填表：
   - `name`：小写字母 / 数字 / 连字符，这就是以后 `@` 它用的名字
   - `description`：**一句话说明它擅长什么**。这段文字会出现在其他 Agent 的
     "可召唤的同伴"清单里，写清楚别人才知道什么时候该叫它
   - `role`：`executor`（动手实施）/ `reviewer`（质检）/ `coordinator`（分发汇总），
     选完自动填对应模板到 systemPrompt，可以再改
   - `script`：下拉里选你刚登记的 id
   - `systemPrompt`：支持 `{{name}}` / `{{peers}}` / `{{roomContext}}` 占位符
4. 点 **测试连接**（真 spawn 一次，传"请回复 OK"，默认 60s 超时）。
   **没通过之前保存按钮是灰的**
5. 保存 → 聊天区立刻多出 `@<name>` 芯片，其他 Agent 的同伴清单也立刻带上它

---

## 4. 调用层契约（wrapper 必须满足）

后端把每个 Agent 当同构的黑盒调用，只依赖这四条：

| 契约 | 说明 |
|---|---|
| `argv[2]` 收提示词 | 后端把拼好的完整 prompt 作为**单个参数**传入 |
| 回复写 **stdout** | 后端读 stdout 当作 Agent 的回复内容 |
| 日志写 **stderr** | 后端只在出错时把 stderr 尾部附在错误信息里 |
| 成功退出码 **0** | 非 0 视为失败，会广播 error 状态 |

另外两个后端已经替你处理好的行为，wrapper 不用管：

- **超时**：`AGENT_TIMEOUT_MS`（默认 300s）一个字节输出都没有就强杀进程组；
  `AGENT_IDLE_MS`（默认 60s）已收到文本后静默这么久就判定挂死并用现有输出降级返回
- **循环控制**：Agent 之间互相 `@` 受 `MAX_DEPTH`（默认 4）约束，不会死循环

---

## 5. 排错速查

| 现象 | 原因 | 处理 |
|---|---|---|
| 聊天区报 `spawn xxx ENOENT` | CLI 不在后端进程的 PATH 里 | 用第 1 节的 `export PATH=...` 启动；或在 wrapper 里写绝对路径 |
| 「测试连接」一直失败 | 超时太短（慢 CLI）或 wrapper 输出不合规 | `AGENT_TEST_TIMEOUT_MS=120000 npm start` 再试；跑 3.3 的三条命令定位 |
| 回复被截成半句 + 标了"降级" | wrapper 长时间无输出，`AGENT_IDLE_MS` 误判 | 调大：`AGENT_IDLE_MS=120000`；根治办法是让 wrapper 在思考期也打心跳到 stderr |
| 调用要几十秒才返回 | wrapper 在等子进程自己退出 | 按 3.3 第 ③ 条修：收到终止事件就 SIGKILL |
| stdout 里混进了日志 | wrapper 把诊断写到了 stdout | 改成 `console.error`，用 `2>/dev/null` 复验 |
| 启动报「种子配置非法」 | `agents.json` 里的 script id 不在 `SCRIPTS` 白名单 | 该条会被跳过并告警；确认 `SCRIPTS` 里登记了对应 id |
| `agents.json` 坏了 | 手改出错 | 服务会自动备份成 `agents.json.corrupt-<时间戳>` 并用默认配置重建 |
| 改了前端没生效 | 浏览器缓存 | 硬刷新 Cmd+Shift+R |

---

## 6. 验证命令清单

这些命令都不启动完整服务、大部分不花 token，改完代码建议跑一遍：

```bash
node server.js --test-mentions              # @ 解析自检（22 条断言，失败退出码 1）
node server.js --print-prompt qwen          # 打印实际拼给 Agent 的完整 prompt
node server.js --print-prompt qwen proj-a   # 指定房间
node scripts/agents-api-test.js             # Agent 管理 API 回归（22 条，需服务在跑）
node scripts/chain-watch.js <roomId> "@qwen 请让同伴创建 hello.txt"   # 观察一条协作链
node scripts/stop-chain-test.js             # 验证「停止协作」安全阀
node scripts/ui-check.js "http://localhost:3000/?room=room-default" \
  "document.querySelectorAll('.room-item').length>0" /tmp/ui.png     # 无头浏览器截图
```

调 prompt 时最有用的是 `DEBUG_PROMPT=1 npm start`：每次真实调用都会把完整 prompt
打到 stderr，能直接看到注入了哪些历史、同伴清单长什么样。

更多细节（多房间隔离、协作链机制、全部环境变量、已知坑）见 `README.md`。
