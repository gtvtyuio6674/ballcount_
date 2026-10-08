import { readFile, writeFile, rename, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

// pnpm run deploy: 기존 DB 확인 → 필요한 경우 생성 → 테이블 준비 → Worker 배포.
// Cloudflare의 빌드 인증 또는 로컬 Wrangler 로그인을 그대로 사용합니다.
// 토큰을 파일에 저장하지 않으며, DB 삭제/초기화 명령은 실행하지 않습니다.
const placeholder = '00000000-0000-4000-8000-000000000000';
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isRealId = value => typeof value === 'string' && value !== placeholder && uuidPattern.test(value);
const log = message => console.log('[볼카운트] ' + message);

async function readConfig(path, message) {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('일반 파일이 아닙니다.');
    const text = await readFile(path, 'utf8');
    const value = JSON.parse(text);
    if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('설정 형식이 잘못되었습니다.');
    return { path, text, value };
  } catch (error) {
    throw new Error(message + ' (' + error.message + ')');
  }
}

function getBinding(config) {
  const matches = config.value.d1_databases?.filter(item => item.binding === 'DB');
  if (!matches || matches.length !== 1) throw new Error('wrangler 설정에는 DB라는 D1 연결이 정확히 하나 있어야 합니다.');
  return matches[0];
}

async function saveConfig(config) {
  const text = JSON.stringify(config.value, null, 2) + '\n';
  if (text === config.text) return;
  const temporary = config.path + '.ballcount-' + process.pid + '.tmp';
  await writeFile(temporary, text, { flag: 'wx', mode: 0o600 });
  await rename(temporary, config.path);
}

function runWrangler(root, args, quiet = false) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(root, 'node_modules/wrangler/bin/wrangler.js'), ...args], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, CI: 'true', NO_COLOR: '1', WRANGLER_SEND_METRICS: 'false' },
    });
    let stdout = '';
    let stderr = '';
    let outputBytes = 0;
    let overflow = false;
    for (const [stream, output] of [[child.stdout, 'stdout'], [child.stderr, 'stderr']]) {
      stream.setEncoding('utf8');
      stream.on('data', chunk => {
        outputBytes += Buffer.byteLength(chunk);
        if (outputBytes > 8 * 1024 * 1024) {
          overflow = true;
          child.kill();
          return;
        }
        if (output === 'stdout') stdout += chunk;
        else stderr += chunk;
        if (!quiet) process[output].write(chunk);
      });
    }
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (overflow) return reject(new Error('배포 명령의 출력이 너무 큽니다. Cloudflare 로그를 확인해 주세요.'));
      resolve({ code: signal ? 1 : code ?? 1, stdout, stderr, quiet });
    });
  });
}

function requireSuccess(result, stage) {
  if (result.code === 0) return;
  if (result.quiet) {
    if (result.stdout) process.stderr.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
  }
  const output = result.stdout + '\n' + result.stderr;
  const permissionHint = /authentication|unauthorized|forbidden|permission|\b10000\b|\b9109\b/i.test(output)
    ? '\nCloudflare에서 이 Worker의 빌드에 사용하는 API 토큰을 확인하세요. D1 작업에는 Account → D1 → Edit 권한이 필요합니다. 토큰 값은 GitHub나 채팅에 올리지 마세요.'
    : '';
  throw new Error(stage + ' 단계가 실패했습니다. 위 Cloudflare 오류를 확인해 주세요.' + permissionHint);
}

function parseDatabaseList(output) {
  // --json 출력 앞에 경고가 붙어도 실제 JSON 배열만 해석합니다.
  const clean = output.replace(/\u001b\[[0-9;]*m/g, '').trim();
  const candidates = [clean];
  for (const match of clean.matchAll(/\n(?=\s*\[)/g)) candidates.push(clean.slice(match.index + 1).trim());
  for (const candidate of candidates) {
    try {
      const list = JSON.parse(candidate);
      if (Array.isArray(list) && list.every(item => item && typeof item.name === 'string' && isRealId(item.uuid))) return list;
    } catch { /* 다음 JSON 후보를 확인합니다. */ }
  }
  throw new Error('Cloudflare의 DB 목록 응답을 읽지 못했습니다. Wrangler 4.92.0이 설치되어 있는지 확인해 주세요.');
}

async function findDatabase(root, name) {
  const result = await runWrangler(root, ['d1', 'list', '--json', '--config', 'wrangler.json'], true);
  requireSuccess(result, 'DB 조회');
  const matches = parseDatabaseList(result.stdout).filter(item => item.name === name);
  if (matches.length > 1) throw new Error('같은 이름의 DB가 여러 개입니다. wrangler.json에 사용할 database_id를 지정해 주세요.');
  return matches[0];
}

export async function deploy(root) {
  const source = await readConfig(join(root, 'wrangler.json'), '프로젝트 최상위의 wrangler.json을 확인해 주세요.');
  const built = await readConfig(join(root, 'dist/server/wrangler.json'), '빌드 결과가 없습니다. Cloudflare Build command를 pnpm run build로 설정해 주세요.');
  const binding = getBinding(source);
  const builtBinding = getBinding(built);
  const name = binding.database_name;
  if (typeof name !== 'string' || !/^[A-Za-z0-9_-]+$/.test(name)) {
    throw new Error('DB의 database_name을 확인해 주세요. 기본 이름은 ballcount-db입니다.');
  }
  if (binding.database_id && binding.database_id !== placeholder && !isRealId(binding.database_id)) {
    throw new Error('database_id 형식이 잘못되었습니다. 기존 DB가 있다면 해당 DB의 실제 UUID를 설정해 주세요.');
  }
  if (isRealId(builtBinding.database_id) && builtBinding.database_id !== binding.database_id) {
    throw new Error('소스와 빌드 결과의 DB 설정이 다릅니다. pnpm run build 후 다시 배포해 주세요.');
  }

  let databaseId = binding.database_id;
  if (!isRealId(databaseId)) {
    log('DB 연결을 준비합니다: ' + name);
    let database = await findDatabase(root, name);
    if (!database) {
      log('새 D1 데이터베이스를 생성합니다: ' + name);
      const created = await runWrangler(root, [
        'd1', 'create', name, '--location', 'apac', '--update-config=false', '--config', 'wrangler.json',
      ], true);
      // 동시에 시작된 배포가 같은 DB를 만들었을 때만 기존 DB를 다시 확인합니다.
      if (created.code !== 0 && !/already exists|\b7502\b/i.test(created.stdout + created.stderr)) {
        requireSuccess(created, 'DB 생성');
      }
      database = await findDatabase(root, name);
      if (!database) throw new Error('DB 생성 후 연결 정보를 확인하지 못했습니다. 다시 배포하면 같은 이름으로 조회합니다.');
    } else {
      log('기존 D1 데이터베이스를 연결합니다: ' + name);
    }
    databaseId = database.uuid;
  } else {
    log('설정된 기존 DB 연결을 유지합니다.');
  }

  // 원본과 Vite 생성 설정을 함께 갱신해야 배포가 임시 번호를 참조하지 않습니다.
  binding.database_id = databaseId;
  builtBinding.database_id = databaseId;
  builtBinding.database_name = name;
  await saveConfig(source);
  await saveConfig(built);

  log('회원·포인트·경기 테이블을 준비합니다. 이미 적용된 변경은 건너뜁니다.');
  requireSuccess(await runWrangler(root, [
    'd1', 'migrations', 'apply', 'DB', '--remote', '--config', 'wrangler.json',
  ]), 'DB 테이블 준비');

  log('사이트를 배포합니다.');
  requireSuccess(await runWrangler(root, ['deploy', '--config', 'dist/server/wrangler.json']), '사이트 배포');
  log('배포 완료. 표시된 공개 주소의 /admin에서 관리자 등록을 진행하세요.');
}
