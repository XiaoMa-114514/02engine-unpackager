'use strict';

const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;
const t = require('@babel/types');
const vm = require('vm');
const {unwrapEvalSource} = require('./deobfuscate');

let blockIdCounter = 0;
const newId = () => {
  blockIdCounter++;
  return `bld${blockIdCounter.toString(36)}`;
};

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const normalizeBroadcastField = (fieldVal, stage) => {
  let name = null, id = null;
  if (Array.isArray(fieldVal)) {
    name = fieldVal[0] ?? null;
    id = fieldVal[1] ?? null;
  } else if (fieldVal && typeof fieldVal === 'object') {
    name = fieldVal.value ?? fieldVal.name ?? null;
    id = fieldVal.id ?? null;
  } else if (typeof fieldVal === 'string') {
    name = fieldVal;
  }
  const table = (stage && stage.broadcasts) || {};
  if (id && table[id] !== undefined) return [table[id], id];
  if (name !== null) {
    const lower = String(name).toLowerCase();
    for (const [tid, tname] of Object.entries(table)) {
      if (String(tname).toLowerCase() === lower) return [tname, tid];
    }
  }
  if (id) return [name ?? id, id];
  if (name !== null) return [name];
  return null;
};

const isCompilerInternalName = (name) => {
  if (typeof name !== 'string') return false;
  if (/^_?0x[0-9a-f]+/i.test(name)) return true;
  if (/_monitorUpToDate$/i.test(name)) return true;
  if (/_isUpToDate$/i.test(name)) return true;
  if (name === 'hasResumedFromPromise') return true;
  return false;
};

const humanizeSource = (code, ctx) => {
  if (!code || typeof code !== 'string') return code;
  let out = code;
  if (ctx && ctx.aliases && ctx.aliases.size > 0) {
    const pairs = [];
    for (const [name, kind] of ctx.aliases) {
      if (!/^_0x/i.test(name)) continue;
      if (kind === 'runtime' || kind === 'target' || kind === 'stage') {
        pairs.push([name, kind]);
      }
    }
    pairs.sort((a, b) => b[0].length - a[0].length);
    for (const [from, to] of pairs) {
      out = out.replace(new RegExp(`\\b${escapeRegExp(from)}\\b`, 'g'), to);
    }
  }
  out = out.replace(/\b(_0x[0-9a-f]+)\.stopForTarget\(/gi, 'runtime.stopForTarget(');
  out = out.replace(/\b(_0x[0-9a-f]+)\.disposeTarget\(/gi, 'runtime.disposeTarget(');
  out = out.replace(/\b(_0x[0-9a-f]+)\.(ext_[A-Za-z0-9_]+)/gi, 'runtime.$2');
  out = out.replace(/\b(_0x[0-9a-f]+)\.ioDevices\./gi, 'runtime.ioDevices.');
  out = out.replace(/\b(_0x[0-9a-f]+)\.getTargetForStage\(/gi, 'runtime.getTargetForStage(');
  return out;
};

let _generator = null;
const getSource = (node, ctx) => {
  if (!node) return '';
  try {
    if (!_generator) {
      const mod = require('@babel/generator');
      _generator = mod && mod.default ? mod.default : mod;
    }
    const out = _generator(node);
    let code = (out && typeof out.code === 'string') ? out.code : '';
    if (!code) return `/* unresolved ${node.type || 'unknown'} */`;
    return humanizeSource(code, ctx);
  } catch (e) {}
  return `/* unresolved ${node.type || 'unknown'} */`;
};

const ARG_ID_CHARS =
  'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789^$~|:,;./!#%&*+-=<>?[]{}()';

const makeArgIds = (procCode, count) => {
  let seed = 0;
  for (let i = 0; i < procCode.length; i++) seed = (seed * 31 + procCode.charCodeAt(i)) | 0;
  seed = seed >>> 0;
  const ids = [];
  for (let i = 0; i < count; i++) {
    let s = '';
    let h = (seed ^ ((i + 1) * 0x9E3779B9)) >>> 0;
    for (let j = 0; j < 22; j++) {
      h = (h * 1664525 + 1013904223) >>> 0;
      s += ARG_ID_CHARS[h % ARG_ID_CHARS.length];
    }
    ids.push(s);
  }
  return ids;
};

const makeFriendlyArgNames = (procCode, count) => {
  const argMatches = procCode.match(/%[snb]/g) || [];
  const baseName = procCode.split('%')[0].trim() || '积木';
  const names = [];
  let sCount = 0, nCount = 0, bCount = 0;
  for (let i = 0; i < count; i++) {
    const m = argMatches[i] || '%s';
    if (m === '%b') {
      bCount++;
      names.push(`${baseName}_布尔${bCount}`);
    } else if (m === '%s') {
      sCount++;
      names.push(`${baseName}_文本${sCount}`);
    } else {
      nCount++;
      names.push(`${baseName}_数字${nCount}`);
    }
  }
  return names;
};

const BARE_OPCODE_EXTS = new Set([
  'ningqiCollection', 'lmsCollection', 'label', 'AllInTheCollection',
]);

const constInput = (value) => ({opcode: 'constant', value});
const input = (opcode, inputs) => ({opcode, inputs: inputs || {}});

const PLACEHOLDER = (comment) => {
  const raw = (typeof comment === 'string' && comment.length > 0)
    ? comment
    : '[unresolved block]';
  let text = raw;
  const MAX = 180;
  if (text.length > MAX) text = text.slice(0, MAX - 3) + '...';
  return {
    opcode: 'control_wait',
    inputs: {DURATION: constInput(text)},
    __placeholder: true,
    __source: raw,
    __truncated: raw.length > MAX
  };
};

const IGNORED = {opcode: '__ignored__'};

const parseFactory = (source) => {
  let code = source;
  if (typeof code !== 'string') return null;
  if (code.trim().startsWith('eval(')) code = unwrapEvalSource(code);
  try {
    return parser.parse(code, {
      sourceType: 'script',
      allowReturnOutsideFunction: true,
      plugins: ['optionalChaining', 'nullishCoalescingOperator']
    });
  } catch (e) {
    try {
      return parser.parseExpression(code, {plugins: ['optionalChaining', 'nullishCoalescingOperator']});
    } catch (e2) { return null; }
  }
};

const stmtList = (node) => {
  if (!node) return [];
  if (t.isBlockStatement(node)) return node.body;
  return [node];
};

const asBlocks = (result) => {
  if (!result) return [];
  const keep = (b) => b && b.opcode && b.opcode !== '__ignored__';
  if (Array.isArray(result)) return result.filter(keep);
  if (result.blocks && Array.isArray(result.blocks)) return result.blocks.filter(keep);
  if (result.opcode && result.opcode !== '__ignored__') return [result];
  return [];
};

const getPropName = (propNode) => {
  if (!propNode) return null;
  if (t.isIdentifier(propNode)) return propNode.name;
  if (t.isStringLiteral(propNode)) return propNode.value;
  return null;
};

const isRuntimeRef = (node, ctx) => {
  if (!t.isIdentifier(node)) return false;
  if (node.name === 'runtime') return true;
  return !!(ctx.aliases && ctx.aliases.get(node.name) === 'runtime');
};
const isTargetRef = (node, ctx) => {
  if (!t.isIdentifier(node)) return false;
  if (node.name === 'target') return true;
  return !!(ctx.aliases && ctx.aliases.get(node.name) === 'target');
};
const isStageRef = (node, ctx) => {
  if (!t.isIdentifier(node)) return false;
  if (node.name === 'stage') return true;
  return !!(ctx.aliases && ctx.aliases.get(node.name) === 'stage');
};

const isIIFE = (expr) =>
  t.isCallExpression(expr) &&
  (t.isFunctionExpression(expr.callee) || t.isArrowFunctionExpression(expr.callee));

const iifeStatements = (callExpr) => {
  const fn = callExpr.callee;
  if (t.isBlockStatement(fn.body)) return fn.body.body;
  return [];
};

const isStringProducing = (node) => {
  if (!node) return false;
  if (t.isStringLiteral(node)) return true;
  if (t.isTemplateLiteral(node)) return true;
  if (t.isBinaryExpression(node) && node.operator === '+') {
    return isStringProducing(node.left) || isStringProducing(node.right);
  }
  if (t.isCallExpression(node) && t.isMemberExpression(node.callee)) {
    const m = getPropName(node.callee.property);
    if (m === 'toString' || m === 'toLowerCase' || m === 'toUpperCase') return true;
    if (m === 'getUsername') return true;
  }
  return false;
};

const rgbArrayToHex = (node) => {
  if (!t.isArrayExpression(node)) return null;
  const elems = node.elements;
  if (elems.length !== 3) return null;
  const vals = [];
  for (const e of elems) {
    if (!e) return null;
    if (t.isNumericLiteral(e) && Number.isFinite(e.value) && e.value >= 0 && e.value <= 255) {
      vals.push(e.value);
    } else return null;
  }
  return '#' + vals.map(v => Math.round(v).toString(16).padStart(2, '0')).join('');
};

const findObjectExprWithKeys = (node, keySet) => {
  if (!node || typeof node !== 'object') return null;
  if (t.isObjectExpression(node)) {
    const keys = node.properties.map(p => p.key && (p.key.name || p.key.value)).filter(Boolean);
    if (keys.some(k => keySet.has(k))) return node;
  }
  const visitorKeys = t.VISITOR_KEYS[node.type] || [];
  for (const k of visitorKeys) {
    const child = node[k];
    if (!child) continue;
    if (Array.isArray(child)) {
      for (const c of child) {
        const r = findObjectExprWithKeys(c, keySet);
        if (r) return r;
      }
    } else if (typeof child === 'object') {
      const r = findObjectExprWithKeys(child, keySet);
      if (r) return r;
    }
  }
  return null;
};

const lookupVarName = (id, ctx) => {
  const tgt = ctx.target;
  const stage = ctx.stage;
  const pick = (m) => {
    if (!m || !Object.prototype.hasOwnProperty.call(m, id)) return null;
    const v = m[id];
    if (Array.isArray(v)) return v[0];
    if (v && typeof v === 'object' && v.name) return v.name;
    return null;
  };
  const direct =
      pick(tgt && tgt.variables)
      || pick(tgt && tgt.lists)
      || pick(stage && stage.variables)
      || pick(stage && stage.lists);
  if (direct) return direct;
  const maps = [ctx.varMap, ctx.listMap];
  for (const m of maps) {
    if (!m) continue;
    for (const [k, v] of Object.entries(m)) {
      if (!v) continue;
      if (v.id === id || k === id) return v.varName || v.name || id;
    }
  }
  return id;
};

const preprocessObfuscatedAst = (ast, log) => {
  let generate;
  try { generate = require('@babel/generator').default; }
  catch (e) { return {aliases: new Map(), inlineCount: 0}; }

  const fnCodes = [];
  const fnNames = new Set();

  try {
    traverse(ast, {
      FunctionDeclaration(p) {
        const id = p.node.id;
        if (!id || !/^_0x/i.test(id.name)) return;
        if (fnNames.has(id.name)) return;
        fnNames.add(id.name);
        try { fnCodes.push(generate(p.node).code); } catch (e) {}
      },
      VariableDeclarator(p) {
        if (!t.isIdentifier(p.node.id)) return;
        if (!/^_0x/i.test(p.node.id.name)) return;
        if (fnNames.has(p.node.id.name)) return;
        const init = p.node.init;
        if (t.isFunctionExpression(init) || t.isArrowFunctionExpression(init)) {
          fnNames.add(p.node.id.name);
          try { fnCodes.push(`var ${p.node.id.name} = ${generate(init).code};`); } catch (e) {}
        }
      }
    });
  } catch (e) {}

  const iifeCodes = [];
  if (t.isFile(ast)) {
    for (const stmt of ast.program.body) {
      if (!t.isExpressionStatement(stmt)) continue;
      const expr = stmt.expression;
      let candidate = expr;
      if (t.isSequenceExpression(expr) && expr.expressions.length > 0) candidate = expr.expressions[0];
      const callExpr = t.isCallExpression(candidate) ? candidate : null;
      if (!callExpr) continue;
      const callee = callExpr.callee;
      if (!t.isFunctionExpression(callee) && !t.isArrowFunctionExpression(callee)) continue;
      if (callee.params.length < 2) continue;
      if (!callee.params.every(p => t.isIdentifier(p))) continue;
      const firstArg = callExpr.arguments[0];
      if (!firstArg || !t.isIdentifier(firstArg) || !fnNames.has(firstArg.name)) continue;
      try { iifeCodes.push(generate(callExpr).code); } catch (e) {}
    }
  }

  const sandbox = {};
  const sandboxCtx = vm.createContext(sandbox);
  if (fnCodes.length > 0) {
    try { vm.runInContext(fnCodes.join('\n'), sandboxCtx, {timeout: 5000}); } catch (e) {}
  }
  for (const code of iifeCodes) {
    try { vm.runInContext(code, sandboxCtx, {timeout: 5000}); } catch (e) {}
  }

  const decoders = new Set();
  for (const name of fnNames) if (typeof sandbox[name] === 'function') decoders.add(name);
  for (const key of Object.keys(sandbox)) {
    if (/^_0x/i.test(key) && typeof sandbox[key] === 'function') decoders.add(key);
  }

  let inlineCount = 0;
  if (decoders.size > 0) {
    const evalArg = (node) => {
      if (t.isNumericLiteral(node)) return node.value;
      if (t.isStringLiteral(node)) return node.value;
      if (t.isBooleanLiteral(node)) return node.value;
      if (t.isUnaryExpression(node) && node.operator === '-' && t.isNumericLiteral(node.argument)) return -node.argument.value;
      return undefined;
    };
    try {
      traverse(ast, {
        CallExpression(p) {
          const callee = p.node.callee;
          if (!t.isIdentifier(callee)) return;
          if (!decoders.has(callee.name)) return;
          const values = [];
          for (const a of p.node.arguments) {
            const v = evalArg(a);
            if (v === undefined) return;
            values.push(v);
          }
          try {
            const result = sandbox[callee.name](...values);
            if (typeof result === 'string') { p.replaceWith(t.stringLiteral(result)); inlineCount++; }
            else if (typeof result === 'number') { p.replaceWith(t.numericLiteral(result)); inlineCount++; }
          } catch (e) {}
        }
      });
    } catch (e) {}
  }

  const aliases = new Map();
  try {
    traverse(ast, {
      VariableDeclarator(p) {
        const id = p.node.id;
        const init = p.node.init;
        if (!t.isIdentifier(id) || !init) return;
        if (t.isIdentifier(init)) {
          if (init.name === 'runtime') aliases.set(id.name, 'runtime');
          else if (init.name === 'target') aliases.set(id.name, 'target');
          else if (init.name === 'stage') aliases.set(id.name, 'stage');
        }
        if (t.isMemberExpression(init)) {
          const prop = getPropName(init.property);
          if (prop === 'runtime') aliases.set(id.name, 'runtime');
          else if (prop === 'target') aliases.set(id.name, 'target');
        }
        if (t.isCallExpression(init) && t.isMemberExpression(init.callee)) {
          const m = getPropName(init.callee.property);
          if (m === 'getTargetForStage') aliases.set(id.name, 'stage');
          else if (m === 'getOpcodeFunction') aliases.set(id.name, 'opcodeFn');
        }
      }
    });
  } catch (e) {}

  return {aliases, inlineCount};
};

const extractRefMaps = (ast, target, stage, aliases) => {
  const refMap = {};
  const constMap = {};
  const arrayConstMap = {};
  try {
    traverse(ast, {
      VariableDeclarator(p) {
        if (!t.isIdentifier(p.node.id)) return;
        const init = p.node.init;

        if (/^_0x/i.test(p.node.id.name) && init) {
          if (t.isStringLiteral(init)) {
            constMap[p.node.id.name] = init.value;
          } else if (t.isNumericLiteral(init)) {
            constMap[p.node.id.name] = init.value;
          } else if (t.isBooleanLiteral(init)) {
            constMap[p.node.id.name] = init.value;
          } else if (t.isUnaryExpression(init) && init.operator === '-' && t.isNumericLiteral(init.argument)) {
            constMap[p.node.id.name] = -init.argument.value;
          } else if (t.isArrayExpression(init)) {
            const hex = rgbArrayToHex(init);
            if (hex) arrayConstMap[p.node.id.name] = hex;
          }
        }

        if (!t.isMemberExpression(init)) return;
        const obj = init.object;
        const prop = init.property;
        if (!t.isMemberExpression(obj)) return;
        const scopeNode = obj.object;
        const vars = getPropName(obj.property);
        if (vars !== 'variables' && vars !== 'lists') return;
        let scopeKind = null;
        if (t.isIdentifier(scopeNode)) {
          if (scopeNode.name === 'stage') scopeKind = 'stage';
          else if (scopeNode.name === 'target') scopeKind = 'target';
          else if (aliases && aliases.get(scopeNode.name) === 'stage') scopeKind = 'stage';
          else if (aliases && aliases.get(scopeNode.name) === 'target') scopeKind = 'target';
        }
        if (!scopeKind) return;
        const key = t.isIdentifier(prop) ? prop.name : (t.isStringLiteral(prop) ? prop.value : null);
        if (!key) return;
        let kind = vars;
        const scopeTarget = scopeKind === 'stage' ? stage : target;
        if (scopeTarget) {
          if (scopeTarget.lists && Object.prototype.hasOwnProperty.call(scopeTarget.lists, key)) {
            kind = 'lists';
          } else if (scopeTarget.variables && Object.prototype.hasOwnProperty.call(scopeTarget.variables, key)) {
            kind = 'variables';
          }
        }
        refMap[p.node.id.name] = {scope: scopeKind, id: key, kind};
      }
    });
  } catch (e) {}

  const varMap = {};
  const listMap = {};
  const getVarName = (entry, fallback) => {
    if (entry === undefined) return fallback;
    if (Array.isArray(entry)) return entry[0];
    if (entry && typeof entry === 'object' && entry.name) return entry.name;
    return fallback;
  };

  for (const [refName, ref] of Object.entries(refMap)) {
    const scopeTarget = ref.scope === 'stage' ? stage : target;
    const scopeVars = (scopeTarget && scopeTarget.variables) || {};
    const scopeLists = (scopeTarget && scopeTarget.lists) || {};
    const inVars = Object.prototype.hasOwnProperty.call(scopeVars, ref.id);
    const inLists = Object.prototype.hasOwnProperty.call(scopeLists, ref.id);
    if (inLists) listMap[refName] = {scope: ref.scope, id: ref.id, varName: getVarName(scopeLists[ref.id], ref.id)};
    else if (inVars) varMap[refName] = {scope: ref.scope, id: ref.id, varName: getVarName(scopeVars[ref.id], ref.id)};
    else varMap[refName] = {scope: ref.scope, id: ref.id, varName: ref.id};
  }
  return {refMap, varMap, listMap, constMap, arrayConstMap};
};

const extractOpcodeFunctions = (ast) => {
  const map = {};
  try {
    traverse(ast, {
      VariableDeclarator(p) {
        if (!t.isIdentifier(p.node.id)) return;
        const init = p.node.init;
        if (!t.isCallExpression(init)) return;
        const callee = init.callee;
        if (!t.isMemberExpression(callee)) return;
        if (getPropName(callee.property) !== 'getOpcodeFunction') return;
        const arg = init.arguments[0];
        if (!t.isStringLiteral(arg)) return;
        map[p.node.id.name] = arg.value;
      }
    });
  } catch (e) {}
  return map;
};

const extractFunctionInfo = (ast) => {
  const fnByIdentifier = new Map();

  try {
    traverse(ast, {
      VariableDeclarator(p) {
        if (!t.isIdentifier(p.node.id)) return;
        const init = p.node.init;
        if (t.isFunctionExpression(init) || t.isFunctionDeclaration(init) || t.isArrowFunctionExpression(init)) {
          fnByIdentifier.set(p.node.id.name, init);
        }
      }
    });
  } catch (e) {}

  const resolveFn = (node) => {
    if (!node) return null;
    if (t.isFunctionExpression(node) || t.isFunctionDeclaration(node) || t.isArrowFunctionExpression(node)) return node;
    if (t.isIdentifier(node) && fnByIdentifier.has(node.name)) return fnByIdentifier.get(node.name);
    return null;
  };

  const bodyOf = (fnNode) => {
    if (!fnNode) return null;
    const b = fnNode.body;
    if (t.isBlockStatement(b)) return b.body;
    return null;
  };

  const findInnerFn = (fnNode) => {
    const body = bodyOf(fnNode);
    if (!body) return null;
    for (const stmt of body) {
      if (t.isReturnStatement(stmt)) {
        const inner = resolveFn(stmt.argument);
        if (inner) return inner;
      }
    }
    return null;
  };

  const findDeepest = (fnNode) => {
    let cur = fnNode;
    let guard = 0;
    while (cur && guard++ < 64) {
      const inner = findInnerFn(cur);
      if (!inner) break;
      cur = inner;
    }
    return cur;
  };

  const makeResult = (fnNode) => {
    if (!fnNode) return null;
    const b = bodyOf(fnNode);
    if (!b || b.length === 0) return null;
    return {
      body: b,
      params: fnNode.params.map(x => x.name || (x.left && x.left.name) || '')
    };
  };

  let result = null;
  try {
    traverse(ast, {
      ReturnStatement(p) {
        if (result) return;
        const fnNode = resolveFn(p.node.argument);
        if (!fnNode) return;
        const deepest = findDeepest(fnNode);
        const r = makeResult(deepest);
        if (r) result = r;
      }
    });
  } catch (e) {}

  if (!result) {
    try {
      traverse(ast, {
        Function(p) {
          if (result) return;
          const inner = findInnerFn(p.node);
          if (inner) {
            const deepest = findDeepest(inner);
            const r = makeResult(deepest);
            if (r) result = r;
          }
        }
      });
    } catch (e) {}
  }

  if (!result) {
    try {
      if (t.isFile(ast)) {
        for (const stmt of ast.program.body) {
          if (t.isFunctionDeclaration(stmt)) {
            const r = makeResult(stmt);
            if (r) { result = r; break; }
          }
          if (t.isExpressionStatement(stmt) &&
              t.isCallExpression(stmt.expression) &&
              (t.isFunctionExpression(stmt.expression.callee) || t.isArrowFunctionExpression(stmt.expression.callee))) {
            const r = makeResult(stmt.expression.callee);
            if (r) { result = r; break; }
          }
        }
      }
    } catch (e) {}
  }

  return result || {body: null, params: []};
};

const parseFactoryRobust = (rawSource, deobfSource, {log, label}) => {
  const candidates = [];
  if (deobfSource && deobfSource !== rawSource) candidates.push({src: deobfSource, tag: 'deobf'});
  if (rawSource) candidates.push({src: rawSource, tag: 'raw'});

  for (const {src, tag} of candidates) {
    let code = src;
    if (typeof code === 'string' && code.trim().startsWith('eval(')) code = unwrapEvalSource(code);
    const ast = parseFactory(code);
    if (!ast) { log(`[${label}] parse ${tag} failed`); continue; }
    const {aliases} = preprocessObfuscatedAst(ast, log);
    const info = extractFunctionInfo(ast);
    if (!info.body || info.body.length === 0) { log(`[${label}] extract ${tag} failed`); continue; }
    return {ast, body: info.body, params: info.params, aliases};
  }
  return null;
};

const getLitVal = (n) => {
  if (t.isNumericLiteral(n)) return n.value;
  if (t.isUnaryExpression(n) && n.operator === '-' && t.isNumericLiteral(n.argument)) return -n.argument.value;
  return null;
};

const decompileExpression = (node, ctx) => {
  if (!node) return constInput(0);
  if (t.isNumericLiteral(node)) return constInput(node.value);
  if (t.isStringLiteral(node)) return constInput(node.value);
  if (t.isBooleanLiteral(node)) return constInput(node.value);
  if (t.isNullLiteral(node)) return constInput('');

  if (t.isNewExpression(node)) {
    if (t.isMemberExpression(node.callee)) {
      const m = getPropName(node.callee.property);
      const obj = node.callee.object;
      if (t.isIdentifier(obj) && obj.name === 'Date') {
        switch (m) {
          case 'getFullYear': return input('sensing_current', {CURRENTMENU: 'YEAR'});
          case 'getMonth': return input('sensing_current', {CURRENTMENU: 'MONTH'});
          case 'getDate': return input('sensing_current', {CURRENTMENU: 'DATE'});
          case 'getDay': return input('sensing_current', {CURRENTMENU: 'DAYOFWEEK'});
          case 'getHours': return input('sensing_current', {CURRENTMENU: 'HOUR'});
          case 'getMinutes': return input('sensing_current', {CURRENTMENU: 'MINUTE'});
          case 'getSeconds': return input('sensing_current', {CURRENTMENU: 'SECOND'});
        }
      }
    }
    return constInput(0);
  }

  if (t.isUnaryExpression(node)) {
    if (node.operator === '+') return decompileExpression(node.argument, ctx);
    if (node.operator === '-') {
      const inner = decompileExpression(node.argument, ctx);
      if (inner.opcode === 'constant' && typeof inner.value === 'number') return constInput(-inner.value);
      return input('operator_subtract', {NUM1: constInput(0), NUM2: inner});
    }
    if (node.operator === '!') {
      if (t.isMemberExpression(node.argument) && getPropName(node.argument.property) === 'isOriginal') return constInput(0);
      const prev = ctx.expectBoolean;
      ctx.expectBoolean = true;
      const operand = decompileExpression(node.argument, ctx);
      ctx.expectBoolean = prev;
      return input('operator_not', {OPERAND: operand});
    }
    if (node.operator === 'void' || node.operator === 'typeof') return constInput('');
    if (node.operator === '~') return constInput(0);
  }

  if (t.isBinaryExpression(node)) {
    const op = node.operator;
    const prevBool = ctx.expectBoolean;
    ctx.expectBoolean = false;
    try {
      const L = () => decompileExpression(node.left, ctx);
      const R = () => decompileExpression(node.right, ctx);

      if (op === '+') {
        const leftIsStr = isStringProducing(node.left);
        const rightIsStr = isStringProducing(node.right);
        const inStr = ctx.inStringConcat || leftIsStr || rightIsStr;
        if (inStr) {
          const prev = ctx.inStringConcat;
          ctx.inStringConcat = true;
          const result = input('operator_join', {STRING1: L(), STRING2: R()});
          ctx.inStringConcat = prev;
          return result;
        }
        return input('operator_add', {NUM1: L(), NUM2: R()});
      }
      if (op === '-') return input('operator_subtract', {NUM1: L(), NUM2: R()});
      if (op === '*') return input('operator_multiply', {NUM1: L(), NUM2: R()});
      if (op === '/') return input('operator_divide', {NUM1: L(), NUM2: R()});
      if (op === '%') return input('operator_mod', {NUM1: L(), NUM2: R()});

      if (op === '===' || op === '==') return input('operator_equals', {OPERAND1: L(), OPERAND2: R()});
      if (op === '!==' || op === '!=') {
        if (t.isCallExpression(node.left) && t.isMemberExpression(node.left.callee) && getPropName(node.left.callee.property) === 'indexOf') {
          const rVal = getLitVal(node.right);
          if (rVal === -1) {
            return input('operator_contains', {
              STRING1: decompileExpression(node.left.callee.object, ctx),
              STRING2: decompileExpression(node.left.arguments[0], ctx)
            });
          }
        }
        return input('operator_not', {OPERAND: input('operator_equals', {OPERAND1: L(), OPERAND2: R()})});
      }
      if (op === '>') {
        if (t.isCallExpression(node.left) && t.isMemberExpression(node.left.callee) && getPropName(node.left.callee.property) === 'indexOf') {
          const rVal = getLitVal(node.right);
          if (rVal === -1) {
            return input('operator_contains', {
              STRING1: decompileExpression(node.left.callee.object, ctx),
              STRING2: decompileExpression(node.left.arguments[0], ctx)
            });
          }
        }
        return input('operator_gt', {OPERAND1: L(), OPERAND2: R()});
      }
      if (op === '<') return input('operator_lt', {OPERAND1: L(), OPERAND2: R()});
      if (op === '>=') {
        if (t.isCallExpression(node.left) && t.isMemberExpression(node.left.callee) && getPropName(node.left.callee.property) === 'indexOf') {
          const rVal = getLitVal(node.right);
          if (rVal === 0) {
            return input('operator_contains', {
              STRING1: decompileExpression(node.left.callee.object, ctx),
              STRING2: decompileExpression(node.left.arguments[0], ctx)
            });
          }
        }
        return input('operator_not', {OPERAND: input('operator_lt', {OPERAND1: L(), OPERAND2: R()})});
      }
      if (op === '<=') return input('operator_not', {OPERAND: input('operator_gt', {OPERAND1: L(), OPERAND2: R()})});

      if (op === '**') {
        return input('operator_mathop', {
          OPERATOR: 'e ^',
          NUM: input('operator_multiply', {
            NUM1: R(),
            NUM2: input('operator_mathop', {OPERATOR: 'ln', NUM: L()})
          })
        });
      }
    } finally {
      ctx.expectBoolean = prevBool;
    }
  }

  if (t.isLogicalExpression(node)) {
    const prev = ctx.expectBoolean;

    if (node.operator === '||' || node.operator === '??') {
      if ((t.isNumericLiteral(node.right) && node.right.value === 0) ||
          (t.isStringLiteral(node.right) && node.right.value === '')) {
        return decompileExpression(node.left, ctx);
      }
      ctx.expectBoolean = true;
      const r = input('operator_or', {OPERAND1: decompileExpression(node.left, ctx), OPERAND2: decompileExpression(node.right, ctx)});
      ctx.expectBoolean = prev;
      return r;
    }
    if (node.operator === '&&') {
      ctx.expectBoolean = true;
      const r = input('operator_and', {OPERAND1: decompileExpression(node.left, ctx), OPERAND2: decompileExpression(node.right, ctx)});
      ctx.expectBoolean = prev;
      return r;
    }
    ctx.expectBoolean = prev;
  }

  if (t.isAssignmentExpression(node)) return decompileExpression(node.right, ctx);
  if (t.isSequenceExpression(node)) return decompileExpression(node.expressions[node.expressions.length - 1], ctx);

  if (t.isYieldExpression(node)) {
    if (node.argument) {
      if (t.isCallExpression(node.argument)) return decompileCall(node.argument, ctx);
      return decompileExpression(node.argument, ctx);
    }
    return constInput('');
  }
  if (t.isAwaitExpression(node)) return decompileExpression(node.argument, ctx);

  if (t.isCallExpression(node)) {
    const r = decompileCall(node, ctx);
    return r === IGNORED ? constInput(0) : r;
  }
  if (t.isMemberExpression(node)) return decompileMember(node, ctx);

  if (t.isIdentifier(node)) {
    if (ctx.paramNames && ctx.paramNames.length > 0) {
      const idx = ctx.paramNames.indexOf(node.name);
      if (idx >= 0) {
        const argName = (ctx.argNames && ctx.argNames[idx]) || `参数${idx + 1}`;
        const isBool = !!(ctx.paramTypes && ctx.paramTypes[argName] === 'boolean');
        const opcode = isBool ? 'argument_reporter_boolean' : 'argument_reporter_string_number';
        return {opcode, inputs: {}, fields: {VALUE: {value: argName}}};
      }
    }
    if (/^p\d+$/.test(node.name)) {
      const idx = parseInt(node.name.slice(1), 10);
      const argName = (ctx.argNames && ctx.argNames[idx]) || `参数${idx + 1}`;
      const isBool = !!(ctx.paramTypes && ctx.paramTypes[argName] === 'boolean');
      const opcode = isBool ? 'argument_reporter_boolean' : 'argument_reporter_string_number';
      return {opcode, inputs: {}, fields: {VALUE: {value: argName}}};
    }

    if (ctx.varMap && ctx.varMap[node.name]) {
      const v = ctx.varMap[node.name];
      return input('data_variable', {VARIABLE: {name: v.varName, id: v.id}});
    }
    if (ctx.listMap && ctx.listMap[node.name]) {
      const l = ctx.listMap[node.name];
      return input('data_listcontents', {LIST: {name: l.varName, id: l.id}});
    }
    if (/^_0x/i.test(node.name)) {
      if (ctx.arrayConstMap && Object.prototype.hasOwnProperty.call(ctx.arrayConstMap, node.name)) {
        return constInput(ctx.arrayConstMap[node.name]);
      }
      if (ctx.constMap && Object.prototype.hasOwnProperty.call(ctx.constMap, node.name)) {
        return constInput(ctx.constMap[node.name]);
      }
      return constInput('');
    }
    if (node.name === 'runtime' || node.name === 'target' || node.name === 'stage') return constInput(0);
    if (node.name === 'undefined' || node.name === 'NaN') return constInput('');
    if (node.name === 'Math' || node.name === 'Object' || node.name === 'Array' ||
        node.name === 'JSON' || node.name === 'Date') return constInput(0);
    if (node.name === 'hasResumedFromPromise' || node.name === 'isStuck') return constInput(0);
    if (node.name === 'thread' || node.name === 'blockUtility' || node.name === 'globalState') return constInput(0);

    return constInput(node.name);
  }

  if (t.isConditionalExpression(node)) {
    const b = node.consequent, c = node.alternate;
    if (t.isBooleanLiteral(b) && b.value === true && t.isBooleanLiteral(c) && c.value === false) {
      const prev = ctx.expectBoolean; ctx.expectBoolean = true;
      const r = decompileExpression(node.test, ctx);
      ctx.expectBoolean = prev; return r;
    }
    if (t.isNumericLiteral(b) && b.value === 1 && t.isNumericLiteral(c) && c.value === 0) {
      const prev = ctx.expectBoolean; ctx.expectBoolean = true;
      const r = decompileExpression(node.test, ctx);
      ctx.expectBoolean = prev; return r;
    }
    if (t.isNumericLiteral(b) && b.value === 0 && t.isNumericLiteral(c) && c.value === 1) {
      const prev = ctx.expectBoolean; ctx.expectBoolean = true;
      const r = input('operator_not', {OPERAND: decompileExpression(node.test, ctx)});
      ctx.expectBoolean = prev; return r;
    }
    return decompileExpression(node.test, ctx);
  }

  if (t.isTemplateLiteral(node)) {
    if (node.expressions.length === 0) return constInput(node.quasis.map(q => q.value.cooked).join(''));
    let acc = null;
    for (let i = 0; i < node.quasis.length; i++) {
      const txt = node.quasis[i].value.cooked || '';
      if (txt) {
        acc = acc === null ? constInput(txt) : input('operator_join', {STRING1: acc, STRING2: constInput(txt)});
      }
      if (i < node.expressions.length) {
        const e = decompileExpression(node.expressions[i], ctx);
        acc = acc === null ? e : input('operator_join', {STRING1: acc, STRING2: e});
      }
    }
    return acc || constInput('');
  }

  if (t.isArrayExpression(node)) {
    const hex = rgbArrayToHex(node);
    if (hex) return constInput(hex);
    return input('data_listcontents', {});
  }
  if (t.isObjectExpression(node)) return constInput('');

  return constInput(0);
};

const decompileIoDeviceCall = (sub, method, args, ctx) => {
  if (sub === 'mouse') {
    if (method === 'getIsDown') return input('sensing_mousedown', {});
    if (method === 'getScratchX') return input('sensing_mousex', {});
    if (method === 'getScratchY') return input('sensing_mousey', {});
  }
  if (sub === 'keyboard') {
    if (method === 'getKeyIsDown') {
      const a = args[0];
      const keyVal = a && a.value !== undefined ? a.value : '';
      return input('sensing_keypressed', {KEY_OPTION: constInput(keyVal)});
    }
    if (method === 'getLastKeyPressed') return input('tw_getLastKeyPressed', {});
  }
  if (sub === 'userData' && method === 'getUsername') return input('sensing_username', {});
  if (sub === 'clock') {
    if (method === 'projectTimer') return input('sensing_timer', {});
    if (method === 'resetProjectTimer') return {opcode: 'sensing_resettimer', inputs: {}, fields: {}};
  }
  return null;
};

const callArgs = (args, ctx) => {
  const prevBool = ctx.expectBoolean;
  ctx.expectBoolean = false;
  const out = {};
  args.forEach((arg, i) => {
    if (t.isSpreadElement(arg)) return;
    out[`ARG${i}`] = decompileExpression(arg, ctx);
  });
  ctx.expectBoolean = prevBool;
  return out;
};

const buildProcedureCall = (procCode, isWarp, args, ctx, asReturn) => {
  const info = ctx.procMap ? ctx.procMap[procCode] : null;
  let argIds;
  let argNames;
  if (info) {
    argIds = info.argIds;
    argNames = info.argNames;
  } else {
    const argMatches = procCode.match(/%[snb]/g) || [];
    const n = Math.max(argMatches.length, args.length);
    argIds = makeArgIds(procCode, n);
    argNames = makeFriendlyArgNames(procCode, n);
  }
  const inputs = {};
  args.forEach((arg, i) => {
    if (argIds[i] === undefined) return;
    if (t.isSpreadElement(arg)) return;
    inputs[argIds[i]] = decompileExpression(arg, ctx);
  });
  const mutation = {
    tagName: 'mutation',
    children: [],
    proccode: procCode,
    argumentids: JSON.stringify(argIds),
    warp: isWarp ? 'true' : 'false'
  };
  if (asReturn) mutation.return = '1';
  return {
    opcode: 'procedures_call',
    inputs,
    mutation
  };
};

const decompileCustomExtensionCall = (ext, method, args, ctx) => {
  if (typeof ext !== 'string' || !ext.startsWith('ext_')) return null;
  const extId = ext.slice(4);
  if (!extId || extId.startsWith('scratch3_')) return null;
  const rawMethod = typeof method === 'string' ? method : '';
  if (!rawMethod) return null;

  let opcode;
  if (BARE_OPCODE_EXTS.has(extId)) opcode = rawMethod.replace(/^_/, '');
  else {
    const m = rawMethod.startsWith('_') ? rawMethod.slice(1) : rawMethod;
    opcode = `${extId}_${m}`;
  }

  if (ctx.customExtensions) ctx.customExtensions.add(extId);
  const inputs = callArgs(args, ctx);
  return {opcode, inputs, fields: {}};
};

const getVariantName = (propNode) => {
  if (t.isStringLiteral(propNode)) return propNode.value;
  if (t.isIdentifier(propNode)) return propNode.name;
  return null;
};

const findFullProcCode = (bareName, procMap) => {
  if (!procMap) return bareName;
  if (Object.prototype.hasOwnProperty.call(procMap, bareName)) return bareName;
  for (const key of Object.keys(procMap)) {
    if (key === bareName) return key;
    if (key.startsWith(bareName + ' ') || key.startsWith(bareName + '%')) return key;
  }
  return bareName;
};

const matchThreadProceduresCall = (call, ctx, asReturn) => {
  let callee = call.callee;
  if (!callee) return null;
  if (!t.isMemberExpression(callee)) return null;
  if (!t.isMemberExpression(callee.object)) return null;
  if (!t.isIdentifier(callee.object.object)) return null;
  if (getPropName(callee.object.property) !== 'procedures') return null;
  const variant = getVariantName(callee.property);
  if (!variant) return null;
  if (variant.charAt(0) !== 'Z' && variant.charAt(0) !== 'W') return null;
  const bareName = variant.substring(1);
  const isWarp = variant.charAt(0) === 'W';
  const procCode = findFullProcCode(bareName, ctx.procMap);
  return buildProcedureCall(procCode, isWarp, call.arguments, ctx, asReturn);
};

const matchYieldThenCall = (call, ctx, asReturn) => {
  const callee = call.callee;
  if (!t.isIdentifier(callee)) return null;
  if (callee.name !== 'yieldThenCall' && callee.name !== 'yieldThenCallGenerator') return null;
  const args = call.arguments;
  if (args.length < 2) return null;
  const first = args[0];
  if (!t.isMemberExpression(first)) return null;
  if (!t.isMemberExpression(first.object)) return null;
  if (!t.isIdentifier(first.object.object)) return null;
  if (getPropName(first.object.property) !== 'procedures') return null;
  const variant = getVariantName(first.property);
  if (!variant) return null;
  if (variant.charAt(0) !== 'Z' && variant.charAt(0) !== 'W') return null;
  const bareName = variant.substring(1);
  const isWarp = variant.charAt(0) === 'W';
  const procCode = findFullProcCode(bareName, ctx.procMap);
  return buildProcedureCall(procCode, isWarp, args.slice(1), ctx, asReturn);
};

const decompileCall = (node, ctx) => {
  const callee = node.callee;
  const args = node.arguments;

  {
    const r = matchThreadProceduresCall(node, ctx, true);
    if (r) return r;
  }
  {
    const r = matchYieldThenCall(node, ctx, true);
    if (r) return r;
  }

  if (t.isMemberExpression(callee) && getPropName(callee.property) === 'toLowerCase') {
    return decompileExpression(callee.object, ctx);
  }

  if (t.isMemberExpression(callee) && isRuntimeRef(callee.object, ctx)) {
    const m = getPropName(callee.property);
    if (m === 'disposeTarget') return input('control_delete_this_clone', {});
    if (m === 'stopForTarget') return null;
    if (m === 'stopAll') return {opcode: 'control_stop', fields: {STOP_OPTION: {value: 'all'}}};
  }

  if (t.isMemberExpression(callee)) {
    const cobj = callee.object;
    if (t.isMemberExpression(cobj) && t.isMemberExpression(cobj.object) &&
        isRuntimeRef(cobj.object.object, ctx) &&
        getPropName(cobj.object.property) === 'ioDevices') {
      const sub = getPropName(cobj.property);
      const method = getPropName(callee.property);
      const r = decompileIoDeviceCall(sub, method, args, ctx);
      if (r) return r;
    }
  }

  if (t.isMemberExpression(callee) && t.isIdentifier(callee.object) && callee.object.name === 'Math') {
    const method = getPropName(callee.property);
    const num = () => decompileExpression(args[0], ctx);
    switch (method) {
      case 'abs': return input('operator_mathop', {OPERATOR: 'abs', NUM: num()});
      case 'floor': return input('operator_mathop', {OPERATOR: 'floor', NUM: num()});
      case 'ceil': return input('operator_mathop', {OPERATOR: 'ceiling', NUM: num()});
      case 'round': return input('operator_round', {NUM: num()});
      case 'sqrt': return input('operator_mathop', {OPERATOR: 'sqrt', NUM: num()});
      case 'sin': return input('operator_mathop', {OPERATOR: 'sin', NUM: num()});
      case 'cos': return input('operator_mathop', {OPERATOR: 'cos', NUM: num()});
      case 'tan': return input('operator_mathop', {OPERATOR: 'tan', NUM: num()});
      case 'asin': return input('operator_mathop', {OPERATOR: 'asin', NUM: num()});
      case 'acos': return input('operator_mathop', {OPERATOR: 'acos', NUM: num()});
      case 'atan': return input('operator_mathop', {OPERATOR: 'atan', NUM: num()});
      case 'log': return input('operator_mathop', {OPERATOR: 'ln', NUM: num()});
      case 'exp': return input('operator_mathop', {OPERATOR: 'e ^', NUM: num()});
      case 'max':
        if (args.length === 2 && t.isNumericLiteral(args[0]) && args[0].value === 0) return decompileExpression(args[1], ctx);
        return args[0] ? decompileExpression(args[0], ctx) : constInput(0);
      case 'min':
        return args[0] ? decompileExpression(args[0], ctx) : constInput(0);
      case 'random': return input('operator_random', {FROM: constInput(0), TO: constInput(1)});
      case 'pow':
        if (args.length === 2 && t.isNumericLiteral(args[0]) && args[0].value === 10) {
          return input('operator_mathop', {OPERATOR: '10 ^', NUM: decompileExpression(args[1], ctx)});
        }
        return constInput(0);
    }
  }

  if (t.isMemberExpression(callee)) {
    const obj = callee.object;
    const method = getPropName(callee.property);

    if (t.isMemberExpression(obj) && isRuntimeRef(obj.object, ctx)) {
      const r = decompileExtCall(getPropName(obj.property), method, args, ctx);
      if (r === IGNORED) return IGNORED;
      if (r) return r;
    }

    if (isTargetRef(obj, ctx)) {
      const r = decompileTargetCall(method, args, ctx);
      if (r) return r;
    }

    if (method === 'includes') {
      return input('operator_contains', {
        STRING1: decompileExpression(obj, ctx),
        STRING2: decompileExpression(args[0], ctx)
      });
    }

    if (method === 'value') return constInput('');
    if (method === 'toString') return decompileExpression(obj, ctx);
    if (method === 'toLowerCase' || method === 'toUpperCase') return decompileExpression(obj, ctx);
  }

  if (t.isIdentifier(callee)) {
    const name = callee.name;

    const listFieldFromArg = (idx) => {
      const a = args[idx];
      if (!a) return null;
      if (t.isIdentifier(a) && ctx.listMap && ctx.listMap[a.name]) {
        const l = ctx.listMap[a.name];
        return {name: l.varName, id: l.id};
      }
      if (t.isMemberExpression(a) && getPropName(a.property) === 'value' &&
          t.isIdentifier(a.object) && ctx.listMap && ctx.listMap[a.object.name]) {
        const l = ctx.listMap[a.object.name];
        return {name: l.varName, id: l.id};
      }
      if (t.isIdentifier(a) && ctx.refMap && ctx.refMap[a.name] && ctx.refMap[a.name].kind === 'lists') {
        const ref = ctx.refMap[a.name];
        const listName = lookupVarName(ref.id, ctx);
        return {name: listName, id: ref.id};
      }
      if (t.isMemberExpression(a) && getPropName(a.property) === 'value' &&
          t.isIdentifier(a.object) && ctx.refMap && ctx.refMap[a.object.name] && ctx.refMap[a.object.name].kind === 'lists') {
        const ref = ctx.refMap[a.object.name];
        const listName = lookupVarName(ref.id, ctx);
        return {name: listName, id: ref.id};
      }
      return null;
    };

    if (name === 'contains') {
      return input('operator_contains', {
        STRING1: decompileExpression(args[0], ctx),
        STRING2: decompileExpression(args[1], ctx)
      });
    }
    if (name === 'getListIndex') {
      const lf = listFieldFromArg(0);
      if (!lf) return constInput(0);
      return input('data_itemnumoflist', {LIST: lf, ITEM: decompileExpression(args[1], ctx)});
    }
    if (name === 'getListContents') {
      const lf = listFieldFromArg(0);
      if (!lf) return constInput('');
      return input('data_listcontents', {LIST: lf});
    }

    if (name === 'mod') return input('operator_mod', {NUM1: decompileExpression(args[0], ctx), NUM2: decompileExpression(args[1], ctx)});
    if (name === 'randomInt' || name === 'randomFloat') {
      return input('operator_random', {FROM: decompileExpression(args[0], ctx), TO: decompileExpression(args[1], ctx)});
    }
    if (name === 'listGet') {
      const lf = listFieldFromArg(0);
      if (!lf) return constInput(0);
      return input('data_itemoflist', {LIST: lf, INDEX: decompileExpression(args[1], ctx)});
    }
    if (name === 'listContains') {
      const lf = listFieldFromArg(0);
      if (!lf) return constInput(0);
      return input('data_listcontainsitem', {LIST: lf, ITEM: decompileExpression(args[1], ctx)});
    }
    if (name === 'listIndexOf') {
      const lf = listFieldFromArg(0);
      if (!lf) return constInput(0);
      return input('data_itemnumoflist', {LIST: lf, ITEM: decompileExpression(args[1], ctx)});
    }
    if (name === 'listContents') {
      const lf = listFieldFromArg(0);
      if (!lf) return constInput('');
      return input('data_listcontents', {LIST: lf});
    }
    if (name === 'listLength') {
      const lf = listFieldFromArg(0);
      if (!lf) return constInput(0);
      return input('data_lengthoflist', {LIST: lf});
    }
    if (name === 'listReplace' || name === 'listSet') {
      const lf = listFieldFromArg(0);
      if (!lf) return constInput(0);
      return input('data_replaceitemoflist', {
        LIST: lf,
        INDEX: decompileExpression(args[1], ctx),
        ITEM: decompileExpression(args[2], ctx)
      });
    }
    if (name === 'listDelete') {
      const lf = listFieldFromArg(0);
      if (!lf) return constInput(0);
      return input('data_deleteoflist', {
        LIST: lf,
        INDEX: decompileExpression(args[1], ctx)
      });
    }
    if (name === 'listInsert') {
      const lf = listFieldFromArg(0);
      if (!lf) return constInput(0);
      return input('data_insertatlist', {
        LIST: lf,
        INDEX: decompileExpression(args[1], ctx),
        ITEM: decompileExpression(args[2], ctx)
      });
    }
    if (name === 'listAdd' || name === 'listPush') {
      const lf = listFieldFromArg(0);
      if (!lf) return constInput(0);
      return input('data_addtolist', {
        LIST: lf,
        ITEM: decompileExpression(args[1], ctx)
      });
    }
    if (name === 'listClear') {
      const lf = listFieldFromArg(0);
      if (!lf) return constInput(0);
      return {opcode: 'data_deletealloflist', inputs: {}, fields: {LIST: lf}};
    }
    if (name === 'listShow') {
      const lf = listFieldFromArg(0);
      if (!lf) return constInput(0);
      return {opcode: 'data_showlist', inputs: {}, fields: {LIST: lf}};
    }
    if (name === 'listHide') {
      const lf = listFieldFromArg(0);
      if (!lf) return constInput(0);
      return {opcode: 'data_hidelist', inputs: {}, fields: {LIST: lf}};
    }
    if (name === 'limitPrecision') return decompileExpression(args[0], ctx);
    if (name === 'compareEqual') return input('operator_equals', {OPERAND1: decompileExpression(args[0], ctx), OPERAND2: decompileExpression(args[1], ctx)});
    if (name === 'compareGreaterThan') return input('operator_gt', {OPERAND1: decompileExpression(args[0], ctx), OPERAND2: decompileExpression(args[1], ctx)});
    if (name === 'compareLessThan') return input('operator_lt', {OPERAND1: decompileExpression(args[0], ctx), OPERAND2: decompileExpression(args[1], ctx)});
    if (name === 'toBoolean') return decompileExpression(args[0], ctx);
    if (name === 'toNotNaN') return decompileExpression(args[0], ctx);
    if (name === 'daysSince2000') return input('sensing_dayssince2000', {});
    if (name === 'distance') return input('sensing_distanceto', {DISTANCETOMENU: decompileExpression(args[0], ctx)});
    if (name === 'colorToList') return decompileExpression(args[0], ctx);
    if (name === 'tan') return input('operator_mathop', {OPERATOR: 'tan', NUM: decompileExpression(args[0], ctx)});

    if (name === 'executeInCompatibilityLayer') {
      return decompileCompatibilityLayerExpr(node, ctx);
    }
  }

  return constInput(0);
};

const decompileCompatibilityLayerExpr = (call, ctx) => {
  const args = call.arguments;
  if (args.length < 2) return constInput(0);
  const inputsObj = args[0];
  const opcodeFnRef = args[1];
  let opcodeName = null;
  if (t.isIdentifier(opcodeFnRef) && ctx.opcodeFnMap) opcodeName = ctx.opcodeFnMap[opcodeFnRef.name];
  if (!opcodeName) return constInput(0);
  const split = compatBlockSplit(inputsObj, opcodeName, ctx);
  return {opcode: opcodeName, inputs: split.inputs, fields: split.fields};
};

const FIELD_NAMES_BY_OPCODE = {
  'motion_setrotationstyle': ['STYLE'],
  'looks_changeeffectby': ['EFFECT'],
  'looks_seteffectto': ['EFFECT'],
  'looks_goforwardbackwardlayers': ['FORWARD_BACKWARD'],
  'looks_gotofrontback': ['FRONT_BACK'],
  'looks_costumenumbername': ['NUMBER_NAME'],
  'looks_backdropnumbername': ['NUMBER_NAME'],
  'sound_changeeffectby': ['EFFECT'],
  'sound_seteffectto': ['EFFECT'],
  'sensing_setdragmode': ['DRAG_MODE'],
  'event_whenkeypressed': ['KEY_OPTION'],
  'event_whenbackdropswitchesto': ['BACKDROP'],
  'event_whengreaterthan': ['WHENGREATERTHANMENU'],
  'event_whenbroadcastreceived': ['BROADCAST_OPTION'],
  'event_broadcast': ['BROADCAST_OPTION'],
  'event_broadcastandwait': ['BROADCAST_OPTION'],
  'control_stop': ['STOP_OPTION'],
  'sensing_current': ['CURRENTMENU'],
  'sensing_of': ['PROPERTY'],
  'operator_mathop': ['OPERATOR'],
  'argument_reporter_string_number': ['VALUE'],
  'argument_reporter_boolean': ['VALUE'],

  'data_addtolist': ['LIST'],
  'data_deleteoflist': ['LIST'],
  'data_deletealloflist': ['LIST'],
  'data_insertatlist': ['LIST'],
  'data_replaceitemoflist': ['LIST'],
  'data_itemoflist': ['LIST'],
  'data_itemnumoflist': ['LIST'],
  'data_lengthoflist': ['LIST'],
  'data_listcontainsitem': ['LIST'],
  'data_showlist': ['LIST'],
  'data_hidelist': ['LIST'],
  'data_listcontents': ['LIST'],
  'data_setvariableto': ['VARIABLE'],
  'data_changevariableby': ['VARIABLE'],
  'data_showvariable': ['VARIABLE'],
  'data_hidevariable': ['VARIABLE'],
  'data_variable': ['VARIABLE'],
};

const isVarListField = (key) => key === 'LIST' || key === 'VARIABLE' || key === 'BROADCAST_OPTION';

const resolveVarListField = (key, val, ctx) => {
  let id = null;
  let name = null;

  if (t.isStringLiteral(val)) id = val.value;
  else if (t.isNumericLiteral(val)) id = String(val.value);
  else if (t.isIdentifier(val)) {
    if (ctx.varMap && ctx.varMap[val.name]) { id = ctx.varMap[val.name].id; name = ctx.varMap[val.name].varName; }
    else if (ctx.listMap && ctx.listMap[val.name]) { id = ctx.listMap[val.name].id; name = ctx.listMap[val.name].varName; }
    else id = val.name;
  } else if (t.isMemberExpression(val)) {
    const propName = getPropName(val.property);
    if (propName) id = propName;
  } else if (t.isObjectExpression(val)) {
    for (const p of val.properties) {
      const k = p.key && (p.key.name || p.key.value);
      if (k === 'id' && (t.isStringLiteral(p.value) || t.isNumericLiteral(p.value))) id = String(p.value.value);
      if (k === 'name' && t.isStringLiteral(p.value)) name = p.value.value;
    }
  }

  if (!id) return null;

  if (!name) {
    const stage = ctx.stage;
    if (ctx.target.lists && ctx.target.lists[id]) {
      const entry = ctx.target.lists[id];
      if (Array.isArray(entry)) name = entry[0];
      else if (entry && entry.name) name = entry.name;
    }
    if (!name && stage && stage.lists && stage.lists[id]) {
      const entry = stage.lists[id];
      if (Array.isArray(entry)) name = entry[0];
      else if (entry && entry.name) name = entry.name;
    }
    if (!name && ctx.target.variables && ctx.target.variables[id]) {
      const entry = ctx.target.variables[id];
      if (Array.isArray(entry)) name = entry[0];
      else if (entry && entry.name) name = entry.name;
    }
    if (!name && stage && stage.variables && stage.variables[id]) {
      const entry = stage.variables[id];
      if (Array.isArray(entry)) name = entry[0];
      else if (entry && entry.name) name = entry.name;
    }
    if (!name) name = id;
  }
  return {name: String(name), id: String(id)};
};

const compatBlockSplit = (inputsObj, opcodeName, ctx) => {
  const fieldNames = FIELD_NAMES_BY_OPCODE[opcodeName] || [];
  const inputs = {};
  const fields = {};

  if (t.isObjectExpression(inputsObj)) {
    for (const prop of inputsObj.properties) {
      const key = prop.key && (prop.key.name || prop.key.value);
      if (!key) continue;
      const val = prop.value;

      if (t.isIdentifier(val) && ctx.paramNames && ctx.paramNames.length > 0) {
        const idx = ctx.paramNames.indexOf(val.name);
        if (idx >= 0) {
          const argName = (ctx.argNames && ctx.argNames[idx]) || `参数${idx + 1}`;
          const isBool = !!(ctx.paramTypes && ctx.paramTypes[argName] === 'boolean');
          inputs[key] = {
            opcode: isBool ? 'argument_reporter_boolean' : 'argument_reporter_string_number',
            inputs: {},
            fields: {VALUE: {value: argName}}
          };
          continue;
        }
      }
      if (t.isIdentifier(val) && /^p\d+$/.test(val.name)) {
        const idx = parseInt(val.name.slice(1), 10);
        const argName = (ctx.argNames && ctx.argNames[idx]) || `参数${idx + 1}`;
        const isBool = !!(ctx.paramTypes && ctx.paramTypes[argName] === 'boolean');
        inputs[key] = {
          opcode: isBool ? 'argument_reporter_boolean' : 'argument_reporter_string_number',
          inputs: {},
          fields: {VALUE: {value: argName}}
        };
        continue;
      }

      if (fieldNames.includes(key)) {
        if (isVarListField(key)) {
          const resolved = resolveVarListField(key, val, ctx);
          if (resolved) fields[key] = resolved;
        } else if (t.isStringLiteral(val) || t.isNumericLiteral(val) || t.isBooleanLiteral(val)) {
          fields[key] = {value: val.value};
        } else if (t.isMemberExpression(val) && getPropName(val.property) === 'value' && t.isIdentifier(val.object) && ctx.varMap && ctx.varMap[val.object.name]) {
          const v = ctx.varMap[val.object.name];
          fields[key] = {name: v.varName, id: v.id};
        } else {
          inputs[key] = decompileExpression(val, ctx);
        }
      } else {
        inputs[key] = decompileExpression(val, ctx);
      }
    }
  }
  return {inputs, fields};
};

const decompileExtCall = (ext, method, args, ctx) => {
  const key = `${ext}.${method}`;
  switch (key) {
    case 'ext_scratch3_operators._random':
      return input('operator_random', {FROM: decompileExpression(args[0], ctx), TO: decompileExpression(args[1], ctx)});
    case 'ext_scratch3_looks.clampEffect':
      return decompileExpression(args[1], ctx);
    case 'ext_scratch3_sensing._answer':
      return input('sensing_answer', {});
    case 'ext_scratch3_control._counter':
      return input('control_get_counter', {});

    case 'ext_scratch3_motion._moveSteps': return input('motion_movesteps', {STEPS: decompileExpression(args[0], ctx)});
    case 'ext_scratch3_motion._ifOnEdgeBounce': return input('motion_ifonedgebounce', {});

    
    case 'ext_scratch3_looks._setCostume': {
      const arg = args.length > 1 ? args[1] : args[0];
      return input('looks_switchcostumeto', {COSTUME: decompileExpression(arg, ctx)});
    }
    case 'ext_scratch3_looks._setBackdrop': {
      const arg = args.length > 1 ? args[1] : args[0];
      return input('looks_switchbackdropto', {BACKDROP: decompileExpression(arg, ctx)});
    }
    case 'ext_scratch3_looks._say': {
      const arg = args.length > 1 ? args[1] : args[0];
      return input('looks_say', {MESSAGE: decompileExpression(arg, ctx)});
    }
    case 'ext_scratch3_looks._think': {
      const arg = args.length > 1 ? args[1] : args[0];
      return input('looks_think', {MESSAGE: decompileExpression(arg, ctx)});
    }
    case 'ext_scratch3_looks._renderBubble': return IGNORED;

    
    case 'ext_scratch3_sound._playSound': {
      const arg = args.length > 1 ? args[1] : args[0];
      return input('sound_play', {SOUND_MENU: decompileExpression(arg, ctx)});
    }
    case 'ext_scratch3_sound._playSoundAndWait': {
      const arg = args.length > 1 ? args[1] : args[0];
      return input('sound_playuntildone', {SOUND_MENU: decompileExpression(arg, ctx)});
    }

    case 'ext_scratch3_control._createClone': return input('control_create_clone_of', {CLONE_OPTION: decompileExpression(args[0], ctx)});

    case 'ext_pen._penDown': return input('pen_penDown', {});
    case 'ext_pen._penUp': return input('pen_penUp', {});
    case 'ext_pen.clear': return input('pen_clear', {});
    case 'ext_pen._stamp': return input('pen_stamp', {});
    case 'ext_pen._setPenSizeTo': return input('pen_setPenSizeTo', {SIZE: decompileExpression(args[0], ctx)});
    case 'ext_pen._changePenSizeBy': return input('pen_changePenSizeBy', {SIZE: decompileExpression(args[0], ctx)});
    case 'ext_pen._setPenColorToColor': return input('pen_setPenColorToColor', {COLOR: decompileExpression(args[0], ctx)});
    case 'ext_pen._setOrChangeColorParam': {
      const isChange = args[3] && args[3].value === true;
      return input(isChange ? 'pen_changePenColorParamBy' : 'pen_setPenColorParamTo', {
        COLOR_PARAM: decompileExpression(args[0], ctx),
        VALUE: decompileExpression(args[1], ctx)
      });
    }
    case 'ext_pen._setPenHueToNumber': return input('pen_setPenHueToNumber', {HUE: decompileExpression(args[0], ctx)});
    case 'ext_pen._changePenHueBy': return input('pen_changePenHueBy', {HUE: decompileExpression(args[0], ctx)});
    case 'ext_pen._setPenShadeToNumber': return input('pen_setPenShadeToNumber', {SHADE: decompileExpression(args[0], ctx)});
    case 'ext_pen._changePenShadeBy': return input('pen_changePenShadeBy', {SHADE: decompileExpression(args[0], ctx)});
  }
  return decompileCustomExtensionCall(ext, method, args, ctx);
};

const decompileTargetCall = (method, args, ctx) => {
  const arg = (i) => decompileExpression(args[i], ctx);
  switch (method) {
    case 'setXY': {
      const xArg = args[0], yArg = args[1];
      const isXChange = t.isBinaryExpression(xArg) && xArg.operator === '+' &&
        t.isMemberExpression(xArg.left) && getPropName(xArg.left.property) === 'x';
      const isYChange = t.isBinaryExpression(yArg) && yArg.operator === '+' &&
        t.isMemberExpression(yArg.left) && getPropName(yArg.left.property) === 'y';
      const xIsTargetX = t.isMemberExpression(xArg) && getPropName(xArg.property) === 'x' &&
        t.isIdentifier(xArg.object) && xArg.object.name === 'target';
      const yIsTargetY = t.isMemberExpression(yArg) && getPropName(yArg.property) === 'y' &&
        t.isIdentifier(yArg.object) && yArg.object.name === 'target';

      if (isXChange && yIsTargetY) return input('motion_changexby', {DX: decompileExpression(xArg.right, ctx)});
      if (isYChange && xIsTargetX) return input('motion_changeyby', {DY: decompileExpression(yArg.right, ctx)});
      if (xIsTargetX && yIsTargetY) return null;
      if (xIsTargetX) return input('motion_sety', {Y: arg(1)});
      if (yIsTargetY) return input('motion_setx', {X: arg(0)});
      return input('motion_gotoxy', {X: arg(0), Y: arg(1)});
    }
    case 'setX': return input('motion_setx', {X: arg(0)});
    case 'setY': return input('motion_sety', {Y: arg(0)});
    case 'setDirection': {
      const dArg = args[0];
      if (t.isBinaryExpression(dArg) && dArg.operator === '+' &&
          t.isMemberExpression(dArg.left) && getPropName(dArg.left.property) === 'direction') {
        return input('motion_turnright', {DEGREES: decompileExpression(dArg.right, ctx)});
      }
      if (t.isBinaryExpression(dArg) && dArg.operator === '-' &&
          t.isMemberExpression(dArg.left) && getPropName(dArg.left.property) === 'direction') {
        return input('motion_turnleft', {DEGREES: decompileExpression(dArg.right, ctx)});
      }
      return input('motion_pointindirection', {DIRECTION: arg(0)});
    }
    case 'setVisible':
      if (t.isBooleanLiteral(args[0])) return input(args[0].value ? 'looks_show' : 'looks_hide', {});
      return null;
    case 'setSize': {
      const sArg = args[0];
      if (t.isBinaryExpression(sArg) && sArg.operator === '+' &&
          t.isMemberExpression(sArg.left) && getPropName(sArg.left.property) === 'size') {
        return input('looks_changesizeby', {CHANGE: decompileExpression(sArg.right, ctx)});
      }
      return input('looks_setsizeto', {SIZE: decompileExpression(sArg, ctx)});
    }
    case 'setEffect': {
      const effect = args[0] && args[0].value;
      let valueExpr = args[1];
      if (t.isCallExpression(valueExpr) &&
          t.isMemberExpression(valueExpr.callee) &&
          t.isMemberExpression(valueExpr.callee.object) &&
          getPropName(valueExpr.callee.object.property) === 'ext_scratch3_looks' &&
          getPropName(valueExpr.callee.property) === 'clampEffect') {
        valueExpr = valueExpr.arguments[1];
      }
      const isChange = t.isBinaryExpression(valueExpr) && valueExpr.operator === '+' &&
        t.isMemberExpression(valueExpr.left) && getPropName(valueExpr.left.property) === 'effects';
      const valuePart = isChange ? decompileExpression(valueExpr.right, ctx) : decompileExpression(valueExpr, ctx);
      return {
        opcode: isChange ? 'looks_changeeffectby' : 'looks_seteffectto',
        inputs: isChange ? {CHANGE: valuePart} : {VALUE: valuePart},
        fields: {EFFECT: {value: String(effect || 'color').toUpperCase()}}
      };
    }
    case 'clearEffects': return input('looks_cleargraphiceffects', {});
    case 'setCostume':
      if (t.isBinaryExpression(args[0]) && args[0].operator === '+' &&
          t.isMemberExpression(args[0].left) && getPropName(args[0].left.property) === 'currentCostume') {
        return input('looks_nextcostume', {});
      }
      return input('looks_switchcostumeto', {COSTUME: arg(0)});
    case 'goToFront': return {opcode: 'looks_gotofrontback', inputs: {}, fields: {FRONT_BACK: {value: 'front'}}};
    case 'goToBack': return {opcode: 'looks_gotofrontback', inputs: {}, fields: {FRONT_BACK: {value: 'back'}}};
    case 'goForwardLayers': return {opcode: 'looks_goforwardbackwardlayers', inputs: {NUM: arg(0)}, fields: {FORWARD_BACKWARD: {value: 'forward'}}};
    case 'goBackwardLayers': return {opcode: 'looks_goforwardbackwardlayers', inputs: {NUM: arg(0)}, fields: {FORWARD_BACKWARD: {value: 'backward'}}};
    case 'setRotationStyle': {
      const style = args[0] && args[0].value;
      return {opcode: 'motion_setrotationstyle', inputs: {}, fields: {STYLE: {value: String(style || 'all around')}}};
    }
    case 'isTouchingObject': return input('sensing_touchingobject', {TOUCHINGOBJECTMENU: arg(0)});
    case 'isTouchingColor': return input('sensing_touchingcolor', {COLOR: arg(0)});
    case 'colorIsTouchingColor': return input('sensing_coloristouchingcolor', {COLOR: arg(1), COLOR2: arg(0)});
  }
  return null;
};


const decompileMember = (node, ctx) => {
  if (isTargetRef(node.object, ctx)) {
    const p = getPropName(node.property);
    switch (p) {
      case 'x': return input('motion_xposition', {});
      case 'y': return input('motion_yposition', {});
      case 'direction': return input('motion_direction', {});
      case 'size': return input('looks_size', {});
      case 'currentCostume': return input('looks_costumenumbername', {});
      case 'volume': return input('sound_volume', {});
    }
  }
  if (isStageRef(node.object, ctx)) {
    const p = getPropName(node.property);
    if (p === 'currentCostume') return input('looks_backdropnumbername', {});
  }

  if (t.isMemberExpression(node.object) && isRuntimeRef(node.object.object, ctx)) {
    const ext = getPropName(node.object.property);
    const prop = getPropName(node.property);
    const key = `${ext}.${prop}`;
    switch (key) {
      case 'ext_scratch3_sensing._answer': return input('sensing_answer', {});
      case 'ext_scratch3_control._counter': return input('control_get_counter', {});
    }
  }

  if (t.isMemberExpression(node.object) &&
      getPropName(node.object.property) === 'variables' &&
      isTargetRef(node.object.object, ctx) &&
      getPropName(node.property) === 'value') {
    const varId = t.isStringLiteral(node.object.property) ? node.object.property.value : null;
    if (varId) {
      const isList = (ctx.target && ctx.target.lists && ctx.target.lists[varId]) ||
                     (ctx.stage && ctx.stage.lists && ctx.stage.lists[varId]);
      const varName = lookupVarName(varId, ctx);
      if (isList) return input('data_listcontents', {LIST: {name: varName, id: varId}});
      return input('data_variable', {VARIABLE: {name: varName, id: varId}});
    }
  }

  if (getPropName(node.property) === 'value' && t.isIdentifier(node.object) && ctx.refMap && ctx.refMap[node.object.name]) {
    const ref = ctx.refMap[node.object.name];
    const varId = ref.id;
    const isList = (ctx.target && ctx.target.lists && ctx.target.lists[varId]) ||
                   (ctx.stage && ctx.stage.lists && ctx.stage.lists[varId]);
    const varName = lookupVarName(varId, ctx);
    if (isList) return input('data_listcontents', {LIST: {name: varName, id: varId}});
    return input('data_variable', {VARIABLE: {name: varName, id: varId}});
  }

  if (t.isNumericLiteral(node.property) &&
      t.isMemberExpression(node.object) &&
      getPropName(node.object.property) === 'value') {
    const listRef = node.object.object;
    let listInfo = null;
    if (t.isIdentifier(listRef) && ctx.listMap && ctx.listMap[listRef.name]) {
      const l = ctx.listMap[listRef.name];
      listInfo = {name: l.varName, id: l.id};
    } else if (t.isIdentifier(listRef) && ctx.refMap && ctx.refMap[listRef.name]) {
      const ref = ctx.refMap[listRef.name];
      const isList = (ctx.target && ctx.target.lists && ctx.target.lists[ref.id]) ||
                     (ctx.stage && ctx.stage.lists && ctx.stage.lists[ref.id]);
      if (isList) {
        const name = lookupVarName(ref.id, ctx);
        listInfo = {name, id: ref.id};
      }
    } else if (t.isMemberExpression(listRef) &&
               getPropName(listRef.property) === 'variables' &&
               isTargetRef(listRef.object, ctx) &&
               t.isStringLiteral(listRef.property)) {
      const lid = listRef.property.value;
      const isList = (ctx.target && ctx.target.lists && ctx.target.lists[lid]) ||
                     (ctx.stage && ctx.stage.lists && ctx.stage.lists[lid]);
      if (isList) {
        const name = lookupVarName(lid, ctx);
        listInfo = {name, id: lid};
      }
    }
    if (listInfo) {
      return input('data_itemoflist', {
        LIST: listInfo,
        INDEX: constInput(node.property.value)
      });
    }
  }

  if (getPropName(node.property) === 'length') {
    return input('operator_length', {STRING: decompileExpression(node.object, ctx)});
  }

  if (getPropName(node.property) === 'value') {
    return decompileExpression(node.object, ctx);
  }

  return decompileExpression(node.object, ctx);
};

const decompileStatement = (node, ctx) => {
  if (!node) return null;

  if (t.isReturnStatement(node)) {
    if (!node.argument) return null;
    if (t.isStringLiteral(node.argument) && node.argument.value === '') return null;
    return {
      opcode: 'procedures_return',
      inputs: {VALUE: decompileExpression(node.argument, ctx)}
    };
  }

  if (t.isExpressionStatement(node)) return decompileExpressionStatement(node.expression, ctx);
  if (t.isIfStatement(node)) return decompileIf(node, ctx);
  if (t.isWhileStatement(node)) return decompileWhile(node, ctx);
  if (t.isDoWhileStatement(node)) return decompileDoWhile(node, ctx);
  if (t.isForStatement(node)) return decompileFor(node, ctx);
  if (t.isForOfStatement(node) || t.isForInStatement(node)) return decompileBlock(stmtList(node.body), ctx);
  if (t.isTryStatement(node)) return decompileBlock(node.block ? node.block.body : [], ctx);
  if (t.isSwitchStatement(node)) {
    const blocks = [];
    for (const c of node.cases) {
      const r = decompileBlock(c.consequent, ctx);
      for (const b of r.blocks) blocks.push(b);
    }
    return blocks.length > 0 ? {blocks} : null;
  }
  if (t.isBreakStatement(node)) return {opcode: 'control_stop', fields: {STOP_OPTION: {value: 'this script'}}};
  if (t.isContinueStatement(node)) return null;
  if (t.isEmptyStatement(node)) return null;
  if (t.isVariableDeclaration(node)) {
    const blocks = [];
    for (const decl of node.declarations) {
      if (decl.init && t.isCallExpression(decl.init)) {
        const r = decompileExpressionStatement(decl.init, ctx);
        for (const b of asBlocks(r)) blocks.push(b);
      }
    }
    return blocks.length > 0 ? {blocks} : null;
  }
  if (t.isBlockStatement(node)) return decompileBlock(node.body, ctx);
  if (t.isLabeledStatement(node)) return decompileStatement(node.body, ctx);
  return null;
};

const tryParseHatEdge = (statements, i, ctx) => {
  const s = statements[i];
  if (!t.isBlockStatement(s)) return null;
  const body = s.body;
  if (body.length < 4) return null;
  const last = body[body.length - 1];
  if (!t.isExpressionStatement(last) || !t.isYieldExpression(last.expression)) return null;

  let hatInputsObj = null;
  for (const stmt of body) {
    if (t.isVariableDeclaration(stmt)) {
      const d = stmt.declarations[0];
      if (d && d.init) {
        let call = d.init;
        if (t.isYieldExpression(call)) call = call.argument;
        if (t.isCallExpression(call) && t.isIdentifier(call.callee) && call.callee.name === 'executeInCompatibilityLayer') {
          const a = call.arguments[0];
          if (a && t.isObjectExpression(a)) hatInputsObj = a;
          break;
        }
      }
    }
  }

  if (!hatInputsObj) {
    const keySet = new Set([
      'VALUE', 'WHENGREATERTHANMENU', 'KEY_OPTION', 'BACKDROP',
      'BROADCAST_OPTION', 'CONDITION', 'TOUCHINGOBJECTMENU', 'DISTANCETOMENU',
      'COSTUME', 'SOUND_MENU', 'TO', 'TOWARDS', 'CLONE_OPTION',
    ]);
    for (const stmt of body) {
      const r = findObjectExprWithKeys(stmt, keySet);
      if (r) { hatInputsObj = r; break; }
    }
  }
  return {next: i + 1, hatInputsObj};
};

const tryParseHatPredicate = (statements, i) => {
  const s = statements[i];
  if (!t.isIfStatement(s)) return null;
  if (!t.isUnaryExpression(s.test) || s.test.operator !== '!') return null;
  const cons = s.consequent;
  if (!t.isBlockStatement(cons) || cons.body.length < 1) return null;
  const first = cons.body[0];
  if (!t.isExpressionStatement(first)) return null;
  if (!t.isCallExpression(first.expression)) return null;
  if (!t.isIdentifier(first.expression.callee) || first.expression.callee.name !== 'retire') return null;
  const next = statements[i + 1];
  if (!t.isExpressionStatement(next) || !t.isYieldExpression(next.expression)) return null;
  return {next: i + 2};
};

const decompileExpressionStatement = (expr, ctx) => {
  if (!expr) return null;
  if (isIIFE(expr)) {
    const inner = iifeStatements(expr);
    if (inner.length > 0) {
      const r = decompileBlock(inner, ctx);
      if (r.blocks.length > 0) return r;
    }
    return null;
  }
  if (t.isAssignmentExpression(expr)) return decompileAssignment(expr, ctx);
  if (t.isCallExpression(expr)) {
    const r = decompileCallStatement(expr, ctx);
    if (r === IGNORED) return null;
    return r;
  }
  if (t.isUpdateExpression(expr)) return decompileUpdate(expr, ctx);
  if (t.isYieldExpression(expr)) {
    if (t.isCallExpression(expr.argument)) {
      const r = decompileCallStatement(expr.argument, ctx);
      if (r === IGNORED) return null;
      return r;
    }
    if (t.isMemberExpression(expr.argument)) return null;
    return null;
  }
  if (t.isSequenceExpression(expr)) {
    const blocks = [];
    for (const sub of expr.expressions) {
      const r = decompileExpressionStatement(sub, ctx);
      for (const b of asBlocks(r)) blocks.push(b);
    }
    return blocks.length > 0 ? {blocks} : null;
  }
  if (t.isConditionalExpression(expr)) {
    const prev = ctx.expectBoolean; ctx.expectBoolean = true;
    const cond = decompileExpression(expr.test, ctx);
    ctx.expectBoolean = prev;
    const trueBlocks = asBlocks(decompileExpressionStatement(expr.consequent, ctx));
    const falseBlocks = expr.alternate ? asBlocks(decompileExpressionStatement(expr.alternate, ctx)) : [];
    if (falseBlocks.length > 0) return {opcode: 'control_if_else', inputs: {CONDITION: cond, SUBSTACK: {blocks: trueBlocks}, SUBSTACK2: {blocks: falseBlocks}}};
    return {opcode: 'control_if', inputs: {CONDITION: cond, SUBSTACK: {blocks: trueBlocks}}};
  }
  if (t.isLogicalExpression(expr)) {
    if (expr.operator === '&&') {
      const prev = ctx.expectBoolean; ctx.expectBoolean = true;
      const cond = decompileExpression(expr.left, ctx);
      ctx.expectBoolean = prev;
      const trueBlocks = asBlocks(decompileExpressionStatement(expr.right, ctx));
      if (trueBlocks.length > 0) return {opcode: 'control_if', inputs: {CONDITION: cond, SUBSTACK: {blocks: trueBlocks}}};
      return null;
    }
    if (expr.operator === '||' || expr.operator === '??') {
      const prev = ctx.expectBoolean; ctx.expectBoolean = true;
      const cond = input('operator_not', {OPERAND: decompileExpression(expr.left, ctx)});
      ctx.expectBoolean = prev;
      const trueBlocks = asBlocks(decompileExpressionStatement(expr.right, ctx));
      if (trueBlocks.length > 0) return {opcode: 'control_if', inputs: {CONDITION: cond, SUBSTACK: {blocks: trueBlocks}}};
      return null;
    }
  }
  return null;
};

const decompileUpdate = (expr, ctx) => {
  const arg = expr.argument;
  if (t.isMemberExpression(arg) &&
      t.isMemberExpression(arg.object) &&
      isRuntimeRef(arg.object.object, ctx) &&
      getPropName(arg.object.property) === 'ext_scratch3_control' &&
      getPropName(arg.property) === '_counter') {
    return expr.operator === '++' ? input('control_incr_counter', {}) : null;
  }
  return null;
};

const decompileAssignment = (expr, ctx) => {
  const left = expr.left;
  const right = expr.right;
  if (!t.isMemberExpression(left)) return null;
  const obj = left.object;
  const op = expr.operator;

  if (getPropName(left.property) === 'value' && t.isIdentifier(obj) && ctx.refMap && ctx.refMap[obj.name]) {
    const ref = ctx.refMap[obj.name];
    const varId = ref.id;
    const varName = lookupVarName(varId, ctx);
    const isList = (ctx.target && ctx.target.lists && ctx.target.lists[varId]) ||
                   (ctx.stage && ctx.stage.lists && ctx.stage.lists[varId]);

    if (isList) {
      if (t.isArrayExpression(right) && right.elements.length === 0) {
        return {opcode: 'data_deletealloflist', inputs: {}, fields: {LIST: {name: varName, id: varId}}};
      }
      return null;
    }

    if (op === '+=' || op === '-=') {
      const r = decompileExpression(right, ctx);
      const delta = op === '+=' ? r : input('operator_subtract', {NUM1: constInput(0), NUM2: r});
      return {
        opcode: 'data_changevariableby',
        inputs: {VALUE: delta},
        fields: {VARIABLE: {name: varName, id: varId}}
      };
    }
    if (op === '=') {
      if (t.isBinaryExpression(right) && right.operator === '+' &&
          t.isMemberExpression(right.left) &&
          getPropName(right.left.property) === 'value' &&
          t.isIdentifier(right.left.object) && right.left.object.name === obj.name) {
        return {
          opcode: 'data_changevariableby',
          inputs: {VALUE: decompileExpression(right.right, ctx)},
          fields: {VARIABLE: {name: varName, id: varId}}
        };
      }
      return {
        opcode: 'data_setvariableto',
        inputs: {VALUE: decompileExpression(right, ctx)},
        fields: {VARIABLE: {name: varName, id: varId}}
      };
    }
  }

  if (getPropName(left.property) === 'value' &&
      t.isMemberExpression(obj) &&
      getPropName(obj.property) === 'variables' &&
      isTargetRef(obj.object, ctx) &&
      t.isStringLiteral(obj.property)) {
    const varId = obj.property.value;
    const varName = lookupVarName(varId, ctx);
    const isList = (ctx.target && ctx.target.lists && ctx.target.lists[varId]) ||
                   (ctx.stage && ctx.stage.lists && ctx.stage.lists[varId]);

    if (isList) {
      if (t.isArrayExpression(right) && right.elements.length === 0) {
        return {opcode: 'data_deletealloflist', inputs: {}, fields: {LIST: {name: varName, id: varId}}};
      }
      return null;
    }

    if (op === '+=' || op === '-=') {
      const r = decompileExpression(right, ctx);
      const delta = op === '+=' ? r : input('operator_subtract', {NUM1: constInput(0), NUM2: r});
      return {
        opcode: 'data_changevariableby',
        inputs: {VALUE: delta},
        fields: {VARIABLE: {name: varName, id: varId}}
      };
    }
    if (op === '=') {
      if (t.isBinaryExpression(right) && right.operator === '+' &&
          t.isMemberExpression(right.left) &&
          getPropName(right.left.property) === 'value' &&
          right.left.object === obj) {
        return {
          opcode: 'data_changevariableby',
          inputs: {VALUE: decompileExpression(right.right, ctx)},
          fields: {VARIABLE: {name: varName, id: varId}}
        };
      }
      return {
        opcode: 'data_setvariableto',
        inputs: {VALUE: decompileExpression(right, ctx)},
        fields: {VARIABLE: {name: varName, id: varId}}
      };
    }
  }

  if (t.isMemberExpression(obj) &&
      isRuntimeRef(obj.object, ctx) &&
      getPropName(obj.property) === 'ext_scratch3_control' &&
      getPropName(left.property) === '_counter' &&
      t.isNumericLiteral(right) && right.value === 0) {
    return input('control_clear_counter', {});
  }

  return null;
};

const unwrapGuardCondition = (test) => {
  const isConstCmp = (n, ops) => {
    if (!t.isBinaryExpression(n) || !ops.includes(n.operator)) return false;
    const lv = getLitVal(n.left);
    const rv = getLitVal(n.right);
    return lv !== null && rv !== null && lv === rv;
  };
  if (t.isUnaryExpression(test) && test.operator === '!') {
    if (isConstCmp(test.argument, ['===', '=='])) return 'always-false';
  }
  if (isConstCmp(test, ['===', '=='])) return 'always-true';
  if (isConstCmp(test, ['!==', '!='])) return 'always-false';
  return null;
};

const decompileIf = (node, ctx) => {
  const test = node.test;
  const guard = unwrapGuardCondition(test);

  if (guard === 'always-true') {
    return decompileBlock(stmtList(node.consequent), ctx);
  }
  if (guard === 'always-false') {
    if (node.alternate) return decompileBlock(stmtList(node.alternate), ctx);
    return null;
  }

  const trueBody = decompileBlock(stmtList(node.consequent), ctx);
  let falseBody = {blocks: []};
  if (node.alternate) {
    if (t.isIfStatement(node.alternate)) {
      const nested = decompileIf(node.alternate, ctx);
      const nb = asBlocks(nested);
      if (nb.length > 0) falseBody = {blocks: nb};
    } else {
      falseBody = decompileBlock(stmtList(node.alternate), ctx);
    }
  }
  if (trueBody.blocks.length === 0 && falseBody.blocks.length === 0) return null;

  const prev = ctx.expectBoolean; ctx.expectBoolean = true;
  const condition = decompileExpression(test, ctx);
  ctx.expectBoolean = prev;

  if (node.alternate) {
    return {opcode: 'control_if_else', inputs: {CONDITION: condition, SUBSTACK: trueBody, SUBSTACK2: falseBody}};
  }
  return {opcode: 'control_if', inputs: {CONDITION: condition, SUBSTACK: trueBody}};
};

const decompileWhile = (node, ctx) => {
  const test = node.test;
  const bodyStatements = stmtList(node.body);
  const body = decompileBlock(bodyStatements, ctx);

  if (t.isBooleanLiteral(test) && test.value === true) {
    return {opcode: 'control_forever', inputs: {SUBSTACK: body}};
  }

  const isPureYield = bodyStatements.length === 1 &&
    t.isExpressionStatement(bodyStatements[0]) &&
    t.isYieldExpression(bodyStatements[0].expression);

  let innerTest = test;
  let negate = false;
  while (true) {
    if (t.isUnaryExpression(innerTest) && innerTest.operator === '!') {
      innerTest = innerTest.argument;
      negate = !negate;
      continue;
    }
    if (t.isBinaryExpression(innerTest) &&
        (innerTest.operator === '===' || innerTest.operator === '==')) {
      const R = innerTest.right, L = innerTest.left;
      if ((t.isNumericLiteral(R) && R.value === 0) ||
          (t.isBooleanLiteral(R) && R.value === false)) {
        innerTest = innerTest.left;
        negate = !negate;
        continue;
      }
      if ((t.isNumericLiteral(L) && L.value === 0) ||
          (t.isBooleanLiteral(L) && L.value === false)) {
        innerTest = innerTest.right;
        negate = !negate;
        continue;
      }
    }
    break;
  }

  const prev = ctx.expectBoolean; ctx.expectBoolean = true;
  const innerCondition = decompileExpression(innerTest, ctx);
  ctx.expectBoolean = prev;

  if (isPureYield) {
    const condition = negate ? innerCondition : input('operator_not', {OPERAND: innerCondition});
    return {opcode: 'control_wait_until', inputs: {CONDITION: condition}};
  }

  if (negate) return {opcode: 'control_repeat_until', inputs: {CONDITION: innerCondition, SUBSTACK: body}};
  return {opcode: 'control_while', inputs: {CONDITION: innerCondition, SUBSTACK: body}};
};

const decompileDoWhile = (node, ctx) => {
  const test = node.test;
  const body = decompileBlock(stmtList(node.body), ctx);
  let innerTest = test;
  let negate = false;
  while (t.isUnaryExpression(innerTest) && innerTest.operator === '!') {
    innerTest = innerTest.argument;
    negate = !negate;
  }
  const prev = ctx.expectBoolean; ctx.expectBoolean = true;
  const innerCondition = decompileExpression(innerTest, ctx);
  ctx.expectBoolean = prev;
  const condition = negate ? innerCondition : input('operator_not', {OPERAND: innerCondition});
  return {opcode: 'control_repeat_until', inputs: {CONDITION: condition, SUBSTACK: body}};
};

const decompileFor = (node, ctx) => {
  const init = node.init, test = node.test;
  if (t.isVariableDeclaration(init) && init.declarations.length === 1) {
    const times = init.declarations[0].init;
    if (test && (t.isBinaryExpression(test) && (test.operator === '>=' || test.operator === '>'))) {
      return {opcode: 'control_repeat', inputs: {TIMES: decompileExpression(times, ctx), SUBSTACK: decompileBlock(stmtList(node.body), ctx)}};
    }
  }
  const inner = decompileBlock(stmtList(node.body), ctx);
  if (inner.blocks.length > 0) return {blocks: inner.blocks};
  return null;
};

const tryParseWait = (statements, i, ctx) => {
  if (i + 4 >= statements.length) return null;
  const s0 = statements[i];
  if (!t.isExpressionStatement(s0)) return null;
  const e0 = s0.expression;
  if (!t.isAssignmentExpression(e0)) return null;
  if (!t.isMemberExpression(e0.left)) return null;
  if (getPropName(e0.left.property) !== 'timer') return null;
  if (!t.isCallExpression(e0.right) || e0.right.callee.name !== 'timer') return null;

  const s1 = statements[i + 1];
  if (!t.isVariableDeclaration(s1)) return null;
  const decl = s1.declarations[0];
  if (!decl || !t.isCallExpression(decl.init)) return null;
  if (!t.isMemberExpression(decl.init.callee)) return null;
  if (getPropName(decl.init.callee.property) !== 'max') return null;
  const maxArgs = decl.init.arguments;
  if (maxArgs.length < 2) return null;

  let durationExpr = maxArgs[1];
  let durationConst = null;
  if (t.isBinaryExpression(durationExpr) && durationExpr.operator === '*') {
    if (t.isNumericLiteral(durationExpr.left) && durationExpr.left.value === 1000) durationExpr = durationExpr.right;
    else if (t.isNumericLiteral(durationExpr.right) && durationExpr.right.value === 1000) durationExpr = durationExpr.left;
    else durationExpr = {type: 'BinaryExpression', operator: '/', left: durationExpr, right: {type: 'NumericLiteral', value: 1000}};
  } else if (t.isNumericLiteral(durationExpr)) {
    durationConst = durationExpr.value / 1000;
    durationExpr = null;
  } else if (t.isUnaryExpression(durationExpr) && durationExpr.operator === '-' &&
             t.isNumericLiteral(durationExpr.argument)) {
    durationConst = -durationExpr.argument.value / 1000;
    durationExpr = null;
  } else {
    durationExpr = {type: 'BinaryExpression', operator: '/', left: durationExpr, right: {type: 'NumericLiteral', value: 1000}};
  }

  let offset = 0;
  if (i + 2 < statements.length) {
    const maybeRedraw = statements[i + 2];
    if (t.isExpressionStatement(maybeRedraw) && t.isCallExpression(maybeRedraw.expression)) {
      const ce = maybeRedraw.expression;
      if (t.isMemberExpression(ce.callee) && getPropName(ce.callee.property) === 'requestRedraw') offset = 1;
    }
  }
  if (i + 2 + offset >= statements.length) return null;
  const yieldStmt = statements[i + 2 + offset];
  if (!t.isExpressionStatement(yieldStmt) || !t.isYieldExpression(yieldStmt.expression)) return null;
  if (i + 3 + offset >= statements.length) return null;
  const whileStmt = statements[i + 3 + offset];
  if (!t.isWhileStatement(whileStmt)) return null;
  if (i + 4 + offset >= statements.length) return null;
  const nullStmt = statements[i + 4 + offset];
  if (!t.isExpressionStatement(nullStmt)) return null;
  const ne = nullStmt.expression;
  if (!t.isAssignmentExpression(ne)) return null;
  if (!t.isMemberExpression(ne.left)) return null;
  if (getPropName(ne.left.property) !== 'timer') return null;
  if (!t.isNullLiteral(ne.right)) return null;

  const durationInput = durationExpr ? decompileExpression(durationExpr, ctx) : constInput(durationConst);
  return {
    block: {opcode: 'control_wait', inputs: {DURATION: durationInput}},
    next: i + 5 + offset
  };
};

const isIgnorableStatement = (stmt, ctx) => {
  if (!stmt) return true;
  if (t.isEmptyStatement(stmt)) return true;
  if (t.isContinueStatement(stmt)) return true;
  if (t.isDebuggerStatement(stmt)) return true;
  if (t.isFunctionDeclaration(stmt)) return true;
  if (t.isReturnStatement(stmt)) {
    if (!stmt.argument) return true;
    if (t.isStringLiteral(stmt.argument) && stmt.argument.value === '') return true;
  }

  if (t.isIfStatement(stmt)) {
    if (t.isIdentifier(stmt.test) && stmt.test.name === 'hasResumedFromPromise') {
      return true;
    }
    if (t.isCallExpression(stmt.test) &&
        t.isIdentifier(stmt.test.callee) &&
        stmt.test.callee.name === 'isStuck') {
      return true;
    }
    if (t.isUnaryExpression(stmt.test) && stmt.test.operator === '!') {
      const arg = stmt.test.argument;
      if (t.isCallExpression(arg) &&
          t.isIdentifier(arg.callee) &&
          arg.callee.name === 'isStuck') {
        return true;
      }
    }
  }

  if (t.isExpressionStatement(stmt)) {
    const e = stmt.expression;
    if (t.isStringLiteral(e)) return true;
    if (t.isYieldExpression(e) && !e.argument) return true;

    if (t.isCallExpression(e) && t.isIdentifier(e.callee) && e.callee.name === 'retire') return true;

    if (t.isCallExpression(e) &&
        t.isMemberExpression(e.callee) &&
        isRuntimeRef(e.callee.object, ctx)) {
      const m = getPropName(e.callee.property);
      if (m === 'stopForTarget') return true;
      if (m === '_renderBubble') return true;
    }
    if (t.isCallExpression(e) &&
        t.isMemberExpression(e.callee) &&
        t.isMemberExpression(e.callee.object) &&
        isRuntimeRef(e.callee.object.object, ctx) &&
        getPropName(e.callee.object.property) === 'ext_scratch3_looks' &&
        getPropName(e.callee.property) === '_renderBubble') return true;

    if (t.isCallExpression(e) &&
        t.isMemberExpression(e.callee) &&
        t.isMemberExpression(e.callee.object) &&
        isRuntimeRef(e.callee.object.object, ctx) &&
        getPropName(e.callee.object.property) === 'monitorBlocks' &&
        getPropName(e.callee.property) === 'changeBlock') return true;

    if (t.isAssignmentExpression(e)) {
      if (t.isIdentifier(e.left) && isCompilerInternalName(e.left.name)) return true;
      if (t.isMemberExpression(e.left) &&
          t.isIdentifier(e.left.object) &&
          isCompilerInternalName(e.left.object.name)) return true;
      if (t.isMemberExpression(e.left) &&
          t.isMemberExpression(e.left.object) &&
          t.isIdentifier(e.left.object.object) &&
          isCompilerInternalName(e.left.object.object.name)) return true;
    }

    if (t.isUpdateExpression(e)) {
      const arg = e.argument;
      if (t.isIdentifier(arg) && isCompilerInternalName(arg.name)) return true;
      if (t.isMemberExpression(arg) && t.isIdentifier(arg.object) && isCompilerInternalName(arg.object.name)) return true;
    }
  }
  return false;
};

const decompileBlock = (statements, ctx) => {
  const blocks = [];
  if (!statements) return {blocks};
  let i = 0;
  while (i < statements.length) {
    const stmt = statements[i];
    if (!stmt) { i++; continue; }

    const he = tryParseHatEdge(statements, i, ctx);
    if (he) { i = he.next; continue; }

    const hp = tryParseHatPredicate(statements, i);
    if (hp) { i = hp.next; continue; }

    const waitInfo = tryParseWait(statements, i, ctx);
    if (waitInfo) {
      blocks.push(waitInfo.block);
      i = waitInfo.next;
      continue;
    }

    const result = decompileStatement(stmt, ctx);
    const list = asBlocks(result);
    if (list.length > 0) {
      for (const b of list) blocks.push(b);
    } else if (!isIgnorableStatement(stmt, ctx)) {
      const src = getSource(stmt, ctx);
      if (ctx && ctx.log) ctx.log(`[unresolved] type=${stmt.type} srcLen=${src.length}`);
      blocks.push(PLACEHOLDER(src));
    }
    i++;
  }
  return {blocks};
};

const decompileCallStatement = (call, ctx) => {
  const callee = call.callee;

  {
    const r = matchThreadProceduresCall(call, ctx, false);
    if (r) return r;
  }
  {
    const r = matchYieldThenCall(call, ctx, false);
    if (r) return r;
  }

  if (t.isIdentifier(callee) && callee.name === 'retire') return null;

  if (t.isMemberExpression(callee) && isRuntimeRef(callee.object, ctx)) {
    const m = getPropName(callee.property);
    if (m === 'disposeTarget') return input('control_delete_this_clone', {});
    if (m === 'stopForTarget') return null;
    if (m === 'stopAll') return {opcode: 'control_stop', fields: {STOP_OPTION: {value: 'all'}}};
  }

  if (t.isIdentifier(callee) && callee.name === 'waitThreads') {
    const inner = call.arguments[0];
    if (t.isCallExpression(inner) && t.isIdentifier(inner.callee) && inner.callee.name === 'startHats') {
      const first = inner.arguments[0];
      if (t.isStringLiteral(first) && first.value === 'event_whenbroadcastreceived') {
        let broadcast = constInput('');
        const arg = inner.arguments[1];
        if (t.isObjectExpression(arg)) {
          for (const p of arg.properties) {
            const k = p.key && (p.key.name || p.key.value);
            if (k === 'BROADCAST_OPTION') broadcast = decompileExpression(p.value, ctx);
          }
        }
        return {opcode: 'event_broadcastandwait', inputs: {BROADCAST_INPUT: broadcast}};
      }
    }
    return null;
  }

  if (t.isIdentifier(callee) && callee.name === 'startHats') {
    const first = call.arguments[0];
    if (t.isStringLiteral(first) && first.value === 'event_whenbroadcastreceived') {
      let broadcast = constInput('');
      const arg = call.arguments[1];
      if (t.isObjectExpression(arg)) {
        for (const p of arg.properties) {
          const k = p.key && (p.key.name || p.key.value);
          if (k === 'BROADCAST_OPTION') broadcast = decompileExpression(p.value, ctx);
        }
      }
      return {opcode: 'event_broadcast', inputs: {BROADCAST_INPUT: broadcast}};
    }
  }

  if (t.isIdentifier(callee) && callee.name === 'executeInCompatibilityLayer') {
    const r = decompileCompatibilityLayerStatement(call, ctx);
    if (r) return r;
  }

  if (t.isMemberExpression(callee) &&
      t.isMemberExpression(callee.object) &&
      isRuntimeRef(callee.object.object, ctx) &&
      getPropName(callee.object.property) === 'ext_scratch3_looks' &&
      getPropName(callee.property) === '_renderBubble') {
    return null;
  }

  if (t.isMemberExpression(callee) &&
      t.isMemberExpression(callee.object) &&
      isRuntimeRef(callee.object.object, ctx) &&
      getPropName(callee.object.property) === 'monitorBlocks' &&
      getPropName(callee.property) === 'changeBlock') {
    const arg = call.arguments[0];
    if (t.isObjectExpression(arg)) {
      let id = null, value = null;
      for (const p of arg.properties) {
        const k = p.key && (p.key.name || p.key.value);
        if (k === 'id') id = p.value.value;
        if (k === 'value') value = p.value.value;
      }
      if (id) {
        const varName = lookupVarName(id, ctx);
        const isList = (ctx.target && ctx.target.lists && ctx.target.lists[id]) ||
                       (ctx.stage && ctx.stage.lists && ctx.stage.lists[id]);
        if (isList) {
          return value
            ? {opcode: 'data_showlist', inputs: {}, fields: {LIST: {name: varName, id}}}
            : {opcode: 'data_hidelist', inputs: {}, fields: {LIST: {name: varName, id}}};
        }
        return value
          ? {opcode: 'data_showvariable', inputs: {}, fields: {VARIABLE: {name: varName, id}}}
          : {opcode: 'data_hidevariable', inputs: {}, fields: {VARIABLE: {name: varName, id}}};
      }
    }
    return null;
  }

  if (t.isMemberExpression(callee)) {
    const obj = callee.object;
    const method = getPropName(callee.property);

    if (t.isMemberExpression(obj) && getPropName(obj.property) === 'value') {
      const listRef = obj.object;
      let listInfo = null;
      if (t.isIdentifier(listRef) && ctx.listMap && ctx.listMap[listRef.name]) {
        const l = ctx.listMap[listRef.name];
        listInfo = {name: l.varName, id: l.id};
      } else if (t.isIdentifier(listRef) && ctx.refMap && ctx.refMap[listRef.name]) {
        const ref = ctx.refMap[listRef.name];
        const isList = (ctx.target && ctx.target.lists && ctx.target.lists[ref.id]) ||
                       (ctx.stage && ctx.stage.lists && ctx.stage.lists[ref.id]);
        if (isList) {
          const name = lookupVarName(ref.id, ctx);
          listInfo = {name, id: ref.id};
        }
      } else if (t.isMemberExpression(listRef) &&
                 getPropName(listRef.property) === 'variables' &&
                 isTargetRef(listRef.object, ctx) &&
                 t.isStringLiteral(listRef.property)) {
        const lid = listRef.property.value;
        const isList = (ctx.target && ctx.target.lists && ctx.target.lists[lid]) ||
                       (ctx.stage && ctx.stage.lists && ctx.stage.lists[lid]);
        if (isList) {
          const name = lookupVarName(lid, ctx);
          listInfo = {name, id: lid};
        }
      }

      if (listInfo) {
        switch (method) {
          case 'push':
            return {opcode: 'data_addtolist', inputs: {ITEM: decompileExpression(call.arguments[0], ctx)}, fields: {LIST: listInfo}};
          case 'pop':
            return {opcode: 'data_deleteoflist', inputs: {INDEX: constInput('last')}, fields: {LIST: listInfo}};
          case 'shift':
            return {opcode: 'data_deleteoflist', inputs: {INDEX: constInput(1)}, fields: {LIST: listInfo}};
          case 'unshift':
            return {opcode: 'data_insertatlist', inputs: {INDEX: constInput(1), ITEM: decompileExpression(call.arguments[0], ctx)}, fields: {LIST: listInfo}};
          case 'indexOf':
            return {opcode: 'data_itemnumoflist', inputs: {ITEM: decompileExpression(call.arguments[0], ctx)}, fields: {LIST: listInfo}};
          case 'includes':
            return {opcode: 'data_listcontainsitem', inputs: {ITEM: decompileExpression(call.arguments[0], ctx)}, fields: {LIST: listInfo}};
        }
      }
    }
  }

  const exprResult = decompileCall(call, ctx);
  if (exprResult === IGNORED) return null;
  if (exprResult && exprResult.opcode) {
    if (exprResult.opcode === 'constant') {
      if (ctx.log) ctx.log(`[callstmt] fallback constant for ${callee.type}`);
      return PLACEHOLDER(getSource(call, ctx));
    }
    const out = {opcode: exprResult.opcode, inputs: exprResult.inputs || {}, fields: exprResult.fields || {}};
    if (exprResult.mutation) out.mutation = exprResult.mutation;
    return out;
  }

  if (ctx && ctx.log) ctx.log(`[callstmt] unknown call, placeholder`);
  return PLACEHOLDER(getSource(call, ctx));
};

const decompileCompatibilityLayerStatement = (call, ctx) => {
  const args = call.arguments;
  if (args.length < 2) return null;
  const inputsObj = args[0];
  const opcodeFnRef = args[1];
  let opcodeName = null;
  if (t.isIdentifier(opcodeFnRef) && ctx.opcodeFnMap) opcodeName = ctx.opcodeFnMap[opcodeFnRef.name];
  if (!opcodeName) return null;
  const split = compatBlockSplit(inputsObj, opcodeName, ctx);
  return {opcode: opcodeName, inputs: split.inputs, fields: split.fields};
};

const normalizeFieldForFlatten = (k, v) => {
  if (k === 'VARIABLE' || k === 'LIST' || k === 'BROADCAST_OPTION') {
    if (Array.isArray(v)) return {name: v[0], id: v[1]};
    if (v && typeof v === 'object') {
      if ('name' in v || 'id' in v) return {name: v.name, id: v.id};
      if ('value' in v) return {name: v.value, id: undefined};
    }
    return {name: v, id: undefined};
  }
  if (Array.isArray(v)) return {value: v[0]};
  if (v && typeof v === 'object') {
    if ('value' in v) return {value: v.value};
    if ('name' in v) return {value: v.name};
  }
  return {value: v};
};

const flattenBlocks = (topBlocks, target) => {
  const topIds = [];
  const expandOne = (b, parentId) => {
    if (!b || !b.opcode) return null;
    const id = newId();
    const fields = {};
    for (const [k, v] of Object.entries(b.fields || {})) {
      fields[k] = normalizeFieldForFlatten(k, v);
    }
    const node = {
      opcode: b.opcode, next: null, parent: parentId,
      inputs: {}, fields,
      shadow: false, topLevel: false
    };
    if (b.mutation) node.mutation = b.mutation;
    if (b.__placeholder) {
      node.meta = {
        placeholder: true,
        source: b.__source,
        truncated: !!b.__truncated
      };
    }
    target.blocks[id] = node;

    const src = b.inputs || {};
    for (const [k, val] of Object.entries(src)) {
      if (val && typeof val === 'object' && Array.isArray(val.blocks)) {
        const innerIds = [];
        let prev = null;
        const emit = (child) => {
          if (child && !child.opcode && Array.isArray(child.blocks)) {
            for (const inner of child.blocks) emit(inner);
            return;
          }
          const cid = expandOne(child, prev || id);
          if (!cid) return;
          if (prev) target.blocks[prev].next = cid;
          innerIds.push(cid);
          prev = cid;
        };
        for (const child of val.blocks) emit(child);
        if (innerIds.length > 0) node.inputs[k] = [2, innerIds[0]];
        continue;
      }
      node.inputs[k] = val;
    }
    return id;
  };
  for (const b of topBlocks) {
    const id = expandOne(b, null);
    if (id) topIds.push(id);
  }
  return topIds;
};

const findCompatLayerInputsObj = (node) => {
  if (!node || typeof node !== 'object') return null;
  if (t.isCallExpression(node) &&
      t.isIdentifier(node.callee) &&
      node.callee.name === 'executeInCompatibilityLayer') {
    const a = node.arguments[0];
    if (a && t.isObjectExpression(a)) return a;
  }
  const visitorKeys = t.VISITOR_KEYS[node.type] || [];
  for (const k of visitorKeys) {
    const child = node[k];
    if (!child) continue;
    if (Array.isArray(child)) {
      for (const c of child) {
        const r = findCompatLayerInputsObj(c);
        if (r) return r;
      }
    } else if (typeof child === 'object' && child.type) {
      const r = findCompatLayerInputsObj(child);
      if (r) return r;
    }
  }
  return null;
};

const decompileCompiledProject = async (compiledProject, opts) => {
  const {log = () => {}} = opts;

  const hasComplete = (() => {
    if (!compiledProject.targets) return false;
    for (const t of compiledProject.targets) {
      if (!t.blocks) continue;
      for (const b of Object.values(t.blocks)) {
        if (!b || typeof b.opcode !== 'string') continue;
        if (b.inputs) {
          for (const v of Object.values(b.inputs)) {
            if (Array.isArray(v) && typeof v[0] === 'number' && v[0] >= 1 && v[0] <= 3) {
              return true;
            }
          }
        }
      }
    }
    return false;
  })();

  if (hasComplete) {
    log('compiledProject.targets[*].blocks already final format, using them directly');
    const projectJson = {
      targets: compiledProject.targets.map(t => {
        const {layerOrder, ...rest} = t;
        return {
          ...rest,
          blocks: JSON.parse(JSON.stringify(t.blocks || {})),
          comments: t.comments || {}
        };
      }),
      monitors: compiledProject.monitors || [],
      extensions: compiledProject.extensions || [],
      extensionURLs: compiledProject.extensionURLs || {},
      meta: compiledProject.meta || {semver: '3.0.0', vm: '0.2.0'}
    };
    if (compiledProject.customFonts) projectJson.customFonts = compiledProject.customFonts;
    if (compiledProject.extensionStorage) projectJson.extensionStorage = compiledProject.extensionStorage;

    if (Array.isArray(compiledProject.layerOrder) &&
        compiledProject.layerOrder.length === projectJson.targets.length) {
      projectJson.layerOrder = compiledProject.layerOrder.slice();
    } else {
      projectJson.layerOrder = projectJson.targets
        .map((t, i) => ({i, lo: compiledProject.targets[i] && compiledProject.targets[i].layerOrder}))
        .sort((a, b) => {
          const alo = typeof a.lo === 'number' ? a.lo : a.i;
          const blo = typeof b.lo === 'number' ? b.lo : b.i;
          return alo - blo;
        })
        .map(x => x.i);
    }

    const stageT = projectJson.targets.find(t => t.isStage);
    if (stageT && stageT.textToSpeechLanguage === undefined) {
      stageT.textToSpeechLanguage = '';
    }

    return {projectJson, assets: {}};
  }

  log('falling back to decompile from factorySource');
  const projectJson = {
    targets: [],
    monitors: compiledProject.monitors || [],
    extensions: compiledProject.extensions || [],
    extensionURLs: compiledProject.extensionURLs || {},
    meta: compiledProject.meta || {semver: '3.0.0', vm: '0.2.0'}
  };
  if (compiledProject.customFonts) projectJson.customFonts = compiledProject.customFonts;
  if (compiledProject.extensionStorage) projectJson.extensionStorage = compiledProject.extensionStorage;

  const assets = {};

  for (const src of compiledProject.targets) {
    const target = {
      isStage: src.isStage,
      name: src.name,
      variables: src.variables || {},
      lists: src.lists || {},
      broadcasts: src.broadcasts || {},
      blocks: {},
      comments: {},
      currentCostume: src.currentCostume || 0,
      costumes: src.costumes || [],
      sounds: src.sounds || [],
      volume: src.volume
    };
    if (!src.isStage) {
      Object.assign(target, {
        visible: src.visible, x: src.x, y: src.y, size: src.size,
        direction: src.direction, draggable: src.draggable, rotationStyle: src.rotationStyle
      });
    } else {
      Object.assign(target, {
        tempo: src.tempo, videoTransparency: src.videoTransparency, videoState: src.videoState,
        textToSpeechLanguage: src.textToSpeechLanguage || ''
      });
    }
    projectJson.targets.push(target);
  }

  if (Array.isArray(compiledProject.layerOrder) &&
      compiledProject.layerOrder.length === projectJson.targets.length) {
    projectJson.layerOrder = compiledProject.layerOrder.slice();
  } else {
    projectJson.layerOrder = projectJson.targets
      .map((t, i) => ({i, lo: compiledProject.targets[i] && compiledProject.targets[i].layerOrder}))
      .sort((a, b) => {
        const alo = typeof a.lo === 'number' ? a.lo : a.i;
        const blo = typeof b.lo === 'number' ? b.lo : b.i;
        return alo - blo;
      })
      .map(x => x.i);
  }

  const stageTarget = projectJson.targets.find(t => t.isStage);
  const compiledTargets = compiledProject.compiledTargets || {};
  const customExtensions = new Set();
  const extArgNames = compiledProject.extensionArgNames || {};

  const GRID_COLS = 3;
  const GRID_COL_SPACING = 500;
  const GRID_ROW_SPACING = 400;

  const globalArgNames = new Set();

  for (const [targetIndexStr, targetBundle] of Object.entries(compiledTargets)) {
    const targetIndex = +targetIndexStr;
    const target = projectJson.targets[targetIndex];
    if (!target) continue;

    const ctxBase = {
      varMap: {}, listMap: {}, refMap: {}, constMap: {}, arrayConstMap: {},
      paramMap: {}, paramTypes: {},
      opcodeFnMap: {}, procMap: {}, target, stage: stageTarget, targetIndex, log,
      customExtensions, extArgNames,
      aliases: new Map(),
      expectBoolean: false,
      inStringConcat: false,
      paramNames: [],
      argNames: [],
      globalArgNames
    };

    const procMap = {};
    let procCounter = 0;

    const variants = Object.entries(targetBundle.procedures || {})
      .sort(([a], [b]) => a.localeCompare(b));
    for (const [variant] of variants) {
      const suffix = String(procCounter++).padStart(3, '0');
      const procCode = (variant.startsWith('Z') || variant.startsWith('W')) ? variant.substring(1) : variant;
      const argMatches = procCode.match(/%[snb]/g) || [];
      const argIds = makeArgIds(procCode, argMatches.length);
      const argNames = makeFriendlyArgNames(procCode, argMatches.length);
      const argDefaults = argMatches.map((m) => m === '%b' ? 'false' : '');
      procMap[procCode] = {
        suffix, procCode,
        isWarp: variant.startsWith('W'),
        argMatches, argIds, argNames, argDefaults,
        procId: `proc_${suffix}`, protoId: `proto_${suffix}`
      };
    }
    ctxBase.procMap = procMap;

    let gridIndex = 0;
    const nextGridPos = () => {
      const col = gridIndex % GRID_COLS;
      const row = Math.floor(gridIndex / GRID_COLS);
      gridIndex++;
      return [(col - 1) * GRID_COL_SPACING, -row * GRID_ROW_SPACING];
    };

    for (const hat of targetBundle.hats || []) {
      if (hat.opcode === 'procedures_definition') continue;
      const script = targetBundle.scripts[hat.topBlockId];
      if (!script) continue;
      const hatId = hat.topBlockId;
      const [x, y] = nextGridPos();

      const hatInputs = {};
      const hatFields = {};
      if (hat.fieldsOfInputs) {
        for (const [k, v] of Object.entries(hat.fieldsOfInputs)) {
          if (k === 'BROADCAST_OPTION') {
            const nv = normalizeBroadcastField(v, stageTarget);
            if (nv) hatFields[k] = nv;
          } else {
            hatFields[k] = v;
          }
        }
      }
      if (hat.inputs) {
        for (const [k, v] of Object.entries(hat.inputs)) {
          hatInputs[k] = v;
        }
      }

      target.blocks[hatId] = {
        opcode: hat.opcode, next: null, parent: null,
        inputs: hatInputs, fields: hatFields,
        shadow: false, topLevel: true, x, y
      };

      const parsed = parseFactoryRobust(script.factorySourceRaw, script.factorySource, {log, label: `hat ${hatId}`});
      if (!parsed) continue;
      const maps = extractRefMaps(parsed.ast, target, stageTarget, parsed.aliases);
      const opcodeFnMap = extractOpcodeFunctions(parsed.ast);
      const ctx = Object.assign({}, ctxBase, maps, {
        opcodeFnMap, aliases: parsed.aliases,
        paramNames: parsed.params || [],
        argNames: (parsed.params || []).map((_, i) => `参数${i + 1}`),
        paramMap: {}, paramTypes: {}
      });
      if (!parsed.body) continue;

      let hatInputsObj = null;
      {
        const he = tryParseHatEdge([{type: 'BlockStatement', body: parsed.body}], 0, ctx);
        if (he && he.hatInputsObj) hatInputsObj = he.hatInputsObj;
      }

      if (!hatInputsObj) {
        const fileNode = {type: 'File', program: {type: 'Program', body: parsed.body}};
        hatInputsObj = findCompatLayerInputsObj(fileNode);
      }
      if (hatInputsObj && ctx.opcodeFnMap) {
        const split = compatBlockSplit(hatInputsObj, hat.opcode, ctx);
        for (const [k, v] of Object.entries(split.inputs)) {
          if (!(k in target.blocks[hatId].inputs)) target.blocks[hatId].inputs[k] = v;
        }
        for (const [k, v] of Object.entries(split.fields)) {
          if (!(k in target.blocks[hatId].fields)) {
            if (k === 'BROADCAST_OPTION') {
              const nv = normalizeBroadcastField(v, stageTarget);
              if (nv) target.blocks[hatId].fields[k] = nv;
            } else {
              target.blocks[hatId].fields[k] = v;
            }
          }
        }
      }

      const result = decompileBlock(parsed.body, ctx);
      if (!result.blocks.length) continue;
      const topIds = flattenBlocks(result.blocks, target);
      let prevId = hatId;
      for (const id of topIds) {
        target.blocks[id].parent = prevId;
        if (target.blocks[prevId]) target.blocks[prevId].next = id;
        prevId = id;
      }
    }

    for (const [variant, proc] of variants) {
      const info = procMap[(variant.startsWith('Z') || variant.startsWith('W')) ? variant.substring(1) : variant];
      if (!info) continue;
      const {suffix, procId, protoId, procCode, isWarp, argMatches, argIds, argNames, argDefaults} = info;

      target.blocks[protoId] = {
        opcode: 'procedures_prototype', next: null, parent: procId,
        inputs: {}, fields: {}, shadow: true, topLevel: false,
        mutation: {
          tagName: 'mutation', children: [],
          proccode: procCode,
          argumentids: JSON.stringify(argIds),
          argumentnames: JSON.stringify(argNames),
          argumentdefaults: JSON.stringify(argDefaults),
          warp: isWarp ? 'true' : 'false'
        }
      };
      for (let i = 0; i < argNames.length; i++) {
        const argShadowId = `argsh_${suffix}_${i}`;
        const reporterOpcode = argMatches[i] === '%b' ? 'argument_reporter_boolean' : 'argument_reporter_string_number';
        target.blocks[argShadowId] = {
          opcode: reporterOpcode, next: null, parent: protoId,
          inputs: {}, fields: {VALUE: [argNames[i], null]},
          shadow: true, topLevel: false
        };
        target.blocks[protoId].inputs[argIds[i]] = {name: argIds[i], block: argShadowId, shadow: argShadowId};
      }

      const [px, py] = nextGridPos();
      target.blocks[procId] = {
        opcode: 'procedures_definition', next: null, parent: null,
        inputs: {custom_block: {name: 'custom_block', block: protoId, shadow: protoId}},
        fields: {}, shadow: false, topLevel: true, x: px, y: py
      };

      const parsed = parseFactoryRobust(proc.factorySourceRaw, proc.factorySource, {log, label: `proc ${variant}`});
      if (!parsed) continue;
      const maps = extractRefMaps(parsed.ast, target, stageTarget, parsed.aliases);
      const opcodeFnMap = extractOpcodeFunctions(parsed.ast);

      const paramMap = {};
      const paramTypes = {};
      parsed.params.forEach((name, i) => {
        paramMap[name] = argNames[i] || `参数${i + 1}`;
        paramTypes[name] = (argMatches[i] === '%b') ? 'boolean' : 'string';
      });
      const reverseParamTypes = {};
      for (let i = 0; i < argNames.length; i++) {
        reverseParamTypes[argNames[i]] = (argMatches[i] === '%b') ? 'boolean' : 'string';
      }
      const ctx = Object.assign({}, ctxBase, maps, {
        opcodeFnMap, aliases: parsed.aliases,
        paramNames: parsed.params || [],
        argNames: argNames,
        paramTypes: reverseParamTypes,
        paramMap,
        procParamMap: paramMap
      });
      if (!parsed.body) continue;

      const result = decompileBlock(parsed.body, ctx);
      if (!result.blocks.length) continue;
      const topIds = flattenBlocks(result.blocks, target);
      let prevId = procId;
      for (const id of topIds) {
        target.blocks[id].parent = prevId;
        if (target.blocks[prevId]) target.blocks[prevId].next = id;
        prevId = id;
      }
    }
  }

  if (customExtensions.size > 0) {
    const merged = new Set((projectJson.extensions || []).filter(e => typeof e === 'string'));
    for (const id of customExtensions) merged.add(id);
    projectJson.extensions = Array.from(merged);
  }

  return {projectJson, assets};
};

const decompileSnippet = (sourceText, target, stage, baseCtx = {}) => {
  if (typeof sourceText !== 'string' || sourceText.length === 0) return null;

  let ast = null;
  try {
    ast = parser.parse(sourceText, {
      sourceType: 'script',
      allowReturnOutsideFunction: true,
      allowAwaitOutsideFunction: true,
      plugins: ['optionalChaining', 'nullishCoalescingOperator']
    });
  } catch (e1) {
    try {
      ast = parser.parse('yield ' + sourceText, {
        sourceType: 'script',
        allowReturnOutsideFunction: true,
        plugins: ['optionalChaining', 'nullishCoalescingOperator']
      });
    } catch (e2) {
      try {
        const expr = parser.parseExpression(sourceText, {
          plugins: ['optionalChaining', 'nullishCoalescingOperator']
        });
        ast = {
          type: 'File',
          program: {
            type: 'Program',
            sourceType: 'script',
            body: [{type: 'ExpressionStatement', expression: expr}]
          }
        };
      } catch (e3) { return null; }
    }
  }
  if (!ast) return null;

  const body = t.isFile(ast) ? ast.program.body : (t.isProgram(ast) ? ast.body : []);
  if (!body || body.length === 0) return null;

  const ctx = Object.assign({
    varMap: {}, listMap: {}, refMap: {}, constMap: {}, arrayConstMap: {},
    paramMap: {}, paramTypes: {},
    opcodeFnMap: {},
    procMap: {},
    aliases: new Map(),
    expectBoolean: false,
    inStringConcat: false,
    paramNames: [],
    argNames: [],
    target, stage,
    log: () => {}
  }, baseCtx);

  try {
    const maps = extractRefMaps(ast, ctx.target, ctx.stage, ctx.aliases);
    Object.assign(ctx, maps);
    ctx.opcodeFnMap = extractOpcodeFunctions(ast);
  } catch (e) {}

  try {
    return decompileBlock(body, ctx);
  } catch (e) {
    return null;
  }
};
// 庆祝代码结束-诺言Promise
// 庆祝代码结束-落日余晖
// 庆祝代码结束-チューリングの幽靈
module.exports = {decompileCompiledProject, decompileSnippet};