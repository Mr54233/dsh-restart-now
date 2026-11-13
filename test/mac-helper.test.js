// macOS 安全集成测试：只使用本测试创建的 sleep，绝不触碰 DSH 进程。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildHelperScript } from '../lib/helper-src.js';

test('macOS 助手拒绝与自身二进制不同的进程，即使配置的重启目标是该进程',
  { skip: process.platform !== 'darwin' }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsrn-identity-'));
    const main = spawn('/bin/sleep', ['60'], { stdio: 'ignore' });
    const host = spawn('/bin/sleep', ['60'], { stdio: 'ignore' });
    try {
      const ack = join(dir, 'ack');
      const log = join(dir, 'log');
      const receipt = join(dir, 'receipt');
      const helper = join(dir, 'helper.cjs');
      writeFileSync(helper, buildHelperScript({ platform: 'darwin', exe: '/bin/sleep',
        mainPid: main.pid, hostPid: host.pid, errLog: log, ack, receipt, probeTimeoutMs: 3000 }));
      const child = spawn(process.execPath, [helper], { stdio: 'ignore' });
      const code = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', resolve);
      });
      assert.equal(code, 0);
      assert.ok(existsSync(ack));
      assert.equal(JSON.parse(readFileSync(receipt, 'utf8')).failed.reason, 'identity-verification-failed');
      assert.match(readFileSync(log, 'utf8'), /identity/);
      assert.equal(main.exitCode, null);
      assert.equal(main.signalCode, null);
      assert.equal(host.exitCode, null);
      assert.equal(host.signalCode, null);
    } finally {
      main.kill('SIGKILL');
      host.kill('SIGKILL');
      rmSync(dir, { recursive: true, force: true });
    }
  });
