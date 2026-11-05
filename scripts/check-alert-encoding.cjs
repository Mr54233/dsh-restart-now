// 只读检查：验证「助手弹窗」那条编码链路（UTF-16LE base64 + -EncodedCommand）能正确往返中文。
// 与 lib/helper-src.js 里 alertUser 完全相同的编码方式，只把 MessageBox 换成写文件，不打扰用户。
// 该脚本只验证 Windows PowerShell 编码链路；macOS 上弹窗走 osascript，没有这条链路，直接跳过。
// 注意：/scripts/ 在 .gitignore 里，是否入库由仓库维护者决定。
if (process.platform !== 'win32') {
  console.log('skip: 该检查仅适用于 Windows PowerShell 编码链路（当前平台 ' + process.platform + '）');
  process.exit(0);
}
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const out = path.join(os.tmpdir(), 'dsrn-enc-check.txt');
try { fs.unlinkSync(out); } catch { /* 首次运行没有文件 */ }

const msg = '重启失败：新实例没能启动。请手动打开 DeepSeek Harness。日志：C:\\Temp\\x.err.log';
const quoted = "'" + String(msg).replace(/'/g, "''") + "'";
const shellScript = '[System.IO.File]::WriteAllText(' + JSON.stringify(out) + ', '
  + quoted + ', [System.Text.Encoding]::UTF8)';
const encoded = Buffer.from(shellScript, 'utf16le').toString('base64');

const result = spawnSync('powershell.exe',
  ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
  { encoding: 'utf8', windowsHide: true, timeout: 8000 });
console.log('exit', result.status, 'stderr', String(result.stderr || '').trim().slice(0, 200));

const back = fs.readFileSync(out, 'utf8').replace(/^\uFEFF/u, ''); // WriteAllText 会写 BOM，与弹窗无关
console.log('roundtrip-ok', back === msg);
console.log('got:', back);
