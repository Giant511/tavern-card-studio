/**
 * 卸载对话框的守卫（F14.1 / T10.22）。
 *
 * 为什么需要一份"读源文件"的测试：这两个对话框是 MSI 里的界面，改坏了**不会有
 * 任何东西变红** —— 单测不跑 MSI，`validate` 不看 wxs，连 `wix build` 都可能
 * 一声不响地把错误的行丢掉（T10.22 实测过两次：控件名写成 `Remove` 时那行
 * ControlEvent 凭空消失；`fragmentPaths` 里的 Property/CA/UI 整段被 linker 丢弃）。
 * 真正的兜底是 `build-msi.ps1` 第 4 步的"反编译断言"，但它只在打包时跑。
 *
 * 这里断言的是**意图**，与反编译断言互补：
 *   1. 复选框绑在 DELETEDATA 上，且这个属性没有任何初值（默认不勾 = 保守默认）；
 *   2. 卸载动作只在 `REMOVE="ALL" AND DELETEDATA=1` 时执行；
 *   3. 改道挂在 `RemoveButton` 上（写错名字等于没有这一页）；
 *   4. 两端（服务端 / 客户端）行为一致 —— 一处改了另一处没改，是最容易漏的；
 *   5. 客户端必须走模板接管而不是 fragmentPaths（片段补不了界面）。
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const repo = join(import.meta.dirname, '..');
const serverWxs = readFileSync(join(repo, 'installer', 'Product.wxs'), 'utf8');
const clientWxs = readFileSync(join(repo, 'client', 'src-tauri', 'wix', 'main.wxs'), 'utf8');
const clientConf = readFileSync(join(repo, 'client', 'src-tauri', 'tauri.conf.json'), 'utf8');
const uiText = readFileSync(join(repo, 'installer', 'ui-text.wxl'), 'utf8');

test('两端都有卸载选项对话框，且复选框都绑在 DELETEDATA 上', () => {
  for (const [label, wxs] of [
    ['server', serverWxs],
    ['client', clientWxs],
  ]) {
    assert.match(wxs, /<Dialog Id="DeleteDataDlg"/, `${label}: 缺少 DeleteDataDlg`);
    const check = wxs.match(/<Control Id="DeleteDataCheck"[\s\S]*?\/>/);
    assert.ok(check, `${label}: 缺少 DeleteDataCheck 控件`);
    assert.match(check[0], /Type="CheckBox"/, `${label}: 必须是复选框`);
    assert.match(check[0], /Property="DELETEDATA"/, `${label}: 复选框必须绑定 DELETEDATA`);
    assert.match(check[0], /CheckBoxValue="1"/, `${label}: 勾选值必须是 1`);
  }
});

test('DELETEDATA 只声明不给值 —— 默认不勾选', () => {
  for (const [label, wxs] of [
    ['server', serverWxs],
    ['client', clientWxs],
  ]) {
    const decl = wxs.match(/<Property Id="DELETEDATA"[^>]*\/>/);
    assert.ok(decl, `${label}: 缺少 DELETEDATA 声明`);
    // 有任何 Value 都意味着复选框可能默认勾上
    assert.doesNotMatch(decl[0], /Value=/, `${label}: DELETEDATA 不能带初值（默认必须不勾）`);
    assert.match(decl[0], /Secure="yes"/, `${label}: DELETEDATA 需要 Secure="yes" 才能进执行序列`);
  }
});

test('删除动作的条件与时序：只在卸载且勾选时执行，且在 RemoveFiles 之前', () => {
  for (const [label, wxs, action] of [
    ['server', serverWxs, 'DeleteDataDir'],
    ['client', clientWxs, 'DeleteClientDataDir'],
  ]) {
    // 条件有两种写法：WiX 5 用 Condition 属性，WiX 3 用元素正文。
    // 把整个 <Custom> 元素抓下来一起看，免得被写法差异绊住（同一条语义）。
    const seq = wxs.match(new RegExp(`<Custom Action="${action}"[\\s\\S]{0,400}?(?:</Custom>|/>)`));
    assert.ok(seq, `${label}: 执行序列里缺少 ${action}`);
    // 时序：必须在 RemoveFiles 之前（服务先停、数据先删、再删文件）。
    // 服务端把三者串成一条链：DeleteDataDir → CleanInstallResidue → RemoveFiles，
    // 所以 DeleteDataDir 的直接锚点是 CleanInstallResidue；客户端没有清理动作，直接锚 RemoveFiles。
    assert.match(
      seq[0],
      /Before="(RemoveFiles|CleanInstallResidue)"/,
      `${label}: 必须在 RemoveFiles 之前（服务先停、数据先删）`,
    );
    assert.match(seq[0], /REMOVE=/, `${label}: 条件必须限定 REMOVE`);
    assert.match(seq[0], /DELETEDATA=1/, `${label}: 条件必须要求 DELETEDATA=1`);

    // 动作本体：deferred + 不回滚。
    // 按 "&lt;CustomAction" 切片再挑出目标那个 —— 直接写正则会被属性换行
    // （Id 单独一行）绊住，那属于"读法不对"，不是被测代码有问题。
    const defs = wxs.split('<CustomAction').filter((chunk) => chunk.includes(`Id="${action}"`));
    assert.equal(defs.length, 1, `${label}: 应当恰好有一个 ${action} 定义`);
    const body = defs[0].slice(0, defs[0].indexOf('/>'));
    assert.match(body, /Execute="deferred"/, `${label}: 必须 deferred（要在脚本生成后执行）`);
    assert.match(body, /Return="ignore"/, `${label}: 删不掉不能让卸载失败并回滚`);
  }
});

test('卸载改道挂在 RemoveButton 上，且用 Order=2 压过 WiX 自带那条', () => {
  for (const [label, wxs] of [
    ['server', serverWxs],
    ['client', clientWxs],
  ]) {
    const publish = wxs.match(/<Publish Dialog="MaintenanceTypeDlg" Control="([^"]+)"[\s\S]*?Value="DeleteDataDlg"[\s\S]*?Order="(\d)"/);
    assert.ok(publish, `${label}: 缺少把 Remove 改道到 DeleteDataDlg 的 Publish`);
    // 控件名写错不会报错，只会静默失效 —— 这条断言就是为了防止"改回去"
    assert.equal(publish[1], 'RemoveButton', `${label}: 目标控件名必须是 RemoveButton（不是 Remove）`);
    assert.equal(publish[2], '2', `${label}: Order 必须是 2（WiX 自带那条是 1）`);
    // 反向：不能出现老写法
    assert.doesNotMatch(wxs, /Control="Remove"[^B]/, `${label}: 出现了 Control="Remove" 的老写法`);
  }
});

test('对话框的 Cancel 按钮有动作，不是死按钮', () => {
  for (const [label, wxs] of [
    ['server', serverWxs],
    ['client', clientWxs],
  ]) {
    const cancel = wxs.match(/<Control Id="Cancel"[\s\S]*?<\/Control>/);
    assert.ok(cancel, `${label}: 缺少 Cancel 按钮`);
    assert.match(cancel[0], /SpawnDialog" Value="CancelDlg"/, `${label}: Cancel 必须发布动作（ICE17）`);
  }
});

test('服务端完成页带数据目录位置；客户端把位置写在决策页', () => {
  // 服务端：改的是 WixUI 标准 ExitDialog 的正文（-loc 覆盖）
  assert.match(uiText, /ExitDialogDescription/);
  assert.match(uiText, /\[DATAFOLDER\]/);
  assert.match(uiText, /Codepage="65001"/, 'ui-text.wxl 必须显式 UTF-8，否则包里的中文会被 1252 拒掉');
  assert.match(serverWxs, /ui-text\.wxl|WixUILicenseRtf/);

  // 客户端：Dialog 表里的正文是编译期字面量，改不了标准 ExitDialog；
  // 因此"配置目录在哪、不勾选就保留"必须出现在 DeleteDataDlg 上
  const dlg = clientWxs.match(/<Dialog Id="DeleteDataDlg"[\s\S]*?<\/Dialog>/);
  assert.ok(dlg, '客户端缺少 DeleteDataDlg');
  assert.match(dlg[0], /%APPDATA%\\com\.taverncardstudio\.client/, '客户端对话框必须写明配置目录路径');
  assert.match(dlg[0], /NOT touched/i, '客户端对话框必须说明角色卡不被删除');
});

test('客户端走模板接管，不用 fragmentPaths（片段补不了界面）', () => {
  assert.match(clientConf, /"template":\s*"wix\/main\.wxs"/);
  assert.doesNotMatch(clientConf, /"fragmentPaths"/, 'fragmentPaths 只能补被引用的组件，界面/属性/动作会被丢弃');
  // 路径必须真的存在：写错的话 build 会退回 Tauri 自带模板，而那样对话框就没了
  const tpl = JSON.parse(clientConf).bundle.windows.wix.template;
  assert.ok(existsSync(join(repo, 'client', 'src-tauri', tpl)), `模板路径不存在：${tpl}`);
});

test('服务端 wiX UI 扩展入库且有版本与哈希记录', () => {
  const readme = readFileSync(join(repo, 'vendor', 'wixext', 'README.md'), 'utf8');
  assert.match(readme, /WixToolset\.UI\.wixext/);
  assert.match(readme, /sha256/i);
  assert.match(readme, /5\.0\.2/);
  // build-msi.ps1 里必须真的校验哈希，否则"入库"只是放了个文件
  const build = readFileSync(join(repo, 'installer', 'build-msi.ps1'), 'utf8');
  assert.match(build, /uiExtExpectedSha/);
  assert.match(build, /'-ext', \$wixExt/);
});

test('残留清理动作：调 CLI、不回滚、排成一条链', () => {
  // 这一段是"装配层"的守卫：清理逻辑本身由 test/uninstall-cleanup.test.mjs 真跑真删，
  // 这里只保证它被**正确挂进卸载流程**——挂错了同样不会报错（构建成功、
  // 反编译也没有这一条时，卸载就是"看起来跑了但没清"）。
  const action = serverWxs.match(/<CustomAction\s+Id="CleanInstallResidue"[\s\S]*?\/>/);
  assert.ok(action, '缺少 CleanInstallResidue 动作');
  assert.match(action[0], /Execute="deferred"/, '必须 deferred：要在脚本生成后执行');
  assert.match(action[0], /Impersonate="yes"/, '必须 impersonate：%ProgramData%/%TEMP% 才指向该用户');
  assert.match(action[0], /Return="ignore"/, '残留清不掉不能让卸载失败并回滚');
  assert.match(action[0], /cleanup --data-dir/, '必须调用 tcs-server 的 cleanup 子命令（白名单只有一份）');
  assert.match(action[0], /--event-log/, '数据被清时文件日志可能在 %TEMP%，事件日志是第二条线索');

  // 顺序链：DeleteDataDir → CleanInstallResidue → RemoveFiles。
  // WiX 不允许同一动作同时写 After+Before（WIX0035），所以只能靠链表达三元顺序。
  const dataSeq = serverWxs.match(/<Custom Action="DeleteDataDir"([^>]*)>/);
  assert.ok(dataSeq, '缺少 DeleteDataDir 序列行');
  assert.match(dataSeq[1], /Before="CleanInstallResidue"/, 'DeleteDataDir 必须排在清理之前');
  const residueSeq = serverWxs.match(/<Custom Action="CleanInstallResidue"([^>]*)>/);
  assert.ok(residueSeq, '缺少 CleanInstallResidue 序列行');
  assert.match(residueSeq[1], /Before="RemoveFiles"/, '清理必须在 RemoveFiles 之前');
  assert.doesNotMatch(dataSeq[1] + residueSeq[1], /After=".*".*Before=/, '同一动作不能同时写 After 与 Before');
  assert.match(residueSeq[1], /REMOVE=/, '清理只在卸载时跑（修复/升级不该动残留判定）');
});
