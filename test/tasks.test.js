// test/tasks.test.js —— v1.1 守卫：活跃任务探测 / 插件安装锁 / profile 目录解析
//
// 契约来源：DSH 0.2.1-rc.2 官方实现
//   hasDesktopActiveTasks(liveAgents, jobs) —— agent.status==='running'、inbox.nextTurn/nextStep
//   非空、jobs.list(agentId|undefined) 里 status 为 running/stopping。
// 设计原则：探测失败一律当作「没有活跃任务」——拒绝重启的代价是按钮彻底不可用，
// 远比偶尔打断一个任务严重。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectActiveTasks, inspectInstallLock, resolveProfileDir } from '../lib/tasks.js';

const ctxWith = (services) => ({ get: (name) => services[name] });
const agent = (over = {}) => ({ id: 'a1', status: 'idle', inbox: { nextTurn: [], nextStep: [] }, ...over });
const jobsStub = (map) => ({ list: (id) => map[id || 'global'] || [] });

test('U16a 无服务 → available:false 且不拒绝（绝不因探测失败拒绝用户）', () => {
  assert.deepEqual(inspectActiveTasks(ctxWith({})), { available: false, active: false, tasks: 0, jobs: 0 });
  assert.deepEqual(inspectActiveTasks({ get() { return undefined; } }), { available: false, active: false, tasks: 0, jobs: 0 });
  assert.deepEqual(inspectActiveTasks(null), { available: false, active: false, tasks: 0, jobs: 0 });
});

test('U16b 空 roster → 空闲', () => {
  const info = inspectActiveTasks(ctxWith({
    agents: { list: () => [] },
    jobs: jobsStub({}),
  }));
  assert.deepEqual(info, { available: true, active: false, tasks: 0, jobs: 0 });
});

test('U16c agent.status === running → 活跃（官方判定第一条）', () => {
  const info = inspectActiveTasks(ctxWith({
    agents: { list: () => [agent({ status: 'running' })] },
    jobs: jobsStub({}),
  }));
  assert.equal(info.active, true);
  assert.equal(info.tasks, 1);
});

test('U16d inbox.nextTurn / nextStep 非空 → 活跃（排队中的消息同样会被打断）', () => {
  for (const key of ['nextTurn', 'nextStep']) {
    const info = inspectActiveTasks(ctxWith({
      agents: { list: () => [agent({ inbox: { nextTurn: [], nextStep: [], [key]: [{}] } })] },
      jobs: jobsStub({}),
    }));
    assert.equal(info.active, true, `${key} 排队须视为活跃`);
    assert.equal(info.tasks, 1);
  }
});

test('U16e job running / stopping → 活跃；queued 不算', () => {
  // 真实 jobs 一定带 id：全局 roster 与 agent 视角会返回同一个 job 对象，计数须去重
  const running = inspectActiveTasks(ctxWith({
    agents: { list: () => [agent()] },
    jobs: { list: () => [{ id: 'j1', status: 'running' }] },
  }));
  assert.deepEqual([running.active, running.jobs], [true, 1]);

  const stopping = inspectActiveTasks(ctxWith({
    agents: { list: () => [agent()] },
    jobs: { list: () => [{ id: 'j1', status: 'stopping' }] },
  }));
  assert.deepEqual([stopping.active, stopping.jobs], [true, 1]);

  const queued = inspectActiveTasks(ctxWith({
    agents: { list: () => [agent()] },
    jobs: { list: () => [{ id: 'j1', status: 'queued' }] },
  }));
  assert.deepEqual([queued.active, queued.jobs], [false, 0]);

  // 两个不同 agent 各自的 job：全局视角 + 各自视角都能看到，但计数应为 2 而非更多
  const twoAgents = inspectActiveTasks(ctxWith({
    agents: { list: () => [agent({ id: 'a1' }), agent({ id: 'a2' })] },
    jobs: { list: (id) => (id === undefined ? [] : [{ id: 'j-' + id, status: 'running' }]) },
  }));
  assert.deepEqual([twoAgents.active, twoAgents.jobs], [true, 2]);
});

test('U16f 服务抛异常 → 降级为「无活跃任务」，不冒泡', () => {
  const info = inspectActiveTasks(ctxWith({
    agents: { list: () => { throw new Error('boom'); } },
    jobs: { list: () => [] },
  }));
  assert.deepEqual(info, { available: false, active: false, tasks: 0, jobs: 0 });

  const jobsThrow = inspectActiveTasks(ctxWith({
    agents: { list: () => [agent()] },
    jobs: { list: () => { throw new Error('boom'); } },
  }));
  assert.equal(jobsThrow.active, false, 'jobs 抛错不应让整个探测变成「活跃」');
});

test('U16g resolveProfileDir 优先级：profileContext > DSH_PROFILE_DIR > DSH_HOME > USERPROFILE', () => {
  assert.equal(
    resolveProfileDir(ctxWith({ profileContext: { name: 'desktop', dir: 'D:\\p' } }),
      { DSH_PROFILE_DIR: 'D:\\env', DSH_HOME: 'D:\\h', USERPROFILE: 'D:\\u' }),
    'D:\\p',
  );
  assert.equal(resolveProfileDir(ctxWith({}), { DSH_PROFILE_DIR: 'D:\\env', DSH_HOME: 'D:\\h' }), 'D:\\env');
  assert.equal(resolveProfileDir(ctxWith({}), { DSH_HOME: 'D:\\h', DSH_PROFILE: 'web' }),
    join('D:\\h', 'profiles', 'web'));
  assert.equal(resolveProfileDir(ctxWith({}), { USERPROFILE: 'D:\\u' }),
    join('D:\\u', '.dsh', 'profiles', 'desktop'));
  assert.equal(resolveProfileDir(ctxWith({}), {}), '');
});

test('U17a 安装锁：文件缺失 → 未锁', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsrn-lock-'));
  try {
    assert.deepEqual(inspectInstallLock(dir, { exists: () => false }), { locked: false });
    assert.deepEqual(inspectInstallLock(''), { locked: false }, '无 profile 目录时不阻塞');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('U17b 安装锁：pid 存活 → locked（安装进行中须硬拦）', () => {
  const lock = inspectInstallLock('D:\\p', {
    exists: () => true,
    readFile: () => JSON.stringify({ pid: 4242, grouped: false }),
    kill: () => { /* 不抛 = 存活 */ },
  });
  assert.deepEqual(lock, { locked: true, pid: 4242 });
});

test('U17c 安装锁：pid 已死 → 清掉残锁并放行（避免崩溃残锁永久锁死按钮）', () => {
  let removed = '';
  const lock = inspectInstallLock('D:\\p', {
    exists: () => true,
    readFile: () => JSON.stringify({ pid: 4242 }),
    kill: () => { const error = new Error('gone'); error.code = 'ESRCH'; throw error; },
    remove: (path) => { removed = path; },
  });
  assert.equal(lock.locked, false);
  assert.equal(lock.stalePid, 4242);
  assert.ok(removed.endsWith('run.json'), '须删除已失效的 run.json');
});

test('U17d 安装锁：EPERM 视为存活（进程存在但无权限查询）', () => {
  const lock = inspectInstallLock('D:\\p', {
    exists: () => true,
    readFile: () => JSON.stringify({ pid: 9 }),
    kill: () => { const error = new Error('denied'); error.code = 'EPERM'; throw error; },
  });
  assert.equal(lock.locked, true);
});

test('U17e 安装锁：文件损坏 / 记录畸形 → 记日志并放行（刻意偏离官方「要求人工删除」）', () => {
  const warnings = [];
  const corrupt = inspectInstallLock('D:\\p', {
    exists: () => true,
    readFile: () => '{ not json',
    warn: (message) => warnings.push(message),
  });
  assert.deepEqual(corrupt, { locked: false, unreadable: true });

  const malformed = inspectInstallLock('D:\\p', {
    exists: () => true,
    readFile: () => JSON.stringify({ pid: 'nope' }),
    warn: (message) => warnings.push(message),
  });
  assert.equal(malformed.locked, false);
  assert.equal(warnings.length, 2, '两种情况都须留痕');
});

test('U17f 真机形态：用本进程 pid 写 run.json → 判为安装中', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsrn-lock-real-'));
  try {
    mkdirSync(join(dir, '.plugin-manager'), { recursive: true });
    writeFileSync(join(dir, '.plugin-manager', 'run.json'), JSON.stringify({ pid: process.pid, grouped: false }));
    assert.ok(existsSync(join(dir, '.plugin-manager', 'run.json')));
    const lock = inspectInstallLock(dir);
    assert.deepEqual(lock, { locked: true, pid: process.pid });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
