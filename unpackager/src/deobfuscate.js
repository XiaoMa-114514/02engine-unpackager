'use strict';

const parser = require('@babel/parser');
const t = require('@babel/types');


const unwrapEvalSource = (source) => {
  if (typeof source !== 'string') return source;
  const trimmed = source.trim();
  if (!/^eval\s*\(/.test(trimmed)) return source;

  let ast;
  try {
    ast = parser.parseExpression(trimmed.replace(/;\s*$/, ''), {
      plugins: ['optionalChaining', 'nullishCoalescingOperator']
    });
  } catch (e) {
    return source;
  }

  if (!t.isCallExpression(ast)) return source;
  if (!t.isIdentifier(ast.callee, {name: 'eval'})) return source;
  const arg = ast.arguments[0];
  if (t.isStringLiteral(arg)) return arg.value;
  if (t.isObjectExpression(arg)) {
    try {
      const inner = trimmed
        .replace(/^eval\s*\(\s*/, '')
        .replace(/\s*\)\s*;?\s*$/, '');
      return JSON.parse(inner);
    } catch (e) { return source; }
  }
  return source;
};


const ENGINES = {
  webcrack: async (code, opts = {}) => {
    const {webcrack} = require('webcrack');
    const result = await webcrack(code, {
      unpack: opts.unpack !== false,
      deobfuscate: true,
      mangle: false,
      jsx: false
    });
    return result.code;
  },

  'js-deobfuscator': async (code, opts = {}) => {
    let mod;
    try {
      mod = require('js-deobfuscator');
    } catch (e) {
      throw new Error(
        'Package js-deobfuscator is not installed. ' +
        'Run: npm install js-deobfuscator'
      );
    }
    const fn = mod.deobfuscate || mod.default || mod;
    if (typeof fn !== 'function') {
      throw new Error('js-deobfuscator: cannot find deobfuscate()');
    }
    const result = await fn(code, opts);
    return typeof result === 'string' ? result : (result && result.code) || code;
  }
};


ENGINES['javascript-deobfuscator'] = ENGINES['js-deobfuscator'];



const OBFUSCATION_PATTERNS = [
  /_0x[a-f0-9]{3,}/i,
  /\\x[0-9a-f]{2}/i,
  /\[\s*['"][A-Za-z_$][\w$]*['"]\s*\]\s*\(/,
  /atob\s*\(/i,
  /['"][A-Za-z0-9+/]{80,}={0,2}['"]/,
  /debugger\s*;?/i,
  /eval\s*\(/i,
  /Function\s*\(\s*['"]/i
];


const isLikelyObfuscated = (code) => {
  if (!code) return false;
  if (code.length < 100) {
    return /_0x[a-f0-9]{3,}/i.test(code) || /eval\s*\(/i.test(code);
  }
  let hits = 0;
  for (const re of OBFUSCATION_PATTERNS) {
    if (re.test(code)) hits++;
    if (hits >= 2) return true;
  }
  return false;
};

// 对外主函数

const deobfuscate = async (code, opts = {}) => {
  const {
    deobfuscator = 'webcrack',
    log = () => {},
    retries = 1
  } = opts;

  if (deobfuscator === 'none') return code;
  if (!code || typeof code !== 'string') return code;
  if (code.trim().length === 0) return code;


  code = unwrapEvalSource(code);

  const engine = ENGINES[deobfuscator];
  if (!engine) {
    throw new Error(
      `Unknown deobfuscator: ${deobfuscator}. ` +
      `Available: ${Object.keys(ENGINES).join(', ')}, none`
    );
  }

  if (!isLikelyObfuscated(code)) {
    log(`deobfuscate: source looks clean, skipping (${code.length} chars)`);
    return code;
  }

  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const t0 = Date.now();
      const out = await engine(code, opts);
      const dt = Date.now() - t0;
      log(`deobfuscate[${deobfuscator}]: ${code.length} -> ${out.length} chars in ${dt}ms`);
      return out;
    } catch (e) {
      lastError = e;
      log(`deobfuscate[${deobfuscator}] attempt ${attempt + 1} failed: ${e.message}`);
    }
  }

  log(`deobfuscate[${deobfuscator}] all attempts failed, returning original code: ${lastError && lastError.message}`);
  return code;
};

module.exports = {deobfuscate, isLikelyObfuscated, unwrapEvalSource, ENGINES};