// dsh-restart-now —— 重启前的守卫：活跃任务探测、插件安装锁、profile 目录解析
//
// 契约全部来自 DSH 0.2.1-rc.2 官方实现（asar 检索，见 docs/02 附录 A）：
//  - 任务探测：ctx.get('agents').list() → agent.status / agent.inbox.nextTurn / nextStep；
//    ctx.get('jobs').list(agentId | undefined) → job.status（running / stopping）。
//    官方函数 hasDesktopActiveTasks(liveAgents, jobs) 与这里逐条对齐。
//  - 安装锁：<profile>/.plugin-manager/run.json = {pid, grouped}，存活即代表插件安装/卸载正在进行。
//    官方对「解析失败」的处理是阻塞并要人删文件；我们在那种情况下记日志放行，
//    避免一次崩溃留下残锁让重启按钮永久失效（刻意偏离，已记录）。
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/** 解析当前 profile 目录：官方 profileContext 优先，其次环境变量，最后默认桌面路径。 */
export function resolveProfileDir(ctx, env = process.env) {
  try {
    const profileContext = ctx && typeof ctx.get === 'function' ? ctx.get('profileContext') : undefined;
    if (profileContext && typeof profileContext.dir === 'string' && profileContext.dir) return profileContext.dir;
  } catch (error) {
    /* 服务缺失继续兜底 */
  }
  if (env && env.DSH_PROFILE_DIR) return env.DSH_PROFILE_DIR;
  if (env && env.DSH_HOME) return join(env.DSH_HOME, 'profiles', env.DSH_PROFILE || 'desktop');
  if (env && env.USERPROFILE) return join(env.USERPROFILE, '.dsh', 'profiles', 'desktop');
  return '';
}

/**
 * 探测是否有会被重启打断的工作。
 *
 * 任何一步失败都返回 active:false —— 绝不因为探测本身出错而拒绝用户重启
 * （探测失败不等于有任务；拒绝的代价是按钮彻底不可用）。
 */
export function inspectActiveTasks(ctx) {
  const result = { available: false, active: false, tasks: 0, jobs: 0 };
  try {
    const agents = ctx && typeof ctx.get === 'function' ? ctx.get('agents') : undefined;
    const jobs = ctx && typeof ctx.get === 'function' ? ctx.get('jobs') : undefined;
    if (!agents || !jobs || typeof agents.list !== 'function' || typeof jobs.list !== 'function') return result;

    const liveAgents = agents.list() || [];
    result.available = true;

    const busyAgents = liveAgents.filter((agent) => {
      if (!agent) return false;
      if (agent.status === 'running') return true;
      const inbox = agent.inbox;
      if (!inbox) return false;
      const nextTurn = Array.isArray(inbox.nextTurn) ? inbox.nextTurn.length : 0;
      const nextStep = Array.isArray(inbox.nextStep) ? inbox.nextStep.length : 0;
      return nextTurn + nextStep > 0;
    });
    result.tasks = busyAgents.length;

    // 全局 roster（agent 缺省）+ 每个 agent 自己的 job。
    // 官方只用 .some() 取布尔，不关心计数；我们要在界面上显示「几个任务」，
    // 所以按 job.id（无 id 时按对象身份）去重——否则同一个 job 会被全局与 agent 两条路径各数一次。
    let busyJobs = 0;
    const seen = new Set();
    const rosters = [undefined].concat(liveAgents);
    for (const agent of rosters) {
      let list = [];
      try {
        list = jobs.list(agent ? agent.id : undefined) || [];
      } catch (error) {
        list = [];
      }
      for (const job of list) {
        if (!job || (job.status !== 'running' && job.status !== 'stopping')) continue;
        const key = job.id === undefined || job.id === null ? job : 'id:' + job.id;
        if (seen.has(key)) continue;
        seen.add(key);
        busyJobs += 1;
      }
    }
    result.jobs = busyJobs;
    result.active = busyAgents.length > 0 || busyJobs > 0;
  } catch (error) {
    return { available: false, active: false, tasks: 0, jobs: 0 };
  }
  return result;
}

/**
 * 探测插件安装锁（官方 .plugin-manager/run.json 契约）。
 * @param profileDir profile 目录
 * @param deps 可注入的 fs / kill，供单测替换
 */
export function inspectInstallLock(profileDir, deps = {}) {
  const exists = deps.exists || existsSync;
  const readFile = deps.readFile || ((path) => readFileSync(path, 'utf8'));
  const remove = deps.remove || ((path) => rmSync(path, { force: true }));
  const kill = deps.kill || ((pid) => process.kill(pid, 0));
  const warn = deps.warn || (() => {});

  if (!profileDir) return { locked: false };
  const runPath = join(profileDir, '.plugin-manager', 'run.json');
  try {
    if (!exists(runPath)) return { locked: false };
  } catch (error) {
    return { locked: false };
  }

  let record = null;
  try {
    record = JSON.parse(readFile(runPath));
  } catch (error) {
    warn('plugin install lock unreadable, ignoring: ' + runPath);
    return { locked: false, unreadable: true };
  }

  const pid = record && Number(record.pid);
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    warn('plugin install lock malformed, ignoring: ' + runPath);
    return { locked: false, unreadable: true };
  }

  let alive = false;
  try {
    kill(pid);
    alive = true;
  } catch (error) {
    alive = Boolean(error && error.code === 'EPERM');
  }

  if (alive) return { locked: true, pid };
  try {
    remove(runPath);
  } catch (error) {
    /* 删不掉也无所谓：下次判定同样会走「已死放行」 */
  }
  return { locked: false, stalePid: pid };
}
