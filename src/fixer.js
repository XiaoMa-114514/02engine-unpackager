'use strict';



const parser = require('@babel/parser');
const t = require('@babel/types');

// 核心逻辑
let decompileSnippet = null;
try {
  const decompile = require('./decompile');
  decompileSnippet = decompile.decompileSnippet;
} catch (e) {
  // 稍后报错
}

let blockIdCounter = 0;
const newId = () => {
  blockIdCounter++;
  return `fix${blockIdCounter.toString(36)}`;
};

// 是不是一个占位符块
const isPlaceholderBlock = (b) => {
  if (!b || b.opcode !== 'control_wait') return false;
  const dur = b.inputs && b.inputs.DURATION;
  if (!Array.isArray(dur)) return false;
  const inner = dur[1];
  if (!Array.isArray(inner)) return false;
  if (typeof inner[1] !== 'string') return false;

  if (/^-?\d+(\.\d+)?$/.test(inner[1])) return false;
  return true;
};

// 从占位符里取出源码
const extractSourceText = (b) => {
  const dur = b.inputs.DURATION;
  const inner = dur[1];
  return inner[1];
};


const rebuildCtx = (projectJson, targetIndex, opts) => {
  const target = projectJson.targets[targetIndex];
  const stage = projectJson.targets.find(x => x.isStage);
  const {log = () => {}} = opts;

  // 重建procMap
  const procMap = {};
  for (const b of Object.values(target.blocks || {})) {
    if (!b || b.opcode !== 'procedures_prototype') continue;
    const mut = b.mutation;
    if (!mut) continue;
    const proccode = mut.proccode;
    if (!proccode) continue;
    const argIds = JSON.parse(mut.argumentids || '[]');
    const argNames = JSON.parse(mut.argumentnames || '[]');
    const argDefaults = JSON.parse(mut.argumentdefaults || '[]');
    const isWarp = mut.warp === 'true' || mut.warp === true;
    const argMatches = proccode.match(/%[snb]/g) || [];
    if (!procMap[proccode]) {
      procMap[proccode] = {
        procCode: proccode,
        isWarp,
        argMatches,
        argIds, argNames, argDefaults
      };
    }
  }

  return {
    target,
    stage,
    log,
    aliases: new Map(),
    varMap: {}, listMap: {}, refMap: {}, constMap: {}, arrayConstMap: {},
    paramMap: {}, paramTypes: {},
    opcodeFnMap: {},
    procMap,
    expectBoolean: false,
    inStringConcat: false,
    paramNames: [],
    argNames: []
  };
};

const expandBlocks = (newBlocks, blocks) => {
  const topIds = [];
  const expandOne = (b, parentId) => {
    if (!b || !b.opcode) return null;
    const id = newId();
    const node = {
      opcode: b.opcode, next: null, parent: parentId,
      inputs: {}, fields: b.fields || {},
      shadow: false, topLevel: false
    };
    if (b.mutation) node.mutation = b.mutation;
    blocks[id] = node;
    const src = b.inputs || {};
    for (const [k, val] of Object.entries(src)) {
      if (val && typeof val === 'object' && Array.isArray(val.blocks)) {
        const innerIds = [];
        let prev = null;
        for (const child of val.blocks) {
          const cid = expandOne(child, prev || id);
          if (!cid) continue;
          if (prev) blocks[prev].next = cid;
          innerIds.push(cid);
          prev = cid;
        }
        if (innerIds.length > 0) node.inputs[k] = [2, innerIds[0]];
        continue;
      }
      node.inputs[k] = val;
    }
    return id;
  };
  for (const b of newBlocks) {
    const id = expandOne(b, null);
    if (id) topIds.push(id);
  }
  return topIds;
};

// 用块替换占位
const replacePlaceholder = (blocks, placeholderId, newBlocks) => {
  const placeholder = blocks[placeholderId];
  if (!placeholder) return false;
  if (!newBlocks || newBlocks.length === 0) return false;

  const prevId = placeholder.parent;
  const nextId = placeholder.next;
  const placeholderWasTopLevel = placeholder.topLevel === true;
  const placeholderX = placeholder.x;
  const placeholderY = placeholder.y;

  // 展开
  const flatIds = expandBlocks(newBlocks, blocks);
  if (flatIds.length === 0) return false;

  const firstId = flatIds[0];
  const lastId = flatIds[flatIds.length - 1];

  if (prevId && blocks[prevId]) {
    blocks[firstId].parent = prevId;
    if (blocks[prevId].next === placeholderId) {
      blocks[prevId].next = firstId;
    }
  } else if (placeholderWasTopLevel) {
    // 保持顶层
    blocks[firstId].topLevel = true;
    if (typeof placeholderX === 'number') blocks[firstId].x = placeholderX;
    if (typeof placeholderY === 'number') blocks[firstId].y = placeholderY;
    blocks[firstId].parent = null;
  } else {
    blocks[firstId].parent = null;
  }

  for (const [bid, bb] of Object.entries(blocks)) {
    if (bid === firstId) continue;
    if (!bb || !bb.inputs) continue;
    for (const [, v] of Object.entries(bb.inputs)) {
      if (Array.isArray(v) && v[0] === 2 && v[1] === placeholderId) {
        v[1] = firstId;
        blocks[firstId].parent = bid;
      }
    }
  }

  // 尾指向原next
  if (nextId && blocks[nextId]) {
    blocks[lastId].next = nextId;
    blocks[nextId].parent = lastId;
  }

  // 删除旧占位
  delete blocks[placeholderId];
  return true;
};

// 入口
const fixProject = async (projectJson, opts = {}) => {
  const {log = () => {}, maxIterations = 3, keepTruncated = true} = opts;

  if (!decompileSnippet) {
    log('[fixer] 无法加载 decompile.decompileSnippet，请先按文档修改 decompile.js');
    return {fixed: 0, skipped: 0, removed: 0};
  }

  let totalFixed = 0;
  let totalSkipped = 0;
  let totalRemoved = 0;

  for (let iter = 0; iter < maxIterations; iter++) {
    let iterFixed = 0;
    log(`[fixer] 第 ${iter + 1} 轮扫描`);

    for (let ti = 0; ti < projectJson.targets.length; ti++) {
      const target = projectJson.targets[ti];
      if (!target.blocks) continue;

      // 收集本轮所有占位
      const placeholderIds = [];
      for (const [id, b] of Object.entries(target.blocks)) {
        if (isPlaceholderBlock(b)) placeholderIds.push(id);
      }
      if (placeholderIds.length === 0) continue;

      const ctx = rebuildCtx(projectJson, ti, opts);

      for (const id of placeholderIds) {
        const placeholder = target.blocks[id];
        if (!placeholder) continue;

        const text = extractSourceText(placeholder);
        if (!text) { totalSkipped++; continue; }

        const isTruncated = text.endsWith('...') && text.length >= 180;
        if (isTruncated) {
          if (keepTruncated) { totalSkipped++; continue; }
        }

        let result = null;
        try {
          result = decompileSnippet(text, target, ctx.stage, ctx);
        } catch (e) {
          log(`[fixer] 反编译异常 ${id}: ${e.message}`);
          totalSkipped++;
          continue;
        }

        if (!result || !result.blocks || result.blocks.length === 0) {
          log(`[fixer] 无法还原 ${id}: ${text.slice(0, 60)}`);
          totalSkipped++;
          continue;
        }

        const ok = replacePlaceholder(target.blocks, id, result.blocks);
        if (ok) {
          iterFixed++;
          log(`[fixer] 修复 ${id}: ${text.slice(0, 60)}`);
        } else {
          totalSkipped++;
        }
      }
    }

    totalFixed += iterFixed;
    if (iterFixed === 0) break;
  }

  return {fixed: totalFixed, skipped: totalSkipped, removed: totalRemoved};
};

module.exports = {fixProject, isPlaceholderBlock, extractSourceText};