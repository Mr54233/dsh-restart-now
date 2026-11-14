// test/close-helper.test.js —— v1.3.1 仅关闭：helper 生成的 close 形态绝不拉起（静态断言，不执行脚本）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildHelperScript } from '../lib/helper-src.js';

const OPTS = {
  win32: { exe: 'C:/x/DeepSeek Harness.exe', errLog: 'C:/t/e.log', ack: 'C:/t/a.ack', receipt: 'C:/t/r.json' },
  darwin: { exe: '/Applications/DSH.app/Contents/MacOS/DSH', errLog: '/tmp/e.log', ack: '/tmp/a.ack', receipt: '/tmp/r.json' },
};

for (const platform of ['win32', 'darwin']) {
  test(`U30-${platform} close 助手：分支在拉起段之前、之间零 spawn、ACTION/STAMP 常量正确`, () => {
    const s = buildHelperScript({ platform, mainPid: 1234, hostPid: 567, ...OPTS[platform], action: 'close', stamp: 'S-CLOSE' });
    const closeBranch = s.indexOf("if (ACTION === 'close') {");
    const respawnAt = s.indexOf('  // ④ 拉起新实例');
    assert.ok(closeBranch >= 0 && respawnAt > 0, 'close 分支与拉起段都必须存在');
    assert.ok(closeBranch < respawnAt, 'close 分支必须先于拉起段（return 之后才会轮到拉起）');
    assert.doesNotMatch(s.slice(closeBranch, respawnAt), /spawn\s*\(/, 'close 分支与拉起段之间不得出现 spawn');
    assert.ok(s.includes('const ACTION = "close"'));
    assert.ok(s.includes('const STAMP = "S-CLOSE"'), 'stamp 必须传给助手（回执防污染判据）');
    assert.ok(s.includes('closedAt'), 'close 成功写 closedAt 回执');
    // 语法合法（把 require 替换后整体 parse）
    assert.doesNotThrow(() => new Function(s.replace(/require\s*\([^)]*\)/g, '({})')));
  });

  test(`U31-${platform} 不带 action 默认 restart 形态不变；回执写入带 stamp 核对`, () => {
    const s = buildHelperScript({ platform, mainPid: 1234, hostPid: 567, ...OPTS[platform], stamp: 'S-R' });
    assert.ok(s.includes('const ACTION = "restart"'), '默认动作仍是 restart（向后兼容）');
    assert.ok(s.includes('current.stamp !== STAMP'), '回执写入前必须核对 stamp（防旧助手污染）');
    // close/restart 共用同一 writeReceipt 函数体（stamp 核对逻辑一份）
    const close = buildHelperScript({ platform, mainPid: 1234, hostPid: 567, ...OPTS[platform], action: 'close', stamp: 'S-C' });
    assert.ok((close.match(/current\.stamp !== STAMP/g) || []).length === 1, 'stamp 核对恰好一处（writeReceipt 内）');
  });
}

for (const platform of ['win32', 'darwin']) {
  test(`非 ASCII 路径可安全嵌入 ${platform} 助手脚本`, () => {
    const paths = platform === 'win32'
      ? { exe: 'C:\\用户\\测试 空间\\DeepSeek Harness.exe', errLog: 'C:\\临时\\错误.log', ack: 'C:\\临时\\确认.ack', receipt: 'C:\\用户\\回执.json' }
      : { exe: '/应用程序/测试 空间/DSH.app/Contents/MacOS/DSH', errLog: '/临时/错误.log', ack: '/临时/确认.ack', receipt: '/用户/回执.json' };
    for (const action of ['close', 'restart']) {
      const script = buildHelperScript({ platform, mainPid: 1234, hostPid: 567, ...paths, action });
      for (const [name, value] of Object.entries({ EXE: paths.exe, ERR_LOG: paths.errLog, ACK: paths.ack, RECEIPT: paths.receipt })) {
        assert.ok(script.includes(`const ${name} = ${JSON.stringify(value)};`), `${name} 路径必须完整转义并保留`);
      }
      assert.doesNotThrow(() => new Function(script), '生成的助手脚本必须能解析');
    }
  });
}

test('U32 close 成功回执经 summarizeReceipt 呈现为 closed（含 host 未退的失败形态）', async () => {
  const { summarizeReceipt } = await import('../lib/receipt.js');
  assert.equal(summarizeReceipt({ action: 'close', closedAt: 't' }).status, 'closed');
  assert.equal(summarizeReceipt({ action: 'close', closedAt: 't', failed: { reason: 'host-not-stopped' } }).status, 'failed');
  assert.equal(summarizeReceipt({ action: 'close' }).status, 'unconfirmed');
  // 旧版回执（无 action 键）不受影响
  assert.equal(summarizeReceipt({ respawnedAt: 'x', downtimeMs: 1 }).status, 'ok');
});
