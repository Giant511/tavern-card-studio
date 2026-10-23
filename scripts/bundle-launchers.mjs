/**
 * 绿色包/安装包里那两个 .cmd 启动器的**唯一来源**。
 *
 * 为什么要单独成模块：这两个脚本曾各写一份，结果行为不一致 ——
 * `start-server.cmd` 写死 `serve` 再把 `%*` 拼在最后，于是
 * `start-server.cmd user migrate Gez` 变成 `serve … user migrate Gez`：
 * **参数被静默丢掉，还顺手起了一个 supervisor**（2026-10-23 生产反馈）。
 * 抽出来之后，pack-server 只负责写盘，测试直接断言生成结果。
 *
 * 三条硬约束（都有测试）：
 *   1. **不写死子命令**：`%*` 决定跑什么；没有参数时 node 自己落到 `serve`；
 *   2. **默认值放在 `%*` 之前**：用户自己传的 `--config` 后写后生效；
 *   3. **纯 ASCII**：cmd.exe 按 OEM 代码页（本机 CP936）读脚本，
 *      UTF-8 中文注释打开就是乱码。
 */

/** 配置文件解析规则（两个脚本共用一个函数生成，避免漂移） */
const CONFIG_RESOLUTION = [
  'rem Config file resolution (env > installed MSI > green bundle):',
  'rem   1) TCS_CONFIG, if set, always wins',
  'rem   2) MSI layout: install-layout.ini sits next to this file -> %ProgramData%',
  'rem   3) green bundle -> %HERE%data\\config.json',
  'rem The marker is written by the MSI only; the green bundle has no such file.',
  'if not "%TCS_CONFIG%"=="" goto run',
  'if not exist "%HERE%install-layout.ini" goto green',
  'set "TCS_CONFIG=%ProgramData%\\TavernCardStudio\\config.json"',
  'goto run',
  ':green',
  'set "TCS_CONFIG=%HERE%data\\config.json"',
  ':run',
];

/**
 * 生成启动器脚本内容。
 *
 * @param {'start' | 'cli'} role
 *   `start` = start-server.cmd（无参数时启动服务，双击就是这个行为）
 *   `cli`   = tcs-server.cmd（纯 CLI 入口，服务端老包没有这个文件）
 */
export function buildLauncherCmd(role) {
  const header =
    role === 'start'
      ? [
          'rem Start the server, or run any CLI subcommand:',
          'rem   start-server.cmd                 -> serve (double-click behaviour)',
          'rem   start-server.cmd user migrate x  -> CLI, no supervisor is started',
        ]
      : [
          'rem CLI entry point (accounts, tokens, selfcheck, service control):',
          'rem   tcs-server.cmd user migrate admin',
          'rem   tcs-server.cmd selfcheck',
        ];

  return [
    '@echo off',
    'setlocal',
    'set "HERE=%~dp0"',
    'rem ASCII only: cmd.exe reads .cmd in the OEM code page (CP936 here),',
    'rem so UTF-8 Chinese comments would be garbled when opened.',
    ...header,
    ...CONFIG_RESOLUTION,
    'rem Defaults come BEFORE %* so a user-supplied --config (written later) wins.',
    'rem No hardcoded "serve" here: that is what silently ate the subcommand.',
    '"%HERE%node.exe" "%HERE%app\\server\\dist\\index.js" --config "%TCS_CONFIG%" --rules-dir "%HERE%app\\rules" %*',
    'exit /b %ERRORLEVEL%',
    '',
  ].join('\r\n');
}

/** MSI 布局标记文件的内容（安装包专用；绿色包不带这个文件） */
export const INSTALL_LAYOUT_MARKER = [
  '; Written by the Tavern Card Studio Server MSI.',
  '; Its presence tells the .cmd launchers to use the ProgramData layout.',
  'layout=msi',
  'dataDir=C:\\ProgramData\\TavernCardStudio',
  '',
].join('\r\n');
