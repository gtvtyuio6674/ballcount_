import { readFile, access } from 'node:fs/promises';
import { spawn } from 'node:child_process';

// Cloudflare 배포 화면이 본인 계정에 DB를 먼저 생성하고 연결합니다.
const config = JSON.parse(await readFile(new URL('../wrangler.json', import.meta.url), 'utf8'));
const binding = config.d1_databases?.find(item => item.binding === 'DB');
if (!binding?.database_id || binding.database_id === '00000000-0000-4000-8000-000000000000') {
  throw new Error('DB 준비가 필요합니다. 시작하기.html 또는 GitHub Actions의 배포 시작 버튼으로 Cloudflare 배포를 진행해 주세요.');
}
await access(new URL('../dist/server/wrangler.json', import.meta.url));

async function wrangler(args) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['node_modules/wrangler/bin/wrangler.js', ...args], {
      stdio: 'inherit', env: { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false' },
    });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(`배포 단계 실패 (${code}). 위 오류 내용을 확인하세요.`)));
  });
}

// 마이그레이션은 원본 설정의 drizzle 폴더를 기준으로 적용합니다.
await wrangler(['d1', 'migrations', 'apply', 'DB', '--remote', '--config', 'wrangler.json']);
// 기존 Cloudflare 비밀 설정은 배포 시 보존됩니다.
await wrangler(['deploy', '--config', 'dist/server/wrangler.json']);
console.log('배포 완료. 공개 주소 뒤에 /admin을 붙여 관리자 등록을 진행하세요.');
