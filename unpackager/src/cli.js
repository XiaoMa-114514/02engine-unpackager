'use strict';

const fs = require('fs');
const path = require('path');
const {unpack} = require('./unpack');
const {buildSb3} = require('./sb3-builder');


let validateSb3 = null;
try {
  const v = require('./validate-sb3');
  validateSb3 = v && (v.validateSb3 || (typeof v === 'function' ? v : v.default)) || null;
} catch (e) {
  validateSb3 = null;
}

const USAGE = `o2-unpackager <input> [options]

Options:
  -o, --output <dir>        输出目录 ./output
  -t, --type <type>         强制类型：html|zip|electron|nwjs|webview|cordova|node-cli|auto
  --no-deobfuscate          跳过反混淆
  --deobfuscator <name>     反混淆库：webcrack|javascript-deobfuscator|none，默认webcrack
  --deobfuscate-retries <n> 反混淆失败时的重试次数，默认1
  --no-sb3                  不重建sb3，只导出 project.json + assets
  --keep-placeholders       保留未识别占位块（默认剥离到 comments）
  --keep-raw                保留原始factorySource
  --verbose                 详细日志
`;

const parseArgs = (argv) => {
  const args = {_: []};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-o' || a === '--output') args.output = argv[++i];
    else if (a === '-t' || a === '--type') args.type = argv[++i];
    else if (a === '--no-deobfuscate') args.deobfuscate = false;
    else if (a === '--deobfuscator') args.deobfuscator = argv[++i];
    else if (a === '--deobfuscate-retries') args.deobfuscateRetries = +argv[++i];
    else if (a === '--no-sb3') args.buildSb3 = false;
    else if (a === '--keep-placeholders') args.keepPlaceholders = true;
    else if (a === '--keep-raw') args.keepRaw = true;
    else if (a === '--verbose') args.verbose = true;
    else if (a === '-h' || a === '--help') args.help = true;
    else args._.push(a);
  }
  return args;
};

const main = async (argv) => {
  const args = parseArgs(argv);
  if (args.help || args._.length === 0) {
    console.log(USAGE);
    process.exit(0);
  }

  const input = args._[0];
  const output = args.output || './output';
  const type = args.type || 'auto';
  const deobfuscator = args.deobfuscator || 'webcrack';
  const shouldDeobfuscate = args.deobfuscate !== false && deobfuscator !== 'none';
  const shouldBuildSb3 = args.buildSb3 !== false;
  const deobfuscateRetries = Number.isFinite(args.deobfuscateRetries)
    ? args.deobfuscateRetries
    : 1;

  fs.mkdirSync(output, {recursive: true});

  const log = (...m) => { if (args.verbose) console.log('[o2]', ...m); };

  log('reading input', input);
  const buffer = fs.readFileSync(input);

  const result = await unpack(buffer, {
    type,
    log,
    shouldDeobfuscate,
    deobfuscator,
    deobfuscateRetries,
    keepRaw: args.keepRaw,
    outputDir: output
  });

  log('unpacked', result.summary);

  if (result.compiledProject) {
    fs.writeFileSync(
      path.join(output, 'compiled-project.json'),
      JSON.stringify(result.compiledProject, null, 2)
    );
  }
  if (result.projectZip) {
    fs.writeFileSync(path.join(output, 'project.zip'), result.projectZip);
  }
  if (result.originalProject) {
    fs.writeFileSync(path.join(output, 'original-project.bin'), result.originalProject);
  }

  if (result.projectJson && result.assets) {
    fs.mkdirSync(path.join(output, 'assets'), {recursive: true});
    for (const [name, data] of Object.entries(result.assets)) {
      fs.writeFileSync(path.join(output, 'assets', name), data);
    }
    fs.writeFileSync(
      path.join(output, 'project.json'),
      JSON.stringify(result.projectJson, null, 2)
    );

    if (shouldBuildSb3) {
      log('building sb3...');
      const sb3 = await buildSb3(result.projectJson, result.assets, {
        log,
        keepPlaceholders: args.keepPlaceholders
      });

      
      if (typeof validateSb3 === 'function') {
        try {
          const report = validateSb3(result.projectJson) || {};
          const problems = report.problems || report.errors || report.diffs || [];
          if (Array.isArray(problems) && problems.length > 0) {
            console.error(`[validate] ${problems.length} 处问题:`);
            for (const p of problems.slice(0, 20)) {
              const line = (typeof p === 'string') ? p : JSON.stringify(p);
              console.error(`[validate]   ${line}`);
            }
            if (problems.length > 20) {
              console.error(`[validate]   ...另有 ${problems.length - 20} 条`);
            }
            process.exitCode = 1;
          } else {
            log('validate ok');
          }
        } catch (e) {
          console.error(`[validate] 校验异常: ${e.message}`);
          process.exitCode = 1;
        }
      }

      fs.writeFileSync(path.join(output, 'rebuilt.sb3'), sb3);
      log('wrote rebuilt.sb3');
    }
  }

  console.log('Done. Output in', output);
};

module.exports = {main};