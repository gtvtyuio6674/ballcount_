import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, lstat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { spawn } from 'node:child_process';

// GitHub 업로드 과정에서 빠진 하위 폴더를 빌드 시작 전에 준비합니다.
// 소스 복구는 이미 존재하는 파일을 유지합니다. DB 준비는 deploy에서만 실행합니다.
const root = dirname(fileURLToPath(import.meta.url));
const command = process.argv[2] || 'restore';
const expectedHash = '40b8b1c13ed4aa7e097211aaafac0d7f748f4f7f71ec7dcdc1c024dcd52a40c6';
const rootFiles = new Set(['worker.ts', 'vite.config.ts', 'tsconfig.json', 'next.config.ts',
  'cloudflare-env.d.ts', 'drizzle.config.ts', 'postcss.config.mjs', 'pnpm-workspace.yaml']);
const sourceDirectories = new Set(['app', 'db', 'drizzle', 'public', 'scripts']);

function digest(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
async function info(path) {
  try { return await lstat(path); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function validatePath(path) {
  if (typeof path !== 'string' || path.includes('\\')) throw new Error('잘못된 소스 경로입니다.');
  const parts = path.split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) throw new Error('허용되지 않는 소스 경로입니다.');
  if (!rootFiles.has(path) && !(parts.length > 1 && sourceDirectories.has(parts[0]))) {
    throw new Error('복구 대상이 아닌 파일입니다: ' + path);
  }
  if (parts.some(part => part.startsWith('.env') || part.startsWith('.dev.vars'))) {
    throw new Error('비밀 설정 파일은 자동 복구하지 않습니다.');
  }
  return parts;
}
async function ensureParent(parts) {
  let current = root;
  for (const part of parts.slice(0, -1)) {
    current = join(current, part);
    let existing = await info(current);
    if (!existing) {
      await mkdir(current).catch(error => { if (error.code !== 'EEXIST') throw error; });
      existing = await info(current);
    }
    if (!existing?.isDirectory() || existing.isSymbolicLink()) {
      throw new Error('소스 폴더를 확인해 주세요: ' + parts.join('/'));
    }
  }
}

async function main() {
  if (!['build', 'dev', 'deploy', 'restore'].includes(command)) throw new Error('지원하지 않는 실행 명령입니다.');
  const payload = await readFile(join(root, 'source-backup.json.gz'));
  if (digest(payload) !== expectedHash) throw new Error('소스 묶음이 손상되었습니다. 패치 파일을 함께 다시 업로드해 주세요.');
  const manifest = JSON.parse(gunzipSync(payload, { maxOutputLength: 32 * 1024 * 1024 }).toString('utf8'));
  if (manifest.format !== 'ballcount-source-v1' || !Array.isArray(manifest.files) || manifest.files.length > 1000) {
    throw new Error('지원하지 않는 소스 묶음입니다.');
  }
  // 모든 경로와 내용을 먼저 확인한 후 파일을 씁니다.
  const seen = new Set();
  const entries = manifest.files.map(file => {
    const parts = validatePath(file.path);
    if (seen.has(file.path)) throw new Error('소스 경로가 중복되었습니다.');
    seen.add(file.path);
    const bytes = Buffer.from(file.data, 'base64');
    if (digest(bytes) !== file.sha256) throw new Error('소스 내용이 손상되었습니다: ' + file.path);
    return { path: file.path, parts, bytes };
  });
  let restored = 0;
  for (const file of entries) {
    await ensureParent(file.parts);
    const target = join(root, ...file.parts);
    const existing = await info(target);
    if (existing) {
      if (!existing.isFile() || existing.isSymbolicLink()) throw new Error('소스 파일을 확인해 주세요: ' + file.path);
      continue;
    }
    await writeFile(target, file.bytes, { flag: 'wx', mode: 0o644 });
    restored++;
  }
  for (const required of ['app/lib/kbo.ts', 'app/lib/server.ts', 'app/page.tsx', 'app/api/[...path]/route.ts']) {
    if (!(await info(join(root, required)))?.isFile()) throw new Error('필수 파일 준비에 실패했습니다: ' + required);
  }
  console.log(`[볼카운트] 소스 준비 완료: 누락 파일 ${restored}개 복구 / 확인 ${entries.length}개`);
  if (command === 'restore') return;
  if (command === 'deploy') {
    const { deploy } = await import('./cloudflare-deploy.mjs');
    await deploy(root);
    return;
  }
  const args = [join(root, 'node_modules/vinext/dist/cli.js'), command];
  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: root, stdio: 'inherit', env: process.env });
    child.on('error', reject);
    child.on('exit', (code, signal) => resolve(signal ? 1 : code ?? 1));
  });
  process.exitCode = Number(code);
}

main().catch(error => {
  console.error('[볼카운트] ' + error.message);
  process.exitCode = 1;
});
