import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import os from 'node:os';
const { HistoryPolicy } = createRequire(import.meta.url)('../guard/policy.cjs');

export function configurePolicy(operation, filePath, password) {
  if (!['setup', 'reset'].includes(operation)) throw new Error('Unknown owner operation; use setup or reset');
  const policy = new HistoryPolicy({ filePath });
  return operation === 'setup' ? policy.configureOwner(password) : policy.reset(password);
}
function passwordPrompt(prompt) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return Promise.reject(new Error('Use an interactive terminal; passwords are never accepted as command arguments'));
  return new Promise((resolve, reject) => {
    let password = ''; const wasRaw = process.stdin.isRaw;
    process.stdout.write(prompt); process.stdin.setRawMode(true); process.stdin.resume();
    const finish = (error) => { process.stdin.removeListener('data', read); process.stdin.setRawMode(wasRaw); process.stdin.pause(); process.stdout.write('\n'); error ? reject(error) : resolve(password); };
    function read(data) {
      for (const char of data.toString('utf8')) {
        if (char === '\u0003') { finish(new Error('Cancelled')); return; }
        if (char === '\r' || char === '\n') { finish(); return; }
        if (char === '\u007f' || char === '\b') { password = password.slice(0, -1); continue; }
        if (char >= ' ' && password.length < 1024) password += char;
      }
    }
    process.stdin.on('data', read);
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    if (process.platform !== 'darwin') throw new Error('Owner setup must run on the Mac, with History Guard quit');
    if (process.argv.length !== 3 || !['setup', 'reset'].includes(process.argv[2])) throw new Error('Usage: npm run owner -- setup|reset');
    const file = path.join(os.homedir(), 'Library/Application Support/ChatGPT History Guard v2/history-policy-v2.json');
    const password = await passwordPrompt('Owner password (12+ characters, hidden): ');
    if (process.argv[2] === 'setup' && password !== await passwordPrompt('Repeat password (hidden): ')) throw new Error('Passwords did not match');
    if (!configurePolicy(process.argv[2], file, password)) throw new Error('Owner operation refused; check the password, existing configuration, or policy file');
    console.log(process.argv[2] === 'setup' ? 'Owner password configured. Launch History Guard.' : 'All approvals revoked. Relaunch History Guard.');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
