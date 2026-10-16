'use strict';
const fs = require('fs');
const path = require('path');
const {decompileCompiledProject} = require('../src/decompile');

const args = process.argv.slice(2);
const flags = new Set(args.filter(a => a.startsWith('--')));
const positional = args.filter(a => !a.startsWith('--'));

if (positional.length === 0) {
  console.error('用法: node bin/decompile-js.js <input.js|dir> [output.json] [--verbose]');
  process.exit(1);
}

const inputPath = positional[0];
const outputPath = positional[1] || null;
const verbose = flags.has('--verbose');


const jsFiles = [];
const st = fs.statSync(inputPath);
if (st.isDirectory()) {
  for (const f of fs.readdirSync(inputPath).sort()) {
    if (!f.endsWith('.js')) continue;
    jsFiles.push({name: f, path: path.join(inputPath, f)});
  }
} else {
  jsFiles.push({name: path.basename(inputPath), path: inputPath});
}

if (jsFiles.length === 0) {
  console.error('没找到任何 .js 文件');
  process.exit(1);
}

console.error(`[decompile-js] 发现 ${jsFiles.length} 个 JS 文件`);


const stageTarget = {
  isStage: true, name: 'Stage',
  variables: {}, lists: {}, broadcasts: {},
  blocks: {}, costumes: [], sounds: [], volume: 100, layerOrder: 0,
  currentCostume: 0, tempo: 60, videoTransparency: 50, videoState: 'on',
  textToSpeechLanguage: null
};

const spriteTarget = {
  isStage: false, name: 'Snippet',
  variables: {}, lists: {}, broadcasts: {},
  blocks: {}, costumes: [], sounds: [], volume: 100, layerOrder: 1,
  currentCostume: 0, visible: true, x: 0, y: 0, size: 100,
  direction: 90, draggable: false, rotationStyle: 'all around'
};

const hats = [];
const scripts = {};
let hatIdx = 0;
for (const js of jsFiles) {
  const hatId = `hat_${hatIdx++}`;
  hats.push({
    opcode: 'event_whenflagclicked',
    topBlockId: hatId,
    fieldsOfInputs: {},
    inputs: {}
  });
  const src = fs.readFileSync(js.path, 'utf8');
  console.error(`[decompile-js]   + ${js.name} (${src.length} chars)`);
  scripts[hatId] = {
    factorySource: src,
    factorySourceRaw: null
  };
}

const fakeCompiledProject = {
  targets: [stageTarget, spriteTarget],
  compiledTargets: {
    '1': { hats, scripts, procedures: {} }
  },
  monitors: [],
  extensions: [],
  extensionURLs: {},
  meta: {semver: '3.0.0', vm: '0.2.0'}
};


(async () => {
  const log = verbose
    ? (...a) => console.error('[decompile]', ...a)
    : () => {};

  const {projectJson} = await decompileCompiledProject(fakeCompiledProject, {log});

  const out = JSON.stringify(projectJson, null, 2);
  if (outputPath) {
    fs.writeFileSync(outputPath, out, 'utf8');
    console.error(`已写入 ${outputPath}`);
  } else {
    process.stdout.write(out);
  }
})().catch(e => {
  console.error('失败:', e);
  process.exit(1);
});