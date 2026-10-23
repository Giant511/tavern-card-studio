/**
 * 安装后说明页（installer/connect-guide.html）的内容守卫。
 *
 * 为什么需要它：这一页是用户装完服务端看到的**第一份指引**，而它不在任何
 * 构建链路上 —— 改代码不会让它变红，跑单测也不会。上一版就停在 v0.1.1 的
 * 单用户模型（"令牌是全权凭证"），而 0.1.2 起全局令牌已经被降权、
 * 账户体系成为主路径。**过时的第一指引比没有指引更坏**：用户会照着做，
 * 然后得出"功能坏了"的结论。
 *
 * 这里断言的是三类东西：
 *   1. 该讲的都在（三处命令、三种令牌、trustProxy、httpsPort）；
 *   2. 不该出现的不在（不存在的命令名、已失效的权限表述）；
 *   3. 版本号的每次出现都必须是"升级来源"语境，不能是"当前版本"。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const GUIDE = join(import.meta.dirname, '..', 'installer', 'connect-guide.html');
const html = readFileSync(GUIDE, 'utf8');

/** 去掉标签后取纯文本，用于按"行"检查语义（HTML 里的换行即段落边界） */
const lines = html
  .replace(/<style>[\s\S]*?<\/style>/g, '')
  .replace(/<br\s*\/?>/g, '\n')
  .replace(/<\/(p|li|tr|h2|h3|pre|div|section)>/g, '\n')
  .replace(/<[^>]+>/g, '')
  .replace(/&nbsp;/g, ' ')
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line !== '');

const text = lines.join('\n');

test('首步是创建管理员账户，且命令用真实的 tcs-server.cmd', () => {
  // 顺序也要对：创建账户必须出现在"两个地址"之前，否则用户会先抄地址再卡在登录
  const accountAt = html.indexOf('创建管理员账户');
  const addressAt = html.indexOf('两个地址');
  assert.ok(accountAt > 0, '缺少「创建管理员账户」一节');
  assert.ok(addressAt > accountAt, '创建账户必须排在「两个地址」之前（它是第一步）');

  assert.match(text, /user migrate/, '必须给出升级路径的迁移命令');
  assert.match(text, /user add/, '必须给出新建账户的命令');
  assert.match(text, /tcs-server\.cmd/, '命令必须写成产物里真实存在的 tcs-server.cmd');
  assert.match(text, /C:\\Program Files\\Tavern Card Studio Server/, '必须给出安装目录（命令要在里面跑）');
});

test('迁移命令必须说明它会接管旧卡并先备份', () => {
  // 这两句是升级用户唯一的心理保障：卡不会丢、库有人管
  assert.match(text, /接管/, '要说明历史卡片会被接管');
  assert.match(text, /默认仓库/, '要说明卡进的是默认仓库');
  assert.match(text, /备份/, '要说明动库前会备份');
  assert.match(text, /0\.1\.1/, '要点明这是 0.1.1 及更早版本升级上来的必经步骤');
  // 那条最容易踩的坑：不在安装目录跑就会另起空库
  assert.match(text, /另/, '要警告"绕过 tcs-server.cmd 会另算数据目录"');
  assert.match(text, /空库/, '要说明后果是一座空库（而不是泛泛说"可能出错"）');
});

test('三种令牌都讲到，且推荐的是账户令牌 / 仓库令牌', () => {
  for (const kind of ['账户令牌', '仓库令牌', '全局令牌']) {
    assert.ok(text.includes(kind), `缺少「${kind}」的说明`);
  }
  assert.match(text, /推荐/, '要给出推荐项（三类凭证需要用户做选择）');
  // 全局令牌降权是 0.1.2 的行为，必须写明白，否则用户会以为"看不到卡是 bug"
  assert.match(text, /看不到任何卡片/, '必须明说迁移后全局令牌看不到卡片');
  assert.match(text, /未归属|尚未归属/, '要解释全局令牌现在的可见范围');
});

test('客户端两步连接与「连接本机服务端」都在，且说清它不代替登录', () => {
  assert.match(text, /测试连接/, '两步连接的第二步不能丢');
  assert.match(text, /连接本机服务端/, '一键按钮的说明不能丢');
  assert.match(text, /不代替登录/, '必须说明一键连接只填地址与令牌、身份仍要登录');
  // 成功文案要与 client/src/net/server-probe.ts 一致：写「令牌有效」会让人在界面上找不到这句话
  assert.match(text, /已连接/, '要给出「测试连接」成功后看到的原文');
  assert.match(text, /token 有效/, '成功文案是「token 有效」，不是「令牌有效」');
  assert.match(text, /8730/, 'API 端口');
  assert.match(text, /8731/, '面板端口');
});

test('公网检查清单三条齐全：tls.mode / trustProxy / httpsPort', () => {
  assert.match(text, /tls\.mode/, '缺 tls.mode 选型');
  assert.match(text, /selfsigned|自签/, '缺自签模式说明');
  assert.match(text, /trustProxy/, '缺 trustProxy');
  assert.match(text, /不信任任何代理头/, '必须写明默认空 = 不信任任何代理头');
  assert.match(text, /127\.0\.0\.1/, '要给同机反代的登记值（否则用户不知道填什么）');
  assert.match(text, /httpsPort/, '缺"防火墙只暴露 httpsPort"');
  assert.match(text, /防火墙/, '缺防火墙这一条');
});

test('面板与 API 地址解耦（F7）有一句话说明', () => {
  assert.match(text, /解耦/, '0.1.2 起两者独立配置，要写一句');
});

test('不引用不存在的命令名：tcs-server 必须带 .cmd', () => {
  // 安装目录里只有 tcs-server.cmd / start-server.cmd，没有 tcs-server.exe
  const bare = lines.filter((line) => /tcs-server(?!\.cmd)/.test(line));
  assert.deepEqual(bare, [], `以下行用了不存在的命令名 tcs-server：\n${bare.join('\n')}`);
});

test('不引用不存在的面板页：面板没有「账户」页', () => {
  // 账户管理只有 CLI 与客户端的注册入口两条路（面板只有 总览/服务控制/参数配置/运行日志/API 与令牌）
  assert.ok(!/面板「账户」/.test(text), '面板没有「账户」页，别把用户指到不存在的地方');
});

test('「已生效代理数」必须指向总览页（它不在参数配置页）', () => {
  // 上一轮我在 README/docs/33/发布说明里都写成了「参数配置」页，实际渲染在总览。
  // 这条守卫是为了不再犯同一个错。
  const wrong = lines.filter((line) => /参数配置/.test(line) && /代理数|可信代理/.test(line));
  assert.deepEqual(wrong, [], `「已生效代理数」在总览页，不在参数配置页：\n${wrong.join('\n')}`);
  assert.match(text, /总览/, '要指出它在总览页');
});

test('版本号：0.1.1 只能作为"升级来源"出现，当前版本必须是 0.1.2', () => {
  assert.match(text, /0\.1\.2/, '页面上要标出这是 0.1.2 的流程');
  const stale = lines.filter(
    (line) => line.includes('0.1.1') && !/升级|更早版本|接管/.test(line),
  );
  assert.deepEqual(stale, [], `0.1.1 只应出现在升级语境里：\n${stale.join('\n')}`);
});

test('不残留 v0.1.1 时期的权限表述', () => {
  // 旧页写"令牌等于拥有服务端的全部操作权限" —— 0.1.2 起全局令牌已降权，这句是错的
  assert.ok(!text.includes('全部操作权限'), '全局令牌已降权，不能再写"全部操作权限"');
  assert.ok(!/首次取令牌用方式/.test(text), '旧的"取令牌三种方式"框架已被"三种令牌"取代');
});
