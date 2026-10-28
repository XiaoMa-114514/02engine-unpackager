'use strict';

const fs = require('fs');
const os = require('os');
const JSZip = require('jszip');
const path = require('path');
const crypto = require('crypto');
const {decode: base85Decode} = require('./base85');
const {deobfuscate, unwrapEvalSource} = require('./deobfuscate');
const {decompileCompiledProject} = require('./decompile');


const bufferToSearchableString = (buffer) => {
  const SMALL_LIMIT = 32 * 1024 * 1024;
  if (buffer.length <= SMALL_LIMIT) {
    return buffer.toString('latin1');
  }
  const CHUNK = 8 * 1024 * 1024;
  const parts = [];
  for (let off = 0; off < buffer.length; off += CHUNK) {
    const end = Math.min(off + CHUNK, buffer.length);
    parts.push(buffer.toString('latin1', off, end));
  }
  return parts.join('');
};


const findProjectChunksInHtml = (html) => {
  const chunks = [];
  const re = /<script\b[^>]*type\s*=\s*["']application\/x-o2-project-chunk["'][^>]*>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(html))) {
    // 从标签里取data-size
    const tagStart = m.index;
    const tagEnd = html.indexOf('>', tagStart);
    const tag = html.slice(tagStart, tagEnd);
    const sizeMatch = tag.match(/data-size\s*=\s*["']?(\d+)["']?/);
    const size = sizeMatch ? +sizeMatch[1] : null;
    chunks.push({size, data: m[1]});
  }
  return chunks;
};


const decodeProjectChunksToFile = async (chunks, tmpDir) => {
  const tmpPath = path.join(tmpDir, `o2-chunks-${Date.now()}.bin`);
  const ws = fs.createWriteStream(tmpPath);

  let streamError = null;
  ws.on('error', (e) => {
    streamError = e;
    try { ws.destroy(); } catch (_) {}
  });

  const writeAsync = (buf) => new Promise((resolve, reject) => {
    if (streamError) return reject(streamError);
    if (ws.destroyed) return reject(new Error('write stream destroyed'));
    ws.write(buf, (err) => {
      if (err) reject(err);
      else if (streamError) reject(streamError);
      else resolve();
    });
  });

  try {
    for (const c of chunks) {
      // 校验长度
      if (typeof c.data === 'string' && c.data.length % 5 !== 0) {
        throw new Error(
          `project chunk base85 length ${c.data.length} is not a multiple of 5; ` +
          `input may be corrupted or the chunk regex matched too little/much`
        );
      }
      const decoded = base85Decode(c.data);
      const size = (typeof c.size === 'number' && c.size <= decoded.length)
        ? c.size
        : decoded.length;
      const slice = decoded.subarray(0, size);
      await writeAsync(Buffer.from(slice.buffer, slice.byteOffset, slice.byteLength));
    }
    await new Promise((resolve, reject) => ws.end((err) => err ? reject(err) : resolve()));
    return tmpPath;
  } catch (e) {
    try { ws.destroy(); } catch (_) {}
    try { fs.unlinkSync(tmpPath); } catch (_) {}
    throw e;
  }
};

const detectType = (buffer) => {
  const head = buffer.subarray(0, 4).toString('hex');
  if (head.startsWith('504b')) return 'zip';
  const text = buffer.subarray(0, 512).toString('utf8');
  if (text.includes('<!DOCTYPE html') || text.includes('<html')) return 'html';
  return 'unknown';
};

const extractFromSb3 = async (zipBuffer, log) => {
  let zip;
  try {
    zip = await JSZip.loadAsync(zipBuffer);
  } catch (e) {
    return null;
  }

  const rootPj = zip.file('project.json');
  const matches = zip.file(/^([^/]*\/)?project\.json$/);
  const pj = rootPj || (matches && matches[0]) || null;
  if (!pj) return null;

  let projectJson;
  try {
    projectJson = JSON.parse(await pj.async('string'));
  } catch (e) {
    return null;
  }

  const assets = {};
  for (const name of Object.keys(zip.files)) {
    if (name === pj.name) continue;
    if (zip.files[name].dir) continue;
    assets[path.basename(name)] = Buffer.from(await zip.files[name].async('uint8array'));
  }

  log(`extracted ${Object.keys(assets).length} assets from project.zip`);
  return {projectJson, assets};
};

const deobfuscateCompiledProjectSources = async (compiledProject, opts) => {
  const {deobfuscator, log, retries} = opts;
  const targets = compiledProject.compiledTargets || {};
  let total = 0, processed = 0, failed = 0;

  // 统计覆盖：全部 scripts（含无 hat 引用的）+ procedures，按对象去重
  for (const bundle of Object.values(targets)) {
    const seen = new Set();
    for (const script of Object.values(bundle.scripts || {})) {
      if (!script || !script.factorySource) continue;
      if (seen.has(script)) continue;
      seen.add(script);
      total++;
    }
    for (const proc of Object.values(bundle.procedures || {})) {
      if (!proc || !proc.factorySource) continue;
      if (seen.has(proc)) continue;
      seen.add(proc);
      total++;
    }
  }

  if (total === 0) {
    log('pre-deobfuscate: no factorySource found');
    return;
  }

  log(`pre-deobfuscate: processing ${total} factorySource entries with ${deobfuscator}...`);

  const processOne = async (holder, label) => {
    const raw = holder.factorySource;
    holder.factorySourceRaw = raw;

    const unwrapped = unwrapEvalSource(raw);
    const didUnwrap = unwrapped !== raw;
    if (didUnwrap) {
      log(`${label}: unwrapped eval() shell (${raw.length} -> ${unwrapped.length} chars)`);
    }

    try {
      holder.factorySource = await deobfuscate(unwrapped, {
        deobfuscator, retries,
        log: (...m) => log(label, ...m)
      });
      processed++;
    } catch (e) {
      failed++;
      holder.factorySource = raw;
      log(`${label}: failed, keeping raw: ${e.message}`);
    }
  };

  for (const [targetIndex, bundle] of Object.entries(targets)) {
    const seen = new Set();

    for (const [topBlockId, script] of Object.entries(bundle.scripts || {})) {
      if (!script || !script.factorySource) continue;
      if (seen.has(script)) continue;
      seen.add(script);
      await processOne(script, `[t${targetIndex} script ${topBlockId}]`);
    }

    for (const [variant, proc] of Object.entries(bundle.procedures || {})) {
      if (!proc || !proc.factorySource) continue;
      if (seen.has(proc)) continue;
      seen.add(proc);
      await processOne(proc, `[t${targetIndex} proc ${variant}]`);
    }
  }

  log(`pre-deobfuscate: done, ${processed}/${total} succeeded${failed ? `, ${failed} failed` : ''}`);
};


const collectAllFactorySources = (compiledProject) => {
  if (!compiledProject || !compiledProject.compiledTargets) return null;

  const parts = [];
  const compiledTargets = compiledProject.compiledTargets;
  const targetsInfo = compiledProject.targets || [];

  for (const [targetIndex, bundle] of Object.entries(compiledTargets)) {
    const targetInfo = targetsInfo[targetIndex];
    const targetName = targetInfo ? targetInfo.name : `Target ${targetIndex}`;
    const isStage = targetInfo ? !!targetInfo.isStage : false;

    const header = `// ===== Target: ${targetName} (isStage: ${isStage}) =====`;
    let hasContent = false;

    const targetParts = [];
    const seen = new Set();

    const hatByTopBlockId = new Map();
    for (const hat of bundle.hats || []) {
      if (hat && hat.topBlockId) hatByTopBlockId.set(hat.topBlockId, hat);
    }

    
    for (const [topBlockId, script] of Object.entries(bundle.scripts || {})) {
      if (!script || typeof script.factorySource !== 'string' || script.factorySource.length === 0) continue;
      if (seen.has(script)) continue;
      seen.add(script);
      if (!hasContent) {
        targetParts.push(header);
        hasContent = true;
      }
      const hat = hatByTopBlockId.get(topBlockId);
      const label = hat ? `Hat script (${hat.opcode})` : 'Orphan script';
      targetParts.push(`// --- ${label}: ${topBlockId} ---`);
      targetParts.push(script.factorySource);
      targetParts.push('');
    }

    for (const [variant, proc] of Object.entries(bundle.procedures || {})) {
      if (!proc || typeof proc.factorySource !== 'string' || proc.factorySource.length === 0) continue;
      if (seen.has(proc)) continue;
      seen.add(proc);
      if (!hasContent) {
        targetParts.push(header);
        hasContent = true;
      }
      targetParts.push(`// --- Procedure: ${variant} ---`);
      targetParts.push(proc.factorySource);
      targetParts.push('');
    }

    if (hasContent) {
      parts.push(targetParts.join('\n'));
      parts.push('');
    }
  }

  if (parts.length === 0) return '';
  return parts.join('\n');
};


const insertJsSourceSprite = (projectJson, assets, jsSource, log) => {
  if (!projectJson || !Array.isArray(projectJson.targets)) return;
  if (typeof jsSource !== 'string' || jsSource.length === 0) {
    log('insertJsSourceSprite: 源码为空');
    return;
  }


  const svgContent = `<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1" viewBox="0 0 1 1"></svg>`;
  const assetId = crypto.createHash('md5').update(svgContent).digest('hex');
  const md5ext = `${assetId}.svg`;

  if (!assets) assets = {};
  if (!assets[md5ext]) {
    assets[md5ext] = Buffer.from(svgContent, 'utf8');
  }


  const existingNames = new Set(
    projectJson.targets.map(t => t && t.name).filter(n => typeof n === 'string')
  );
  let spriteName = '预装包的js源代码';
  if (existingNames.has(spriteName)) {
    let i = 2;
    while (existingNames.has(`${spriteName}_${i}`)) i++;
    spriteName = `${spriteName}_${i}`;
  }

  const commentId = `js_source_${crypto.createHash('sha1').update(jsSource).digest('hex').slice(0, 12)}`;

  const newSprite = {
    isStage: false,
    name: spriteName,
    variables: {},
    lists: {},
    broadcasts: {},
    blocks: {},
    comments: {
      [commentId]: {
        blockId: null,
        x: 497.77777777777777,
        y: 385.18518518518516,
        width: 1210.3704833984375,
        height: 1041.4815063476562,
        minimized: false,
        text: jsSource
      }
    },
    currentCostume: 0,
    costumes: [
      {
        name: spriteName,
        bitmapResolution: 1,
        dataFormat: 'svg',
        assetId: assetId,
        md5ext: md5ext,
        rotationCenterX: 0,
        rotationCenterY: 0
      }
    ],
    sounds: [],
    volume: 100,
    visible: true,
    x: 0,
    y: 0,
    size: 100,
    direction: 90,
    draggable: false,
    rotationStyle: 'all around'
  };

  projectJson.targets.push(newSprite);


  if (!Array.isArray(projectJson.layerOrder)) {
    projectJson.layerOrder = projectJson.targets.map((_, i) => i);
  } else if (projectJson.layerOrder.length === projectJson.targets.length - 1) {
    projectJson.layerOrder.push(projectJson.targets.length - 1);
  } else {
    projectJson.layerOrder = projectJson.targets.map((_, i) => i);
  }

  log(`insertJsSourceSprite: 已插入 "${spriteName}"，含 ${jsSource.length} 字符`);
  return {spriteName, assetId, md5ext, commentId};
};

const unpack = async (buffer, opts) => {
  const {
    log = () => {},
    type = 'auto',
    shouldDeobfuscate,
    deobfuscator,
    deobfuscateRetries,
    keepRaw,
    outputDir
  } = opts;

  let detected = type;
  if (detected === 'auto') detected = detectType(buffer);

  let projectZipBuffer = null;
  let compiledProject = null;
  let originalProject = null;
  let projectJson = null;
  let assets = null;

  if (detected === 'html') {
    const html = bufferToSearchableString(buffer);
    const chunks = findProjectChunksInHtml(html);

    if (chunks.length > 0) {
      const total = chunks.reduce((s, c) => s + (c.size || 0), 0);
      log(`found ${chunks.length} project chunks, total declared size ${(total / 1024 / 1024).toFixed(1)} MB`);

      const sample = chunks[0];
      if (typeof sample.size === 'number') {
        const ratio = sample.size / sample.data.length;
        if (ratio > 4 || ratio < 0.1) {
          log(`WARNING: first chunk data-size=${sample.size} vs text len=${sample.data.length} (ratio=${ratio.toFixed(2)}), data-size may be wrong`);
        }
      }

      const tmpDir = outputDir || os.tmpdir();
      fs.mkdirSync(tmpDir, {recursive: true});

      const chunksPath = await decodeProjectChunksToFile(chunks, tmpDir);
      const sb3Path = path.join(tmpDir, 'project-extracted.sb3');
      try { fs.unlinkSync(sb3Path); } catch (_) {}
      fs.renameSync(chunksPath, sb3Path);

      const stat = fs.statSync(sb3Path);
      log(`wrote ${sb3Path} (${(stat.size / 1024 / 1024).toFixed(1)} MB)`);

      if (stat.size < 512 * 1024 * 1024) {
        try {
          const extracted = await extractFromSb3(fs.readFileSync(sb3Path), log);
          if (extracted) {
            projectJson = extracted.projectJson;
            assets = extracted.assets;
          }
        } catch (e) {
          log(`extractFromSb3 failed: ${e.message}`);
        }
      } else {
        log(`SB3 too large (${(stat.size / 1024 / 1024).toFixed(1)} MB), skipping in-memory extraction.`);
        log(`Open ${sb3Path} in TurboWarp, save as a new sb3, then re-run this tool on the new file.`);
      }
    }

    const m = html.match(/JSON\.parse\(decodeURIComponent\("([\s\S]*?)"\)\)/);
    if (m) {
      try {
        compiledProject = JSON.parse(decodeURIComponent(m[1]));
        log('found embedded compiledProject');
      } catch (e) {
        log('failed to parse embedded compiledProject', e.message);
      }
    }
  } else if (detected === 'zip') {
    const zip = await JSZip.loadAsync(buffer);
    const cp = zip.file('compiled-project.json');
    if (cp) {
      compiledProject = JSON.parse(await cp.async('string'));
      log('found compiled-project.json in zip');
    }
    const pz = zip.file('project.zip');
    if (pz) {
      projectZipBuffer = Buffer.from(await pz.async('uint8array'));
      log('found project.zip in zip');
    }
    const ap = zip.file('assets/project.json');
    if (ap) {
      projectJson = JSON.parse(await ap.async('string'));
      assets = {};
      for (const name of Object.keys(zip.files)) {
        if (name.startsWith('assets/') && name !== 'assets/project.json') {
          assets[path.basename(name)] = Buffer.from(await zip.files[name].async('uint8array'));
        }
      }
      log(`found assets/project.json with ${Object.keys(assets).length} assets`);
    }
    if (!compiledProject && !projectJson) {
      log('no project found at top level, scanning platform dirs...');
      for (const name of Object.keys(zip.files)) {
        if (name.endsWith('compiled-project.json') ||
            name.endsWith('assets/project.json') ||
            name.endsWith('project.zip')) {
          log('found', name);
          const f = zip.file(name);
          const data = await f.async('uint8array');
          if (name.endsWith('compiled-project.json')) {
            compiledProject = JSON.parse(Buffer.from(data).toString('utf8'));
          } else if (name.endsWith('project.zip')) {
            projectZipBuffer = Buffer.from(data);
          } else {
            projectJson = JSON.parse(Buffer.from(data).toString('utf8'));
            assets = {};
            const dir = name.substring(0, name.length - 'project.json'.length);
            for (const n2 of Object.keys(zip.files)) {
              if (n2.startsWith(dir) && n2 !== name) {
                assets[path.basename(n2)] = Buffer.from(await zip.files[n2].async('uint8array'));
              }
            }
          }
        }
      }
    }
  } else {
    throw new Error('Unknown input type: ' + detected);
  }

  if (!originalProject && !compiledProject && !projectJson && detected === 'zip') {
    const zip = await JSZip.loadAsync(buffer);
    for (const name of Object.keys(zip.files)) {
      if (name.endsWith('main.js')) {
        const src = await zip.file(name).async('string');
        const m = src.match(/const embeddedProject\s*=\s*'([A-Za-z0-9+/=]+)'/);
        if (m) {
          originalProject = Buffer.from(m[1], 'base64');
          log('extracted embedded SB3 from', name);
          break;
        }
      }
    }
  }

  if (compiledProject) {
    if (shouldDeobfuscate) {
      await deobfuscateCompiledProjectSources(compiledProject, {
        deobfuscator,
        retries: deobfuscateRetries,
        log
      });
    } else {
      log('pre-deobfuscate: skipped (--no-deobfuscate)');
    }

    let allFactorySources = null;
    try {
      allFactorySources = collectAllFactorySources(compiledProject);
      if (typeof allFactorySources === 'string') {
        log(`collected ${allFactorySources.length} chars of (deobfuscated) factorySource`);
      }
    } catch (e) {
      log(`collectAllFactorySources failed: ${e.message}`);
    }

    log('decompiling compiledProject...');
    const decompiled = await decompileCompiledProject(compiledProject, {
      deobfuscate: false,
      deobfuscator,
      keepRaw,
      log
    });
    projectJson = decompiled.projectJson;
    if (!assets || Object.keys(assets).length === 0) {
      assets = decompiled.assets;
    }
    if (!assets) assets = {};

    if (typeof allFactorySources === 'string' && allFactorySources.length > 0) {
      try {
        insertJsSourceSprite(projectJson, assets, allFactorySources, log);
      } catch (e) {
        log(`insertJsSourceSprite failed: ${e.message}`);
      }
    } else {
      log('no factorySource to insert as a sprite (empty or skipped)');
    }
  }

  if (projectZipBuffer && !projectJson) {
    log('extracting project.zip...');
    const extracted = await extractFromSb3(projectZipBuffer, log);
    if (extracted) {
      projectJson = extracted.projectJson;
      assets = extracted.assets;
    }
  }

  return {
    summary: {
      detected,
      hasCompiledProject: !!compiledProject,
      hasProjectZip: !!projectZipBuffer,
      hasProjectJson: !!projectJson,
      hasOriginalProject: !!originalProject,
      assetCount: assets ? Object.keys(assets).length : 0
    },
    compiledProject,
    projectZip: projectZipBuffer,
    originalProject,
    projectJson,
    assets
  };
};

module.exports = {unpack, collectAllFactorySources, insertJsSourceSprite};