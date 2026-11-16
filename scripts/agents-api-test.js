'use strict';
// Agent 管理 阶段 2：管理 API 的回归测试。全部走 HTTP，不 spawn 真 Agent（除 /test 一次）。
// 用法：node scripts/agents-api-test.js
// 会自建一个临时 Agent「apitest」并在结束时删除，不污染 qwen/kimi。
const http = require('node:http');

const PORT = Number(process.env.PORT) || 3000;
let pass = 0;
let fail = 0;
const ok = (m) => { console.log('  ✅ ' + m); pass++; };
const no = (m) => { console.log('  ❌ ' + m); fail++; };
const check = (cond, m) => (cond ? ok(m) : no(m));

function req(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request(
      { host: 'localhost', port: PORT, path, method,
        headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {} },
      (res) => { let b = ''; res.on('data', (d) => (b += d));
        res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (_) {} resolve({ status: res.statusCode, body: j, raw: b }); }); }
    );
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

const GOOD = {
  name: 'apitest',
  description: 'API 测试用的临时 Agent',
  role: 'reviewer',
  systemPrompt: '你是 {{name}}，负责测试。{{peers}}',
  script: 'kimi',
  enabled: true,
};

(async () => {
  console.log('\n=== 1. 元数据接口 ===');
  let r = await req('GET', '/api/scripts');
  check(r.status === 200 && Array.isArray(r.body) && r.body.length >= 2, `GET /api/scripts -> ${r.status}，${r.body && r.body.length} 个脚本`);
  r = await req('GET', '/api/roles');
  check(r.status === 200 && r.body.length === 3 && r.body.every((x) => x.template.includes('{{name}}')),
    'GET /api/roles -> 3 个角色且模板含 {{name}}');

  console.log('\n=== 2. 新增校验 ===');
  r = await req('POST', '/api/agents', GOOD);
  check(r.status === 201 && r.body.name === 'apitest' && r.body.label === 'Apitest', `POST 合法配置 -> 201，label 派生为 ${r.body && r.body.label}`);
  r = await req('POST', '/api/agents', GOOD);
  check(r.status === 409, `重复 name -> 409（${r.body && r.body.error}）`);
  r = await req('POST', '/api/agents', { ...GOOD, name: 'Bad Name!' });
  check(r.status === 400, `非法 name -> 400（${r.body && r.body.error}）`);
  r = await req('POST', '/api/agents', { ...GOOD, name: 'evil', script: './../../etc/passwd' });
  check(r.status === 400, `script 不在预定义列表 -> 400（${r.body && r.body.error}）`);
  r = await req('POST', '/api/agents', { ...GOOD, name: 'evil', role: 'hacker' });
  check(r.status === 400, `非法 role -> 400`);
  r = await req('POST', '/api/agents', { ...GOOD, name: 'evil', enabled: 'yes' });
  check(r.status === 400, `enabled 非布尔 -> 400`);
  r = await req('POST', '/api/agents', { ...GOOD, name: 'evil', systemPrompt: '你好 {{peer}}' });
  check(r.status === 400 && /占位符/.test(r.body.error || ''), `未知占位符 -> 400（${r.body && r.body.error}）`);

  console.log('\n=== 3. 编辑 ===');
  r = await req('PUT', '/api/agents/apitest', { name: 'renamed' });
  check(r.status === 400, `改 name -> 400（${r.body && r.body.error}）`);
  r = await req('PUT', '/api/agents/apitest', { enabled: false });
  check(r.status === 200 && r.body.enabled === false, 'PUT enabled=false -> 200');
  r = await req('POST', '/api/rooms/room-default/messages', { text: '@apitest 在吗', dryRun: true });
  check(JSON.stringify(r.body.mentions) === '[]', `禁用后 @apitest 不再被路由（mentions=${JSON.stringify(r.body.mentions)}）`);
  r = await req('PUT', '/api/agents/apitest', { enabled: true });
  check(r.status === 200 && r.body.enabled === true, 'PUT enabled=true -> 200');
  r = await req('POST', '/api/rooms/room-default/messages', { text: '@apitest 在吗', dryRun: true });
  check(JSON.stringify(r.body.mentions) === '["apitest"]', `重新启用后 @apitest 可路由（mentions=${JSON.stringify(r.body.mentions)}）`);
  r = await req('PUT', '/api/agents/nope', { enabled: true });
  check(r.status === 404, 'PUT 不存在的 Agent -> 404');

  console.log('\n=== 4. 测试连接 ===');
  r = await req('POST', '/api/agents/test', { script: 'kimi', systemPrompt: 'x' });
  check(r.status === 200 && r.body.ok === true, `POST /api/agents/test kimi -> ok=${r.body && r.body.ok}，stdout="${r.body && String(r.body.stdout).slice(0, 30)}"`);
  r = await req('POST', '/api/agents/test', { script: 'nope' });
  check(r.status === 400, '测试连接传非法 script -> 400');

  console.log('\n=== 5. 删除 ===');
  r = await req('DELETE', '/api/agents/apitest');
  check(r.status === 200 && r.body.remaining === 2, `DELETE apitest -> 200，剩余 ${r.body && r.body.remaining}`);
  r = await req('DELETE', '/api/agents/apitest');
  check(r.status === 404, '重复删除 -> 404');
  r = await req('POST', '/api/rooms/room-default/messages', { text: '@apitest 在吗', dryRun: true });
  check(JSON.stringify(r.body.mentions) === '[]', '删除后 @apitest 不再被路由');

  console.log('\n=== 6. 收尾状态 ===');
  r = await req('GET', '/api/agents');
  const names = (r.body || []).map((a) => a.name).sort().join(',');
  check(names === 'kimi,qwen', `最终 Agent 列表回到 qwen,kimi（实为 ${names}）`);
  check((r.body || []).every((a) => typeof a.systemPrompt === 'string' && a.systemPrompt.length > 0), 'GET /api/agents 返回 systemPrompt 全文（管理面板需要）');

  console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
  process.exit(fail ? 1 : 0);
})();
