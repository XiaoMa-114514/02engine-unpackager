'use strict';

const isProceduresRelated = (opcode) =>
  opcode === 'procedures_definition' ||
  opcode === 'procedures_prototype' ||
  opcode === 'procedures_call' ||
  opcode === 'procedures_return' ||
  opcode === 'argument_reporter_string_number' ||
  opcode === 'argument_reporter_boolean';

const MAX_PASSES = 50;

/**
 * 入口
 *
 * @param {Object} blocks   target.blocks
 * @param {Object} [opts]
 * @param {Function} [opts.log]  日志
 * @returns {Object} stats  { removed, fixedRefs, fixedOrphans, fixedCycles, fixedShadow, fixedCoords, remaining }
 */
const fixBlockRefs = (blocks, opts = {}) => {
  const log = opts.log || (() => {});
  const stats = {
    removed: 0,
    fixedRefs: 0,
    fixedOrphans: 0,
    fixedCycles: 0,
    fixedShadow: 0,
    fixedCoords: 0,
    remaining: 0
  };

  if (!blocks || typeof blocks !== 'object') return stats;

  let changed = true;
  let passes = 0;

  while (changed && passes++ < MAX_PASSES) {
    changed = false;

    // 删除无效
    for (const id of Object.keys(blocks)) {
      const b = blocks[id];
      if (!b || typeof b !== 'object' ||
          typeof b.opcode !== 'string' || b.opcode === '') {
        delete blocks[id];
        stats.removed++;
        changed = true;
      }
    }

    // 拯救孤儿
    for (const [id, b] of Object.entries(blocks)) {
      if (!b || !b.opcode) continue;

      if (b.next) {
        if (!blocks[b.next] || b.next === id) {
          b.next = null;
          stats.fixedRefs++;
          changed = true;
        }
      }

      if (b.parent) {
        if (!blocks[b.parent] || b.parent === id) {
          b.parent = null;
          stats.fixedRefs++;
          changed = true;
        }
      }

      if (b.parent) {
        const p = blocks[b.parent];
        let referenced = p.next === id;
        if (!referenced && p.inputs) {
          for (const v of Object.values(p.inputs)) {
            if (Array.isArray(v) && v[1] === id) { referenced = true; break; }
            if (v && typeof v === 'object' && v.block === id) { referenced = true; break; }
          }
        }
        if (!referenced) {
          if (b.shadow) {
            delete blocks[id];
            stats.removed++;
          } else {
            b.parent = null;
            if (!b.topLevel) {
              b.topLevel = true;
              if (typeof b.x !== 'number') b.x = 0;
              if (typeof b.y !== 'number') b.y = 0;
            }
            stats.fixedOrphans++;
          }
          changed = true;
          continue;
        }
      }

      if (b.inputs) {
        for (const [k, v] of Object.entries(b.inputs)) {
          let bad = false;
          if (!Array.isArray(v) || v.length < 2) {
            bad = true;
          } else if (!v[1] || !blocks[v[1]] || v[1] === id) {
            bad = true;
          }
          if (bad) {
            delete b.inputs[k];
            stats.fixedRefs++;
            changed = true;
          }
        }
      }
    }

    const visited = new Set();
    for (const [id, b] of Object.entries(blocks)) {
      if (!b || !b.opcode || !b.next) continue;
      if (visited.has(id)) continue;
      const inPath = new Set();
      let cur = id;
      let guard = 0;
      while (cur && guard++ < 1e6) {
        if (inPath.has(cur)) {
          if (b.next === cur) {
            b.next = null;
            stats.fixedCycles++;
            changed = true;
          }
          break;
        }
        if (visited.has(cur)) break;
        inPath.add(cur);
        visited.add(cur);
        const nb = blocks[cur];
        if (!nb) {
          if (blocks[id].next === cur) {
            blocks[id].next = null;
            stats.fixedRefs++;
            changed = true;
          }
          break;
        }
        if (nb.next && !blocks[nb.next]) {
          nb.next = null;
          stats.fixedRefs++;
          changed = true;
        }
        cur = nb.next;
      }
    }
  }

  for (const [id, b] of Object.entries(blocks)) {
    if (!b || !b.opcode) continue;

    if (b.shadow) {
      let dirty = false;
      if (b.topLevel) { b.topLevel = false; dirty = true; }
      if ('x' in b) { delete b.x; dirty = true; }
      if ('y' in b) { delete b.y; dirty = true; }
      if (dirty) { stats.fixedShadow++; changed = true; }
      continue;
    }

    if (b.topLevel) {
      let dirty = false;
      if (b.parent) { b.parent = null; dirty = true; }
      if (typeof b.x !== 'number') { b.x = 0; dirty = true; }
      if (typeof b.y !== 'number') { b.y = 0; dirty = true; }
      if (dirty) { stats.fixedCoords++; changed = true; }
    }
  }

  // 验收
  const bad = [];
  for (const [id, b] of Object.entries(blocks)) {
    if (!b || !b.opcode) continue;

    if (b.next && !blocks[b.next]) bad.push(`${id}.next -> ${b.next}`);
    if (b.parent && !blocks[b.parent]) bad.push(`${id}.parent -> ${b.parent}`);
    if (b.next === id) bad.push(`${id}.next self-ref`);
    if (b.parent === id) bad.push(`${id}.parent self-ref`);

    if (b.inputs) {
      for (const [k, v] of Object.entries(b.inputs)) {
        if (Array.isArray(v)) {
          if (!v[1] || !blocks[v[1]]) bad.push(`${id}.inputs.${k} -> ${v[1]}`);
          else if (v[1] === id) bad.push(`${id}.inputs.${k} self-ref`);
        } else if (v && typeof v === 'object') {
          if (v.block && !blocks[v.block]) bad.push(`${id}.inputs.${k}.block -> ${v.block}`);
          if (v.shadow && !blocks[v.shadow]) bad.push(`${id}.inputs.${k}.shadow -> ${v.shadow}`);
        }
      }
    }

    if (b.topLevel && !b.shadow && !isProceduresRelated(b.opcode)) {
      if (typeof b.x !== 'number' || typeof b.y !== 'number') {
        bad.push(`${id}: topLevel without coords`);
      }
    }
  }

  stats.remaining = bad.length;

  
  const hitIterLimit = passes >= MAX_PASSES && changed;
  if (bad.length > 0) {
    if (hitIterLimit) {
      log(`达到MAX_PASSES (${MAX_PASSES}) 依旧在变化，${bad.length} 条残留:`);
      for (const r of bad.slice(0, 20)) log(`[fix-refs]   ${r}`);
      if (bad.length > 20) log(`[fix-refs]   ... 另有 ${bad.length - 20} 条`);
    } else {
      log(`剩 ${bad.length} 条问题`);
    }
  }

  return stats;
};

module.exports = {fixBlockRefs, isProceduresRelated};