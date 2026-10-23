import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawnSync, spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { parseDevices, focusedApp, sanitizedNodes, preferredAbi } from './mac-support.mjs';

process.umask(0o077);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
process.chdir(root);
const [command = 'help', ...args] = process.argv.slice(2);
const envFile = path.join(root, '.env.mac');
function run(file, argv, options = {}) {
  const r = spawnSync(file, argv, {encoding:'utf8', timeout:60000, maxBuffer:12*1024*1024, ...options});
  if (r.error || r.status !== 0) throw new Error(`Не удалось выполнить ${path.basename(file)} ${argv.slice(0,2).join(' ')}. Проверьте установку и подключение устройства.`);
  return r.stdout || '';
}
function interactive(file, argv) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, argv, {stdio:'inherit', env:process.env});
    const forward = signal => { if (!child.killed) child.kill(signal); };
    const onInt = () => forward('SIGINT'), onTerm = () => forward('SIGTERM');
    process.on('SIGINT',onInt); process.on('SIGTERM',onTerm);
    const clean = () => { process.off('SIGINT',onInt); process.off('SIGTERM',onTerm); };
    child.once('error',e => {clean();reject(e);});
    child.once('exit',(code,signal) => {clean();if (code && !signal) reject(new Error(`Процесс завершён с кодом ${code}.`)); else resolve();});
  });
}
function configureEnvironment() {
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  process.env.ANDROID_HOME ||= process.env.ANDROID_SDK_ROOT || path.join(homedir(),'Library','Android','sdk');
  const bundledJdk = '/Applications/Android Studio.app/Contents/jbr/Contents/Home';
  if (!process.env.JAVA_HOME && existsSync(path.join(bundledJdk,'bin','java'))) process.env.JAVA_HOME = bundledJdk;
  if (!process.env.JAVA_HOME) { try { process.env.JAVA_HOME = run('/usr/libexec/java_home',[]).trim(); } catch {} }
  process.env.PATH = [process.env.JAVA_HOME && path.join(process.env.JAVA_HOME,'bin'), path.join(process.env.ANDROID_HOME,'platform-tools'),path.join(process.env.ANDROID_HOME,'emulator'),path.join(process.env.ANDROID_HOME,'cmdline-tools','latest','bin'),process.env.PATH].filter(Boolean).join(path.delimiter);
  let silicon = false;
  if (process.platform === 'darwin') { try {silicon = run('/usr/sbin/sysctl',['-n','hw.optional.arm64']).trim() === '1';} catch {} }
  process.env.ANDROID_SYSTEM_IMAGE ||= `system-images;android-35;google_apis_playstore;${preferredAbi(process.arch,silicon)}`;
}
function requireEnv() { if (!existsSync(envFile)) throw new Error('Сначала выполните bash setup-mac.sh'); }
function stopped() {
  const dir = path.resolve(process.env.DATA_DIR || './data-mac');
  if (existsSync(path.join(dir,'server.lock'))) throw new Error('Остановите кабинет (Ctrl+C в окне с npm run mac -- start) перед настройкой и чтением экранов.');
}
const adb = (...argv) => run(path.join(process.env.ANDROID_HOME,'platform-tools','adb'),argv);
async function choose(rl, items, label) {
  if (!items.length) throw new Error('Нет доступных вариантов.');
  items.forEach((item,i) => console.log(`${i+1}. ${label(item)}`));
  const n = Number(await rl.question('Введите номер: '));
  if (!Number.isInteger(n) || n<1 || n>items.length) throw new Error('Неверный номер. Запустите команду ещё раз.');
  return items[n-1];
}
async function device(rl) {
  const list = parseDevices(adb('devices','-l'));
  const online = list.filter(d => d.state === 'device');
  if (!online.length) throw new Error(list.some(d=>d.state==='unauthorized') ? 'Подтвердите USB-отладку на Android и повторите команду.' : 'Android не найден. Запустите эмулятор в Android Studio → Device Manager или подключите телефон с USB-отладкой.');
  console.log('Выберите Android с Kaspi Pay:');
  return choose(rl,online,d=>d.id);
}
function foreground(id) {
  try {return focusedApp(adb('-s',id,'shell','dumpsys','window','windows'));}
  catch {return focusedApp(adb('-s',id,'shell','dumpsys','activity','activities'));}
}
async function main() {
  configureEnvironment();
  if (command === 'prepare') {
    if (process.platform !== 'darwin') throw new Error('Подготовка предназначена для macOS.');
    if (!existsSync(envFile)) {
      const password = randomBytes(24).toString('base64url');
      const content = `NODE_ENV=development\nHOST=127.0.0.1\nPORT=3080\nPUBLIC_BASE_URL=http://127.0.0.1:3080\nDATA_DIR=./data-mac\nADMIN_PASSWORD=${password}\nENCRYPTION_KEY=${randomBytes(32).toString('base64')}\nDRIVER_MODE=android\nLIVE_AUTOMATION_ENABLED=false\nAPPIUM_URL=http://127.0.0.1:4723\nCONNECTOR_CONFIG=./config/android.mac.json\nPOLL_INTERVAL_MS=5000\nWEBHOOK_ALLOWED_ORIGINS=\n`;
      writeFileSync(envFile,content,{mode:0o600,flag:'wx'});
      console.log('Пароль локального кабинета (сохраните у себя):',password);
      process.loadEnvFile(envFile);
    } else console.log('.env.mac уже существует, настройки сохранены.');
    mkdirSync(path.resolve(process.env.DATA_DIR || './data-mac'),{recursive:true,mode:0o700});
    const connector = path.resolve(process.env.CONNECTOR_CONFIG || './config/android.mac.json');
    if (!existsSync(connector)) writeFileSync(connector,readFileSync('config/android.kaspi.example.json'),{mode:0o600,flag:'wx'});
    console.log('Режим Android подготовлен. Отправка счетов выключена до настройки реальных экранов.');
  } else if (command === 'doctor') {
    console.log('Node:',process.versions.node,'| Архитектура:',process.arch);
    console.log('Android SDK:',process.env.ANDROID_HOME);
    console.log('Образ для эмулятора:',process.env.ANDROID_SYSTEM_IMAGE);
    const checks = [
      ['ADB',()=>adb('version')],
      ['Java',()=>run('java',['-version'],{stdio:'pipe'})],
      ['Appium',()=>run('appium',['--version'])],
    ];
    for (const [name,check] of checks) {try {check();console.log(`${name}: найден`);} catch {console.log(`${name}: не найден / не запускается. См. docs/MAC_START.md`);}}
    try { const list=parseDevices(adb('devices','-l')); console.log('Android:',list.length ? list.map(d=>`${d.id} (${d.state})`).join(', ') : 'нет подключённого устройства'); } catch {}
  } else if (command === 'capture') {
    requireEnv();stopped();
    const rl = createInterface({input:process.stdin,output:process.stdout});
    try {
      const d = await device(rl);
      await rl.question('Откройте главный экран Kaspi Pay после входа кассира. Нажмите Enter. ');
      const app = foreground(d.id);
      console.log('Открыт пакет:',app.app_package);
      if ((await rl.question('Это установленное приложение Kaspi Pay? Введите да: ')).trim().toLowerCase() !== 'да') throw new Error('Откройте нужное приложение и повторите.');
      const connectorPath = path.resolve(process.env.CONNECTOR_CONFIG);
      const c = JSON.parse(readFileSync(connectorPath,'utf8'));
      if (c.verified === true) throw new Error('Этот коннектор уже настроен. Для диагностики используйте отдельную копию проекта.');
      if (c.app_package && c.app_package !== app.app_package) throw new Error('В конфигурации указан другой пакет. Проверьте выбранное приложение.');
      const report = {format:1,generated_at:new Date().toISOString(),...app,notes:'Тексты вне списка стандартных подписей скрыты. Скриншоты и серийный номер не включены.',screens:[]};
      const folder = path.join(root,'diagnostics');mkdirSync(folder,{recursive:true,mode:0o700});
      const file = path.join(folder,`kaspi-ui-${Date.now()}.json`);
      const screens = [
        ['home','Оставьте главный экран кассира. Enter — прочитать; s — пропустить: '],
        ['remote-form','Вручную откройте форму удалённого счёта. Ничего не отправляйте. Enter — прочитать; s — пропустить: '],
        ['history','Вручную откройте историю операций. Enter — прочитать; s — пропустить: '],
        ['details','Если есть своя существующая операция, откройте её детали. Enter — прочитать; s — пропустить: '],
      ];
      for (const [name,prompt] of screens) {
        if ((await rl.question(prompt)).trim().toLowerCase() === 's') continue;
        if (foreground(d.id).app_package !== app.app_package) throw new Error('Открыто другое приложение. Вернитесь в Kaspi Pay.');
        const remote = `/data/local/tmp/cashier-inspect-${randomUUID()}.xml`;
        try {
          adb('-s',d.id,'shell','uiautomator','dump',remote);
          const nodes = sanitizedNodes(adb('-s',d.id,'exec-out','cat',remote),app.app_package);
          report.screens.push({name,nodes});
          writeFileSync(file,JSON.stringify(report,null,2)+'\n',{mode:0o600});
          console.log(`Считано элементов: ${nodes.length}.`);
        } finally {try {adb('-s',d.id,'shell','rm','-f',remote);} catch {}}
      }
      if (!report.screens.length) throw new Error('Ни одного экрана не собрано.');
      // Capture the observed app only. No selectors or verified/live flags are inferred.
      writeFileSync(connectorPath,JSON.stringify({...c,...app},null,2)+'\n',{mode:0o600});
      console.log('Сохранено:',file);
      console.log('Проверьте JSON перед отправкой. Его можно приложить в чат для настройки коннектора.');
      console.log('Счета не создавались. Отправка остаётся выключенной.');
    } finally {rl.close();}
  } else if (command === 'bind') {
    requireEnv();stopped();
    const {loadConfig} = await import('../src/config.js');
    const {Store} = await import('../src/db.js');
    const {deviceSchema} = await import('../src/android-config.js');
    const store = new Store(loadConfig()), rl = createInterface({input:process.stdin,output:process.stdout});
    try {
      const merchants = store.merchants();
      if (!merchants.length) throw new Error('Сначала запустите npm run mac -- start, создайте компанию в кабинете, затем остановите сервер.');
      console.log('Выберите компанию:');const m = await choose(rl,merchants,m=>m.name);
      const d = await device(rl);
      const existing=store.session(m.id);
      if (existing) {
        if (existing.udid === d.id) {console.log('Устройство уже привязано.');return;}
        throw new Error('У компании уже есть другой Android. Используйте команду android bind из docs/ANDROID_SETUP.md для явной замены.');
      }
      const used = new Set(merchants.map(m=>store.session(m.id)?.system_port));
      let port=8200;while(used.has(port))port++;
      store.bindDevice(m.id,deviceSchema.parse({udid:d.id,system_port:port}));
      console.log('Android привязан. Вход кассира и готовность отправки ещё не подтверждены.');
    } finally {rl.close();store.close();}
  } else if (command === 'appium') {
    requireEnv();await interactive('appium',['--address','127.0.0.1','--port','4723','--log-level','warn']);
  } else if (command === 'start') {
    requireEnv();
    if(process.env.DRIVER_MODE !== 'android') throw new Error('Для Mac-подключения нужен DRIVER_MODE=android в .env.mac.');
    console.log('Локальный кабинет: http://127.0.0.1:3080. Пароль в .env.mac, поле ADMIN_PASSWORD.');
    await interactive(process.execPath,['src/server.js']);
  } else if (command === 'android' || command === 'connect') {
    requireEnv();await interactive(process.execPath,[`scripts/${command}.mjs`,...args]);
  } else console.log('Команды: npm run mac -- prepare | doctor | capture | bind | appium | start | android ... | connect MERCHANT_ID\nИнструкция: docs/MAC_START.md');
}
try {await main();} catch(e) {console.error(e.message);process.exitCode=1;}
