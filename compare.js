'use strict';

const fs = require('fs');
const path = require('path');
const {execFileSync} = require('child_process');
const os = require('os');

const args = process.argv.slice(2);
const fileA = args[0];
const fileB = args[1];
const verbose = args.includes('--verbose');
let targetFilter = null;
const ti = args.indexOf('--target');
if (ti >= 0) targetFilter = args[ti + 1];

if (!fileA || !fileB) {
  console.error('用法: node compare.js <original.sb3> <rebuilt.sb3> [--verbose] [--target "角色名"]');
  process.exit(1);
}

// 解压project.json
const readProjectJson = (sb3Path) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbdiff-'));
  try {
    let used = false;
    try {

      execFileSync('unzip', ['-o', '-q', sb3Path, 'project.json', '-d', tmpDir], {stdio: 'ignore'});
      used = true;
    } catch (e) {}
    if (!used) {
      try {
        const AdmZip = require('adm-zip');
        const zip = new AdmZip(sb3Path);
        const entry = zip.getEntry('project.json');
        if (!entry) throw new Error('no project.json in zip');
        const buf = entry.getData();
        return JSON.parse(buf.toString('utf8'));
      } catch (e) {
        throw new Error('无法解压sb3');
      }
    }
    const p = path.join(tmpDir, 'project.json');
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } finally {
    try { fs.rmSync(tmpDir, {recursive: true, force: true}); } catch (e) {}
  }
};

const jsonA = readProjectJson(fileA);
const jsonB = readProjectJson(fileB);

// 工具函数
const sortKeys = (obj) => {
  if (!obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(sortKeys);
  const out = {};
  for (const k of Object.keys(obj).sort()) out[k] = sortKeys(obj[k]);
  return out;
};

const stableStringify = (obj) => JSON.stringify(sortKeys(obj), null, 2);

const shortId = (id) => (typeof id === 'string' && id.length > 12) ? id.slice(0, 6) + '..' + id.slice(-4) : id;

// 把内联常量和影子块引用收敛成同一个key
const isPrimitiveShadow = (b) => {
  if (!b || typeof b !== 'object') return false;
  return b.opcode === 'math_number' || b.opcode === 'text' || b.opcode === 'colour_picker';
};

const shadowToLiteral = (b) => {
  if (!b || !b.fields) return null;
  if (b.opcode === 'math_number' && b.fields.NUM !== undefined) {
    const v = Array.isArray(b.fields.NUM) ? b.fields.NUM[0] : b.fields.NUM;
    return JSON.stringify([4, String(v)]);
  }
  if (b.opcode === 'text' && b.fields.TEXT !== undefined) {
    const v = Array.isArray(b.fields.TEXT) ? b.fields.TEXT[0] : b.fields.TEXT;
    return JSON.stringify([10, String(v)]);
  }
  if (b.opcode === 'colour_picker' && b.fields.COLOUR !== undefined) {
    const v = Array.isArray(b.fields.COLOUR) ? b.fields.COLOUR[0] : b.fields.COLOUR;
    return JSON.stringify([9, String(v)]);
  }
  return null;
};


const normalizeValue = (v, blocks) => {
  if (Array.isArray(v)) {
    if (v.length >= 2 && typeof v[0] === 'number') {
      const tag = v[0];

      if (tag === 1) {
        const inner = v[1];
        if (Array.isArray(inner)) {
          return [1, 'lit:' + JSON.stringify(inner)];
        }
        if (typeof inner === 'string' && blocks && blocks[inner]) {
          const b = blocks[inner];
          const lit = shadowToLiteral(b);
          if (lit !== null) return [1, 'lit:' + lit];
          return [1, 'shadow:' + b.opcode + ':' + JSON.stringify(sortKeys(b.fields || {}))];
        }
        return [1, 'lit:' + JSON.stringify(inner)];
      }

      // 保留子块opcode
      if (tag === 2) {
        const innerId = v[1];
        const b = blocks && blocks[innerId];
        return [2, b ? b.opcode : '(block)'];
      }
      if (tag === 3) {
        const innerId = v[1];
        const b = blocks && blocks[innerId];
        return [3, b ? b.opcode : '(block)', ...v.slice(2).map(x => normalizeValue(x, blocks))];
      }
      return v.map(x => normalizeValue(x, blocks));
    }
    return v.map(x => normalizeValue(x, blocks));
  }
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v)) out[k] = normalizeValue(v[k], blocks);
    return out;
  }
  return v;
};

// [name]或[name, id]统一成[name]
const normalizeField = (v) => {
  if (Array.isArray(v) && v.length >= 1) return [v[0]];
  return v;
};


const normalizeProceduresMutation = (b) => {
  const mutation = b.mutation || {};
  if (b.opcode !== 'procedures_call' && b.opcode !== 'procedures_prototype') {
    return {inputs: b.inputs || {}, mutation};
  }

  let argIds = [];
  try { argIds = JSON.parse(mutation.argumentids || '[]'); } catch (e) {}
  if (!Array.isArray(argIds)) argIds = [];

  const posById = {};
  argIds.forEach((id, i) => { posById[id] = 'A' + i; });

  const remappedInputs = {};
  for (const [k, v] of Object.entries(b.inputs || {})) {
    remappedInputs[posById[k] || k] = v;
  }

  return {
    inputs: remappedInputs,
    mutation: {
      ...mutation,
      argumentids: JSON.stringify(argIds.map((_, i) => 'A' + i)),
    }
  };
};

const blockSignature = (b, blocks) => {
  const {inputs, mutation} = normalizeProceduresMutation(b);

  return JSON.stringify({
    opcode: b.opcode,
    inputs: normalizeValue(inputs, blocks),
    fields: (() => {
      const f = {};
      for (const k of Object.keys(b.fields || {}).sort()) f[k] = normalizeField(b.fields[k]);
      return f;
    })(),
    mutation: {
      proccode: mutation.proccode,
      argumentids: mutation.argumentids,
      warp: mutation.warp,
      return: mutation.return,
      hasnext: mutation.hasnext
    }
  });
};

// 对比阶段
const diffs = [];
const addDiff = (type, loc, msg, detail) => {
  diffs.push({type, loc, msg, detail});
};

// 提取命名集合
const namesOf = (obj) => {
  if (!obj || typeof obj !== 'object') return new Set();
  const s = new Set();
  for (const [id, entry] of Object.entries(obj)) {
    let name = id;
    if (Array.isArray(entry)) name = entry[0];
    else if (entry && typeof entry === 'object' && entry.name) name = entry.name;
    else if (typeof entry === 'string') name = entry;
    s.add(String(name));
  }
  return s;
};

const compareNameSets = (A, B, loc, label) => {
  const namesA = namesOf(A);
  const namesB = namesOf(B);
  for (const n of namesA) if (!namesB.has(n)) addDiff('missing', loc, `反编译版缺少 ${label}: "${n}"`);
  for (const n of namesB) if (!namesA.has(n)) addDiff('extra', loc, `反编译版多出 ${label}: "${n}"`);
};

const compareTopology = (targetA, targetB, loc) => {

  const keysA = new Set(Object.keys(targetA));
  const keysB = new Set(Object.keys(targetB));
  for (const k of keysA) if (!keysB.has(k)) addDiff('missing', loc, `反编译版缺少字段: ${k}`);
  for (const k of keysB) if (!keysA.has(k)) addDiff('extra', loc, `反编译版多出字段: ${k}`);


  compareNameSets(targetA.variables, targetB.variables, loc, '变量');
  compareNameSets(targetA.lists, targetB.lists, loc, '列表');
  compareNameSets(targetA.broadcasts, targetB.broadcasts, loc, '广播');

  for (const f of ['x', 'y', 'size', 'direction', 'visible', 'draggable', 'rotationStyle',
                   'currentCostume', 'tempo', 'videoTransparency', 'videoState',
                   'textToSpeechLanguage']) {
    if (f in targetA || f in targetB) {
      const a = targetA[f];
      const b = targetB[f];
      if (a !== b) addDiff('diff', loc, `${f} 不一致: ${JSON.stringify(a)} → ${JSON.stringify(b)}`);
    }
  }

  const varValuesByName = (obj) => {
    const out = {};
    for (const entry of Object.values(obj || {})) {
      if (Array.isArray(entry) && entry.length >= 2) out[entry[0]] = entry[1];
    }
    return out;
  };
  const vA = varValuesByName(targetA.variables);
  const vB = varValuesByName(targetB.variables);
  for (const n of Object.keys(vA)) {
    if (n in vB && JSON.stringify(vA[n]) !== JSON.stringify(vB[n])) {
      addDiff('diff', loc, `变量 "${n}" 初始值不一致: ${JSON.stringify(vA[n])} → ${JSON.stringify(vB[n])}`);
    }
  }
};

const compareBlocks = (blocksA, blocksB, loc) => {
  const countA = Object.keys(blocksA).length;
  const countB = Object.keys(blocksB).length;
  if (countA !== countB) {
    addDiff('count', loc, `块数量不同: ${countA} → ${countB}`);
  }

  const groupBySig = (blocks) => {
    const map = new Map();
    for (const [id, b] of Object.entries(blocks)) {
      if (!b || typeof b !== 'object') continue;
      const sig = blockSignature(b, blocks);
      if (!map.has(sig)) map.set(sig, []);
      map.get(sig).push(id);
    }
    return map;
  };

  const groupA = groupBySig(blocksA);
  const groupB = groupBySig(blocksB);

  const allSigs = new Set([...groupA.keys(), ...groupB.keys()]);
  const opcodeCountMismatches = {};
  for (const sig of allSigs) {
    const idsA = groupA.get(sig) || [];
    const idsB = groupB.get(sig) || [];
    if (idsA.length !== idsB.length) {
      let sample;
      try { sample = JSON.parse(sig); } catch (e) { continue; }
      const key = sample.opcode;
      if (!opcodeCountMismatches[key]) opcodeCountMismatches[key] = {a: 0, b: 0, n: 0};
      opcodeCountMismatches[key].a += idsA.length;
      opcodeCountMismatches[key].b += idsB.length;
      opcodeCountMismatches[key].n++;
    }
  }
  for (const [opcode, c] of Object.entries(opcodeCountMismatches)) {
    addDiff('block-count', loc,
      `块类型 [${opcode}] 数量不同: 原版 ${c.a} → 反编译 ${c.b}`,
      verbose ? {opcode} : undefined);
  }

  const opcodesA = new Map();
  const opcodesB = new Map();
  for (const b of Object.values(blocksA)) if (b && b.opcode) opcodesA.set(b.opcode, (opcodesA.get(b.opcode) || 0) + 1);
  for (const b of Object.values(blocksB)) if (b && b.opcode) opcodesB.set(b.opcode, (opcodesB.get(b.opcode) || 0) + 1);
  for (const [op, n] of opcodesA) {
    if (!opcodesB.has(op)) addDiff('missing-block-kind', loc, `反编译版缺少块类型 [${op}] ×${n}`);
  }
  for (const [op, n] of opcodesB) {
    if (!opcodesA.has(op)) addDiff('extra-block-kind', loc, `反编译版多出块类型 [${op}] ×${n}`);
  }

  const proccodesA = new Set();
  const proccodesB = new Set();
  for (const b of Object.values(blocksA)) {
    if (b && b.mutation && b.mutation.proccode) proccodesA.add(b.mutation.proccode);
  }
  for (const b of Object.values(blocksB)) {
    if (b && b.mutation && b.mutation.proccode) proccodesB.add(b.mutation.proccode);
  }
  for (const p of proccodesA) if (!proccodesB.has(p)) {
    addDiff('missing-proccode', loc, `反编译版缺少 proccode: "${p}"`);
  }
  for (const p of proccodesB) if (!proccodesA.has(p)) {
    addDiff('extra-proccode', loc, `反编译版多出 proccode: "${p}"`);
  }
};

const indexTargets = (json) => {
  const m = new Map();
  for (const t of json.targets || []) m.set(t.name, t);
  return m;
};

const ta = indexTargets(jsonA);
const tb = indexTargets(jsonB);

const allTargetNames = new Set([...ta.keys(), ...tb.keys()]);
for (const name of allTargetNames) {
  if (targetFilter && name !== targetFilter) continue;
  const A = ta.get(name);
  const B = tb.get(name);
  if (!A) { addDiff('missing-target', name, `反编译版缺少角色: ${name}`); continue; }
  if (!B) { addDiff('missing-target', name, `反编译版多出角色: ${name}`); continue; }
  compareTopology(A, B, name);
  compareBlocks(A.blocks || {}, B.blocks || {}, name);
}

if (stableStringify(jsonA.monitors) !== stableStringify(jsonB.monitors)) {
  addDiff('diff', '(全局)', 'monitors 不一致');
}
if (stableStringify(jsonA.extensions) !== stableStringify(jsonB.extensions)) {
  addDiff('diff', '(全局)', `extensions 不一致: ${JSON.stringify(jsonA.extensions)} → ${JSON.stringify(jsonB.extensions)}`);
}
if (JSON.stringify(jsonA.layerOrder) !== JSON.stringify(jsonB.layerOrder)) {
  addDiff('diff', '(全局)', `layerOrder 不一致: ${JSON.stringify(jsonA.layerOrder)} → ${JSON.stringify(jsonB.layerOrder)}`);
}

console.log('');
console.log('  反编译对比结果');
console.log(`  源代码:     ${fileA}`);
console.log(`  反编译:   ${fileB}`);
if (targetFilter) console.log(`  过滤角色: ${targetFilter}`);
console.log('');

if (diffs.length === 0) {
  console.log('结构一致');
} else {
  const byType = {};
  for (const d of diffs) {
    if (!byType[d.type]) byType[d.type] = [];
    byType[d.type].push(d);
  }
  console.log(`共 ${diffs.length} 处差异：`);
  console.log('');
  for (const [type, list] of Object.entries(byType)) {
    console.log(`── [${type}] ${list.length} 处 ──`);
    const cap = (type === 'block-count' || type === 'missing-block-kind' || type === 'extra-block-kind') ? 60 : list.length;
    for (const d of list.slice(0, cap)) {
      console.log(`  · [${d.loc}] ${d.msg}`);
      if (d.detail && verbose) {
        console.log('      ' + JSON.stringify(d.detail).slice(0, 200));
      }
    }
    if (list.length > cap) console.log(`  ...（另有 ${list.length - cap} 条同类，未列出）`);
    console.log('');
  }
}

console.log('  如果上面没看到明显差异但行为不对');
console.log('  请检查语义问题脚本检测不到');
console.log('');