'use strict';

const JSZip = require('jszip');
const crypto = require('crypto');
const {fixBlockRefs} = require('./fix-refs');

const XML_UNSAFE_CHARS = /[<>&]/g;
const XML_SAFE_MAP = {'<': '＜', '>': '＞', '&': '＆'};
const sanitizeXMLText = (s) => {
  if (typeof s !== 'string') return s;
  if (!XML_UNSAFE_CHARS.test(s)) return s;
  return s.replace(XML_UNSAFE_CHARS, (c) => XML_SAFE_MAP[c]);
};

const normalizeProccode = (s) => {
  if (typeof s !== 'string') return s;
  return s.replace(/%(?![snb])/g, '％');
};

const sanitizeMutation = (mutation) => {
  if (!mutation || typeof mutation !== 'object') return mutation;
  const out = Array.isArray(mutation) ? [...mutation] : {...mutation};
  if (typeof out.proccode === 'string') {
    out.proccode = sanitizeXMLText(normalizeProccode(out.proccode));
  }
  if (typeof out.argumentnames === 'string') {
    out.argumentnames = sanitizeXMLText(out.argumentnames);
  }
  if (typeof out.argumentdefaults === 'string') {
    out.argumentdefaults = sanitizeXMLText(out.argumentdefaults);
  }
  return out;
};

const buildBroadcastIndex = (stage) => {
  const byLower = new Map();
  if (stage && stage.broadcasts) {
    for (const [id, name] of Object.entries(stage.broadcasts)) {
      byLower.set(String(name).toLowerCase(), {name, id});
    }
  }
  return byLower;
};

const deterministicBroadcastId = (name) =>
  'bc_' + crypto.createHash('sha1').update('bc:' + String(name)).digest('hex').slice(0, 10);

const buildLookup = (target, stage) => {
  const varMap = {};
  const listMap = {};
  const broadcastMap = {};

  const addMap = (src, dst) => {
    if (!src) return;
    for (const [id, entry] of Object.entries(src)) {
      if (Array.isArray(entry)) dst[id] = entry[0];
      else if (entry && typeof entry === 'object' && entry.name) dst[id] = entry.name;
      else if (typeof entry === 'string') dst[id] = entry;
      else dst[id] = id;
    }
  };

  if (stage) {
    addMap(stage.variables, varMap);
    addMap(stage.lists, listMap);
    addMap(stage.broadcasts, broadcastMap);
  }
  addMap(target.variables, varMap);
  addMap(target.lists, listMap);
  addMap(target.broadcasts, broadcastMap);

  return {
    varMap, listMap, broadcastMap,
    broadcastIndex: buildBroadcastIndex(stage)
  };
};

const encodeField = (k, v, lookup) => {
  if (Array.isArray(v)) return v;

  if (k === 'VARIABLE' || k === 'LIST') {
    let id = null;
    let name = null;
    if (v && typeof v === 'object') {
      if (v.id !== undefined && v.id !== null) id = v.id;
      if (v.value !== undefined) name = v.value;
      else if (v.name !== undefined) name = v.name;
    } else if (typeof v === 'string') {
      id = v;
    }
    if (id && name === null) {
      const map = k === 'VARIABLE' ? lookup.varMap : lookup.listMap;
      name = map[id] || id;
    }
    if (id) return [sanitizeXMLText(name !== null ? name : id), sanitizeXMLText(id)];
    if (name !== null) return [sanitizeXMLText(name)];
    return null;
  }

  if (k === 'BROADCAST_OPTION') {
    let id = null, name = null;
    if (v && typeof v === 'object') {
      if (v.id !== undefined && v.id !== null) id = v.id;
      if (v.value !== undefined) name = v.value;
      else if (v.name !== undefined) name = v.name;
    } else if (typeof v === 'string') {
      name = v;
    }
    if (id && lookup.broadcastMap && lookup.broadcastMap[id] !== undefined) {
      return [sanitizeXMLText(String(lookup.broadcastMap[id])), sanitizeXMLText(String(id))];
    }
    if (name !== null && name !== undefined && lookup.broadcastIndex) {
      const hit = lookup.broadcastIndex.get(String(name).toLowerCase());
      if (hit) return [sanitizeXMLText(String(hit.name)), sanitizeXMLText(String(hit.id))];
      const newId = deterministicBroadcastId(name);
      return [sanitizeXMLText(String(name)), sanitizeXMLText(newId)];
    }
    if (id) return [sanitizeXMLText(String(name ?? id)), sanitizeXMLText(String(id))];
    return null;
  }

  if (v && typeof v === 'object') {
    if ('value' in v) {
      const arr = [sanitizeXMLText(v.value)];
      if (v.id !== undefined && v.id !== null) arr.push(sanitizeXMLText(v.id));
      return arr;
    }
  }

  if (v !== null && v !== undefined) return [sanitizeXMLText(v)];
  return null;
};

const encodeFields = (fields, lookup) => {
  const out = {};
  if (!fields) return out;
  for (const [k, v] of Object.entries(fields)) {
    const enc = encodeField(k, v, lookup);
    if (enc) out[k] = enc;
  }
  return out;
};

const MENU_MAP = {
  'motion_goto': {TO: {opcode: 'motion_goto_menu', fieldName: 'TO'}},
  'motion_glideto': {TO: {opcode: 'motion_glideto_menu', fieldName: 'TO'}},
  'motion_pointtowards': {TOWARDS: {opcode: 'motion_pointtowards_menu', fieldName: 'TOWARDS'}},
  'control_create_clone_of': {CLONE_OPTION: {opcode: 'control_create_clone_of_menu', fieldName: 'CLONE_OPTION'}},
  'looks_switchcostumeto': {COSTUME: {opcode: 'looks_costume', fieldName: 'COSTUME'}},
  'looks_switchbackdropto': {BACKDROP: {opcode: 'looks_backdrops', fieldName: 'BACKDROP'}},
  'looks_switchbackdroptoandwait': {BACKDROP: {opcode: 'looks_backdrops', fieldName: 'BACKDROP'}},
  'sound_play': {SOUND_MENU: {opcode: 'sound_sounds_menu', fieldName: 'SOUND_MENU'}},
  'sound_playuntildone': {SOUND_MENU: {opcode: 'sound_sounds_menu', fieldName: 'SOUND_MENU'}},
  'sensing_touchingobject': {TOUCHINGOBJECTMENU: {opcode: 'sensing_touchingobjectmenu', fieldName: 'TOUCHINGOBJECTMENU'}},
  'sensing_distanceto': {DISTANCETOMENU: {opcode: 'sensing_distancetomenu', fieldName: 'DISTANCETOMENU'}},
  'sensing_keypressed': {KEY_OPTION: {opcode: 'sensing_keyoptions', fieldName: 'KEY_OPTION'}},
  'sensing_of': {OBJECT: {opcode: 'sensing_of_object_menu', fieldName: 'OBJECT'}},
  'event_broadcast': {BROADCAST_INPUT: {opcode: 'event_broadcast_menu', fieldName: 'BROADCAST_OPTION', variableType: 'broadcast_msg'}},
  'event_broadcastandwait': {BROADCAST_INPUT: {opcode: 'event_broadcast_menu', fieldName: 'BROADCAST_OPTION', variableType: 'broadcast_msg'}}
};

const BOOLEAN_INPUTS = {
  'control_if': ['CONDITION'],
  'control_if_else': ['CONDITION'],
  'control_repeat_until': ['CONDITION'],
  'control_while': ['CONDITION'],
  'control_wait_until': ['CONDITION'],
  'operator_not': ['OPERAND'],
  'operator_and': ['OPERAND1', 'OPERAND2'],
  'operator_or': ['OPERAND1', 'OPERAND2']
};

const needsBooleanWrap = (opcode, inputName, childBlock) => {
  if (!BOOLEAN_INPUTS[opcode] || !BOOLEAN_INPUTS[opcode].includes(inputName)) return false;
  if (!childBlock) return false;
  return childBlock.opcode === 'math_number' || childBlock.opcode === 'text';
};

const wrapAsBoolean = (childId, newBlocks, genId, outerId) => {
  const zeroId = genId();
  newBlocks[zeroId] = {
    opcode: 'math_number',
    next: null, parent: null,
    inputs: {},
    fields: {NUM: [0]},
    shadow: true, topLevel: false
  };

  const eqId = genId();
  newBlocks[eqId] = {
    opcode: 'operator_equals',
    next: null, parent: null,
    inputs: {
      OPERAND1: [1, childId],
      OPERAND2: [1, zeroId]
    },
    fields: {},
    shadow: false, topLevel: false
  };

  const notId = genId();
  newBlocks[notId] = {
    opcode: 'operator_not',
    next: null, parent: outerId,
    inputs: {
      OPERAND: [2, eqId]
    },
    fields: {},
    shadow: false, topLevel: false
  };

  newBlocks[childId].parent = eqId;
  newBlocks[zeroId].parent = eqId;
  newBlocks[eqId].parent = notId;

  return notId;
};

const wrapAsBooleanValue = (childId, newBlocks, genId, outerId) => {
  const zeroId = genId();
  newBlocks[zeroId] = {
    opcode: 'text',
    next: null, parent: null,
    inputs: {},
    fields: {TEXT: ['0']},
    shadow: true, topLevel: false
  };

  const eqId = genId();
  newBlocks[eqId] = {
    opcode: 'operator_equals',
    next: null, parent: null,
    inputs: {
      OPERAND1: [1, childId],
      OPERAND2: [1, zeroId]
    },
    fields: {},
    shadow: false, topLevel: false
  };

  const notId = genId();
  newBlocks[notId] = {
    opcode: 'operator_not',
    next: null, parent: outerId,
    inputs: {
      OPERAND: [2, eqId]
    },
    fields: {},
    shadow: false, topLevel: false
  };

  newBlocks[childId].parent = eqId;
  newBlocks[zeroId].parent = eqId;
  newBlocks[eqId].parent = notId;

  return notId;
};

const makeMenuShadow = (parentId, menuInfo, value, newBlocks, genId, lookup) => {
  const menuId = genId();
  const menuFields = {};

  if (menuInfo.variableType === 'broadcast_msg') {
    let bid = '';
    for (const [id, name] of Object.entries(lookup.broadcastMap)) {
      if (name === value) { bid = id; break; }
    }
    menuFields[menuInfo.fieldName] = [sanitizeXMLText(value), sanitizeXMLText(bid)];
  } else {
    menuFields[menuInfo.fieldName] = [sanitizeXMLText(value)];
  }

  newBlocks[menuId] = {
    opcode: menuInfo.opcode,
    next: null,
    parent: parentId,
    inputs: {},
    fields: menuFields,
    shadow: true,
    topLevel: false
  };
  return menuId;
};

const REQUIRED_FIELDS = {
  'looks_costumenumbername': {NUMBER_NAME: 'number'},
  'looks_backdropnumbername': {NUMBER_NAME: 'number'},
  'sensing_current': {CURRENTMENU: 'YEAR'},
  'sensing_of': {PROPERTY: 'x position'},
  'motion_setrotationstyle': {STYLE: 'all around'},
  'looks_gotofrontback': {FRONT_BACK: 'front'},
  'looks_goforwardbackwardlayers': {FORWARD_BACKWARD: 'forward'},
  'looks_seteffectto': {EFFECT: 'COLOR'},
  'looks_changeeffectby': {EFFECT: 'COLOR'},
  'sound_seteffectto': {EFFECT: 'PITCH'},
  'sound_changeeffectby': {EFFECT: 'PITCH'},
  'sensing_setdragmode': {DRAG_MODE: 'draggable'},
  'control_stop': {STOP_OPTION: 'all'},
  'event_whenkeypressed': {KEY_OPTION: 'space'},
  'event_whenbackdropswitchesto': {BACKDROP: ''},
  'event_whengreaterthan': {WHENGREATERTHANMENU: 'TIMER'},
  'event_whenbroadcastreceived': {BROADCAST_OPTION: ['', '']},
  'operator_mathop': {OPERATOR: 'abs'}
};

const ensureRequiredFields = (nb) => {
  const required = REQUIRED_FIELDS[nb.opcode];
  if (!required) return;
  for (const [k, defVal] of Object.entries(required)) {
    const existing = nb.fields[k];
    let needs = false;
    if (!existing) needs = true;
    else if (Array.isArray(existing)) {
      if (existing.length === 0 || existing[0] === undefined || existing[0] === null) needs = true;
    } else if (typeof existing === 'object') {
      if (existing.name === undefined && existing.id === undefined && existing.value === undefined) needs = true;
    }
    if (needs) {
      nb.fields[k] = Array.isArray(defVal) ? defVal.slice() : [defVal];
    }
  }
};

const readMenuValue = (sv) => {
  if (!sv || typeof sv !== 'object') return '';
  if (sv.opcode === 'constant') return sv.value == null ? '' : String(sv.value);
  if (sv.opcode === 'data_variable' && sv.inputs && sv.inputs.VARIABLE) {
    return sv.inputs.VARIABLE.name || '';
  }
  if (sv.opcode === 'data_listcontents' && sv.inputs && sv.inputs.LIST) {
    return sv.inputs.LIST.name || '';
  }
  return '';
};

const isStackInputArray = (val) =>
  Array.isArray(val) &&
  val.length >= 2 &&
  (val[0] === 1 || val[0] === 2 || val[0] === 3) &&
  typeof val[1] === 'string';

const isPreExpandedInput = (val, newBlocks) =>
  Array.isArray(val) &&
  val.length >= 2 &&
  typeof val[0] === 'number' && val[0] >= 1 && val[0] <= 3 &&
  (!newBlocks || newBlocks[val[1]] !== undefined || typeof val[1] === 'string');

const ARG_REPORTERS = new Set([
  'argument_reporter_string_number',
  'argument_reporter_boolean'
]);
const isProceduresRelated = (opcode) =>
  opcode === 'procedures_definition' ||
  opcode === 'procedures_prototype' ||
  opcode === 'procedures_call' ||
  opcode === 'procedures_return' ||
  ARG_REPORTERS.has(opcode);

const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const isColorString = (v) => typeof v === 'string' && COLOR_RE.test(v);

const makePrimitive = (v, parentId, newBlocks, genId, lookup) => {
  if (!v || typeof v !== 'object' || !v.opcode) return null;

  if (v.opcode === 'constant') {
    const id = genId();
    const value = v.value;
    if (typeof value === 'number') {
      newBlocks[id] = {
        opcode: 'math_number',
        next: null, parent: parentId,
        inputs: {}, fields: {NUM: [value]},
        shadow: true, topLevel: false
      };
    } else if (isColorString(value)) {
      newBlocks[id] = {
        opcode: 'colour_picker',
        next: null, parent: parentId,
        inputs: {},
        fields: {COLOUR: [value]},
        shadow: true, topLevel: false
      };
    } else {
      newBlocks[id] = {
        opcode: 'text',
        next: null, parent: parentId,
        inputs: {},
        fields: {TEXT: [sanitizeXMLText(value == null ? '' : String(value))]},
        shadow: true, topLevel: false
      };
    }
    return id;
  }

  if (v.opcode === 'data_variable' || v.opcode === 'data_listcontents') {
    const id = genId();
    const fields = {};
    if (v.opcode === 'data_variable' && v.inputs && v.inputs.VARIABLE) {
      const enc = encodeField('VARIABLE', v.inputs.VARIABLE, lookup);
      if (enc) fields.VARIABLE = enc;
    } else if (v.opcode === 'data_listcontents' && v.inputs && v.inputs.LIST) {
      const enc = encodeField('LIST', v.inputs.LIST, lookup);
      if (enc) fields.LIST = enc;
    }
    newBlocks[id] = {
      opcode: v.opcode,
      next: null, parent: parentId,
      inputs: {}, fields,
      shadow: false, topLevel: false
    };
    ensureRequiredFields(newBlocks[id]);
    return id;
  }

  if (ARG_REPORTERS.has(v.opcode)) {
    const id = genId();
    const fields = {};
    if (v.fields && v.fields.VALUE) {
      const fv = v.fields.VALUE;
      if (Array.isArray(fv)) {
        fields.VALUE = [sanitizeXMLText(fv[0])];
        if (fv.length > 1) fields.VALUE.push(fv[1]);
      } else if (fv && typeof fv === 'object' && 'value' in fv) {
        fields.VALUE = [sanitizeXMLText(fv.value)];
      } else {
        fields.VALUE = [sanitizeXMLText(String(fv))];
      }
    }
    if (!fields.VALUE) fields.VALUE = ['arg0'];
    newBlocks[id] = {
      opcode: v.opcode,
      next: null, parent: parentId,
      inputs: {}, fields,
      shadow: false, topLevel: false
    };
    return id;
  }

  const id = genId();
  const nb = {
    opcode: v.opcode,
    next: null, parent: parentId,
    inputs: {},
    fields: encodeFields(v.fields, lookup),
    shadow: false, topLevel: false
  };
  if (v.mutation) nb.mutation = sanitizeMutation(v.mutation);
  newBlocks[id] = nb;

  if (v.inputs) {
    for (const [k, sv] of Object.entries(v.inputs)) {
      if (k === 'VARIABLE' || k === 'LIST' || k === 'BROADCAST_OPTION') {
        const enc = encodeField(k, sv, lookup);
        if (enc) nb.fields[k] = enc;
        continue;
      }

      const menuInfo = MENU_MAP[nb.opcode] && MENU_MAP[nb.opcode][k];
      if (menuInfo) {
        if (isPreExpandedInput(sv, newBlocks)) {
          nb.inputs[k] = sv;
          continue;
        }
        if (sv && typeof sv === 'object' && sv.opcode) {
          if (sv.opcode === 'constant') {
            const menuId = makeMenuShadow(id, menuInfo, readMenuValue(sv), newBlocks, genId, lookup);
            nb.inputs[k] = [1, menuId];
            continue;
          }
          const childId = makePrimitive(sv, id, newBlocks, genId, lookup);
          if (childId) {
            const sh = newBlocks[childId].shadow === true;
            if (sh) {
              nb.inputs[k] = [1, childId];
            } else {
              const menuId = makeMenuShadow(id, menuInfo, '', newBlocks, genId, lookup);
              nb.inputs[k] = [3, childId, menuId];
            }
          }
          continue;
        }
      }

      if (isPreExpandedInput(sv, newBlocks)) {
        nb.inputs[k] = sv;
        continue;
      }
      if (k === 'SUBSTACK' || k === 'SUBSTACK2') {
        if (isStackInputArray(sv)) {
          nb.inputs[k] = sv;
          continue;
        }
        if (sv && Array.isArray(sv.blocks) && sv.blocks.length > 0) {
          const inner = expandSubstack(sv.blocks, id, newBlocks, genId, lookup);
          if (inner) nb.inputs[k] = [2, inner];
        }
        continue;
      }
      if (sv && typeof sv === 'object' && sv.opcode) {
        const childId = makePrimitive(sv, id, newBlocks, genId, lookup);
        if (childId) {
          const childBlock = newBlocks[childId];
          if (needsBooleanWrap(nb.opcode, k, childBlock)) {
            const wrappedId = wrapAsBoolean(childId, newBlocks, genId, id);
            nb.inputs[k] = [2, wrappedId];
          } else {
            const sh = childBlock.shadow === true;
            nb.inputs[k] = sh ? [1, childId] : [2, childId];
          }
        }
        continue;
      }
      if (typeof sv === 'string' || typeof sv === 'number' || typeof sv === 'boolean') {
        nb.fields[k] = [sanitizeXMLText(sv)];
      }
    }
  }

  ensureRequiredFields(nb);
  return id;
};

const expandSubstack = (stack, parentId, newBlocks, genId, lookup) => {
  let prevId = null;
  let firstId = null;
  for (const sb of stack) {
    if (!sb || !sb.opcode) continue;
    const sbId = genId();
    const nsub = {
      opcode: sb.opcode,
      next: null, parent: prevId || parentId,
      inputs: {},
      fields: encodeFields(sb.fields, lookup),
      shadow: false, topLevel: false
    };
    if (sb.mutation) nsub.mutation = sanitizeMutation(sb.mutation);
    newBlocks[sbId] = nsub;

    if (prevId) newBlocks[prevId].next = sbId;
    if (!firstId) firstId = sbId;
    prevId = sbId;

    if (sb.inputs) {
      for (const [sk, sv] of Object.entries(sb.inputs)) {
        if (sk === 'VARIABLE' || sk === 'LIST' || sk === 'BROADCAST_OPTION') {
          const enc = encodeField(sk, sv, lookup);
          if (enc) nsub.fields[sk] = enc;
          continue;
        }

        const menuInfo = MENU_MAP[nsub.opcode] && MENU_MAP[nsub.opcode][sk];
        if (menuInfo) {
          if (isPreExpandedInput(sv, newBlocks)) {
            nsub.inputs[sk] = sv;
            continue;
          }
          if (sv && typeof sv === 'object' && sv.opcode) {
            if (sv.opcode === 'constant') {
              const menuId = makeMenuShadow(sbId, menuInfo, readMenuValue(sv), newBlocks, genId, lookup);
              nsub.inputs[sk] = [1, menuId];
              continue;
            }
            const childId = makePrimitive(sv, sbId, newBlocks, genId, lookup);
            if (childId) {
              const sh = newBlocks[childId].shadow === true;
              if (sh) {
                nsub.inputs[sk] = [1, childId];
              } else {
                const menuId = makeMenuShadow(sbId, menuInfo, '', newBlocks, genId, lookup);
                nsub.inputs[sk] = [3, childId, menuId];
              }
            }
            continue;
          }
        }

        if (isPreExpandedInput(sv, newBlocks)) {
          nsub.inputs[sk] = sv;
          continue;
        }
        if (sk === 'SUBSTACK' || sk === 'SUBSTACK2') {
          if (isStackInputArray(sv)) {
            nsub.inputs[sk] = sv;
            continue;
          }
          if (sv && Array.isArray(sv.blocks) && sv.blocks.length > 0) {
            const inner = expandSubstack(sv.blocks, sbId, newBlocks, genId, lookup);
            if (inner) nsub.inputs[sk] = [2, inner];
          }
          continue;
        }
        if (sv && typeof sv === 'object' && sv.opcode) {
          if (nsub.opcode === 'procedures_call' && nsub.mutation) {
            const proto = lookup.protoByProccode && lookup.protoByProccode[nsub.mutation.proccode];
            if (proto) {
              const idx = proto.argIds.indexOf(sk);
              if (idx >= 0 && proto.argTypes[idx] === '%b') {
                const childId = makePrimitive(sv, sbId, newBlocks, genId, lookup);
                if (childId) {
                  const cb = newBlocks[childId];
                  if (cb.opcode === 'text' || cb.opcode === 'math_number') {
                    const wrappedId = wrapAsBooleanValue(childId, newBlocks, genId, sbId);
                    nsub.inputs[sk] = [2, wrappedId];
                  } else {
                    const sh = cb.shadow === true;
                    nsub.inputs[sk] = sh ? [1, childId] : [2, childId];
                  }
                }
                continue;
              }
            }
          }

          const childId = makePrimitive(sv, sbId, newBlocks, genId, lookup);
          if (childId) {
            const childBlock = newBlocks[childId];
            if (needsBooleanWrap(nsub.opcode, sk, childBlock)) {
              const wrappedId = wrapAsBoolean(childId, newBlocks, genId, sbId);
              nsub.inputs[sk] = [2, wrappedId];
            } else {
              const sh = childBlock.shadow === true;
              nsub.inputs[sk] = sh ? [1, childId] : [2, childId];
            }
          }
          continue;
        }
        if (typeof sv === 'string' || typeof sv === 'number' || typeof sv === 'boolean') {
          nsub.fields[sk] = [sanitizeXMLText(sv)];
        }
      }
    }

    ensureRequiredFields(nsub);
  }
  return firstId;
};

const normalizeProjectVars = (out, log) => {
  const globalIds = new Set();
  const orderedTargets = [
    ...out.targets.filter(t => t.isStage),
    ...out.targets.filter(t => !t.isStage)
  ];
  let varCounter = 0;
  const genNewId = () => `_${(++varCounter).toString(36)}v`;

  const varRemapAll = new Map();
  const listRemapAll = new Map();

  for (const target of orderedTargets) {
    const varRemap = new Map();
    const listRemap = new Map();

    if (target.variables) {
      for (const oldId of Object.keys(target.variables)) {
        if (globalIds.has(oldId)) {
          const newId = genNewId();
          const entry = target.variables[oldId];
          delete target.variables[oldId];
          target.variables[newId] = entry;
          varRemap.set(oldId, newId);
          varRemapAll.set(oldId, newId);
          globalIds.add(newId);
          log(`[varfix] ${target.name}: rename variable ${oldId} -> ${newId}`);
        } else {
          globalIds.add(oldId);
        }
      }
    }

    if (target.lists) {
      for (const oldId of Object.keys(target.lists)) {
        if (globalIds.has(oldId)) {
          const newId = genNewId();
          const entry = target.lists[oldId];
          delete target.lists[oldId];
          target.lists[newId] = entry;
          listRemap.set(oldId, newId);
          listRemapAll.set(oldId, newId);
          globalIds.add(newId);
          log(`[varfix] ${target.name}: rename list ${oldId} -> ${newId}`);
        } else {
          globalIds.add(oldId);
        }
      }
    }

    if ((varRemap.size === 0 && listRemap.size === 0) || !target.blocks) continue;
    for (const block of Object.values(target.blocks)) {
      if (!block || !block.fields) continue;
      for (const [fk, fv] of Object.entries(block.fields)) {
        if (!Array.isArray(fv) || fv.length < 2) continue;
        if (fk === 'VARIABLE' && varRemap.has(fv[1])) {
          fv[1] = varRemap.get(fv[1]);
        } else if (fk === 'LIST' && listRemap.has(fv[1])) {
          fv[1] = listRemap.get(fv[1]);
        }
      }
    }
  }

  if (varRemapAll.size > 0 || listRemapAll.size > 0) {
    for (const mon of out.monitors || []) {
      if (!mon || !mon.params) continue;
      if (mon.params.VARIABLE && varRemapAll.has(mon.params.VARIABLE)) {
        mon.params.VARIABLE = varRemapAll.get(mon.params.VARIABLE);
      }
      if (mon.params.LIST && listRemapAll.has(mon.params.LIST)) {
        mon.params.LIST = listRemapAll.get(mon.params.LIST);
      }
    }
    const stage = out.targets.find(t => t.isStage);
    if (stage && stage.broadcasts) {
      for (const [oldId, name] of Object.entries(stage.broadcasts)) {
        if (varRemapAll.has(oldId)) {
          delete stage.broadcasts[oldId];
          stage.broadcasts[varRemapAll.get(oldId)] = name;
        } else if (listRemapAll.has(oldId)) {
          delete stage.broadcasts[oldId];
          stage.broadcasts[listRemapAll.get(oldId)] = name;
        }
      }
    }
  }

  const stage = out.targets.find(t => t.isStage);
  const findByNameInMap = (map, name) => {
    for (const [id, entry] of Object.entries(map || {})) {
      const n = Array.isArray(entry) ? entry[0] : (entry && entry.name) || id;
      if (n === name) return {id, entry};
    }
    return null;
  };

  for (const target of out.targets) {
    if (!target.blocks) continue;
    const vars = target.variables || {};
    const lists = target.lists || {};
    const stageVars = (!target.isStage && stage && stage.variables) || {};
    const stageLists = (!target.isStage && stage && stage.lists) || {};

    for (const [blockId, block] of Object.entries(target.blocks)) {
      if (!block || !block.fields) continue;

      const vf = block.fields.VARIABLE;
      if (vf && Array.isArray(vf) && vf[1]) {
        const vid = vf[1];
        const inVars = vars[vid] || stageVars[vid];
        if (!inVars) {
          const inLists = lists[vid] || stageLists[vid];
          if (inLists) {
            const lname = Array.isArray(inLists) ? inLists[0] : (inLists && inLists.name) || vid;
            let varId = null;
            const found = findByNameInMap(vars, lname) || findByNameInMap(stageVars, lname);
            if (found) varId = found.id;
            if (!varId) {
              varId = genNewId();
              if (!target.variables) target.variables = {};
              target.variables[varId] = [lname, 0];
              log(`[varfix] ${target.name}: created variable "${lname}" (${varId}) for block ${blockId}`);
            }
            vf[0] = lname;
            vf[1] = varId;
          } else {
            log(`[varfix] ${target.name}: variable id ${vid} not declared, dropping VARIABLE field on ${blockId}`);
            delete block.fields.VARIABLE;
          }
        }
      }

      const lf = block.fields.LIST;
      if (lf && Array.isArray(lf) && lf[1]) {
        const lid = lf[1];
        const inLists = lists[lid] || stageLists[lid];
        if (!inLists) {
          const inVars = vars[lid] || stageVars[lid];
          if (inVars) {
            const vname = Array.isArray(inVars) ? inVars[0] : (inVars && inVars.name) || lid;
            let listId = null;
            const found = findByNameInMap(lists, vname) || findByNameInMap(stageLists, vname);
            if (found) listId = found.id;
            if (!listId) {
              listId = genNewId();
              if (!target.lists) target.lists = {};
              target.lists[listId] = [vname, []];
              log(`[varfix] ${target.name}: created list "${vname}" (${listId}) for block ${blockId}`);
            }
            lf[0] = vname;
            lf[1] = listId;
          } else {
            log(`[varfix] ${target.name}: list id ${lid} not declared, dropping LIST field on ${blockId}`);
            delete block.fields.LIST;
          }
        }
      }
    }
  }
};

const alignProcedureCalls = (out, log) => {
  const protoByProccode = {};
  for (const target of out.targets) {
    if (!target.blocks) continue;
    for (const b of Object.values(target.blocks)) {
      if (!b || b.opcode !== 'procedures_prototype' || !b.mutation) continue;
      const pc = b.mutation.proccode;
      if (!pc) continue;
      let protoIds = [], protoNames = [];
      try { protoIds = JSON.parse(b.mutation.argumentids || '[]'); } catch (e) {}
      try { protoNames = JSON.parse(b.mutation.argumentnames || '[]'); } catch (e) {}
      protoByProccode[pc] = {protoIds, protoNames, protoBlock: b};
    }
  }

  let aligned = 0, dropped = 0, unbound = 0;
  for (const target of out.targets) {
    if (!target.blocks) continue;
    const blocks = target.blocks;
    for (const [id, b] of Object.entries(blocks)) {
      if (!b || b.opcode !== 'procedures_call' || !b.mutation) continue;
      const proto = protoByProccode[b.mutation.proccode];
      if (!proto) {
        dropped++;
        log(`[proccall] no prototype for "${b.mutation.proccode}" (block ${id})`);
        continue;
      }
      const {protoIds, protoNames} = proto;
      let callIds = [];
      try { callIds = JSON.parse(b.mutation.argumentids || '[]'); } catch (e) {}

      const map = {};
      callIds.forEach((old, i) => { if (protoIds[i]) map[old] = protoIds[i]; });

      if (callIds.length !== protoIds.length || Object.keys(map).length > 0) {
        const newInputs = {};
        for (const [k, v] of Object.entries(b.inputs || {})) {
          newInputs[map[k] || k] = v;
        }
        b.inputs = newInputs;
        b.mutation.argumentids = JSON.stringify(protoIds);
        aligned++;
      }

      for (const [slotKey, inp] of Object.entries(b.inputs || {})) {
        if (!Array.isArray(inp) || !inp[1]) continue;
        const childId = typeof inp[1] === 'string' ? inp[1] : (Array.isArray(inp[1]) ? inp[1][1] : null);
        if (!childId) continue;
        const child = blocks[childId];
        if (!child) continue;
        if (child.opcode !== 'argument_reporter_string_number' &&
            child.opcode !== 'argument_reporter_boolean') continue;
        const val = child.fields && child.fields.VALUE;
        const name = Array.isArray(val) ? val[0] : (val && val.name);
        if (name && !protoNames.includes(name)) {
          const idx = protoIds.indexOf(slotKey);
          if (idx >= 0 && protoNames[idx]) {
            child.fields.VALUE = [protoNames[idx]];
            unbound++;
          }
        }
      }
    }
  }
  if (aligned || dropped || unbound) {
    log(`[sb3] alignProcedureCalls: aligned=${aligned} dropped=${dropped} unbound-fixed=${unbound}`);
  }
};

const normalizeProceduresCallMutations = (out, log) => {
  for (const target of out.targets) {
    if (!target.blocks) continue;
    let touched = 0;
    for (const [id, b] of Object.entries(target.blocks)) {
      if (!b || b.opcode !== 'procedures_call' || !b.mutation) continue;
      const m = b.mutation;
      const next = {
        tagName: m.tagName || 'mutation',
        children: m.children || [],
        proccode: m.proccode,
        argumentids: m.argumentids,
        warp: m.warp
      };
      if (m.return !== undefined) next.return = m.return;
      b.mutation = next;
      touched++;
    }
    if (touched > 0) {
      log(`[sb3] normalized ${touched} procedures_call mutations in ${target.name}`);
    }
  }
};

const SPECIAL_ID_CHARS =
  'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789^$~|:,;./!#%&*+-=<>?[]{}()';

const genSpecialIdFrom = (seed) => {
  const hash = crypto.createHash('sha1').update('sid:' + String(seed)).digest();
  let s = '';
  for (let i = 0; i < 22; i++) {
    s += SPECIAL_ID_CHARS[hash[i % hash.length] % SPECIAL_ID_CHARS.length];
  }
  return s;
};

const renameSimpleArgumentIds = (out, log) => {
  for (const target of out.targets) {
    if (!target.blocks) continue;

    for (const [bId, b] of Object.entries(target.blocks)) {
      if (!b || b.opcode !== 'procedures_prototype' || !b.mutation) continue;
      let ids;
      try { ids = JSON.parse(b.mutation.argumentids); } catch (e) { continue; }
      if (!Array.isArray(ids)) continue;

      const simple = ids.some(id => /^arg\d+$/.test(id));
      if (!simple) continue;

      const proccode = b.mutation.proccode || '';
      const map = {};
      const newIds = ids.map(old => {
        const n = genSpecialIdFrom(`${target.name}::${proccode}::${old}`);
        map[old] = n;
        return n;
      });

      b.mutation.argumentids = JSON.stringify(newIds);

      const newInputs = {};
      for (const [k, v] of Object.entries(b.inputs || {})) {
        newInputs[map[k] || k] = v;
      }
      b.inputs = newInputs;

      for (const [cId, c] of Object.entries(target.blocks)) {
        if (!c || c.opcode !== 'procedures_call' || !c.mutation) continue;
        if (c.mutation.proccode !== proccode) continue;

        let cIds;
        try { cIds = JSON.parse(c.mutation.argumentids); } catch (e) { cIds = []; }
        const newCIds = cIds.map(old => map[old] || old);
        c.mutation.argumentids = JSON.stringify(newCIds);

        const newCInputs = {};
        for (const [k, v] of Object.entries(c.inputs || {})) {
          newCInputs[map[k] || k] = v;
        }
        c.inputs = newCInputs;
      }

      log(`[sb3] renamed ${ids.length} simple argument ids in prototype ${bId} (${proccode})`);
    }
  }
};

const EXT_OPCODE_OVERRIDE = {
  'ningqiCollection_labelCondition': 'labelCondition',
  'ningqiCollection_labelCollection': 'labelCollection',
  'ningqiCollection_labelString': 'labelString',
  'ningqiCollection_labelCloud': 'labelCloud',
  'ningqiCollection_labelAsset': 'labelAsset',
};

const applyExtOpcodeOverride = (newBlocks, extraMap, log) => {
  const map = Object.assign({}, EXT_OPCODE_OVERRIDE, extraMap || {});
  const keys = Object.keys(map);
  if (keys.length === 0) return;
  let fixed = 0;
  for (const b of Object.values(newBlocks)) {
    if (!b || typeof b.opcode !== 'string') continue;
    const mapped = map[b.opcode];
    if (mapped && mapped !== b.opcode) {
      b.opcode = mapped;
      fixed++;
    }
  }
  if (fixed > 0) log(`[sb3] ext opcode override applied to ${fixed} blocks`);
};

const buildSb3 = async (projectJson, assets, opts = {}) => {
  const out = JSON.parse(JSON.stringify(projectJson));
  let counter = 0;
  const genId = () => `_${(++counter).toString(36)}`;

  const log = opts.log || (() => {});
  const keepPlaceholders = !!opts.keepPlaceholders;

  const stage = out.targets.find(t => t.isStage);

  const protoByProccode = {};
  for (const target of out.targets) {
    if (!target.blocks) continue;
    for (const b of Object.values(target.blocks)) {
      if (!b || b.opcode !== 'procedures_prototype' || !b.mutation) continue;
      const pc = b.mutation.proccode;
      let ids = [];
      try { ids = JSON.parse(b.mutation.argumentids || '[]'); } catch (e) {}
      const argTypes = (pc.match(/%[snb]/g) || []);
      protoByProccode[pc] = {argIds: ids, argTypes};
    }
  }

  for (const target of out.targets) {
    const oldBlocks = target.blocks || {};
    const newBlocks = {};
    const lookup = buildLookup(target, stage);
    lookup.protoByProccode = protoByProccode;

    for (const [oldId, b] of Object.entries(oldBlocks)) {
      if (!b || !b.opcode) continue;
      const nb = {
        opcode: b.opcode,
        next: b.next || null,
        parent: b.parent || null,
        inputs: {},
        fields: encodeFields(b.fields, lookup),
        shadow: !!b.shadow,
        topLevel: !!b.topLevel
      };
      if (b.topLevel) {
        nb.x = typeof b.x === 'number' ? b.x : 0;
        nb.y = typeof b.y === 'number' ? b.y : 0;
      }
      if (b.mutation) nb.mutation = sanitizeMutation(b.mutation);
      if (b.meta) nb.meta = JSON.parse(JSON.stringify(b.meta));
      ensureRequiredFields(nb);
      newBlocks[oldId] = nb;
    }

    for (const [oldId, b] of Object.entries(oldBlocks)) {
      if (!b || !b.opcode || !b.inputs) continue;
      const nb = newBlocks[oldId];
      if (!nb) continue;
      for (const [k, val] of Object.entries(b.inputs)) {
        if (val && typeof val === 'object' && val.opcode === 'constant') {
          const childId = makePrimitive(val, oldId, newBlocks, genId, lookup);
          if (childId) {
            const childBlock = newBlocks[childId];
            const sh = childBlock.shadow === true;
            nb.inputs[k] = sh ? [1, childId] : [2, childId];
          }
          continue;
        }

        const menuInfo = MENU_MAP[nb.opcode] && MENU_MAP[nb.opcode][k];
        if (menuInfo) {
          if (isPreExpandedInput(val, newBlocks)) {
            nb.inputs[k] = val;
            continue;
          }
          if (val && typeof val === 'object' && val.opcode) {
            if (val.opcode === 'constant') {
              const menuId = makeMenuShadow(oldId, menuInfo, readMenuValue(val), newBlocks, genId, lookup);
              nb.inputs[k] = [1, menuId];
              continue;
            }
            const childId = makePrimitive(val, oldId, newBlocks, genId, lookup);
            if (childId) {
              const sh = newBlocks[childId].shadow === true;
              if (sh) {
                nb.inputs[k] = [1, childId];
              } else {
                const menuId = makeMenuShadow(oldId, menuInfo, '', newBlocks, genId, lookup);
                nb.inputs[k] = [3, childId, menuId];
              }
            }
            continue;
          }
        }

        if (isPreExpandedInput(val, newBlocks)) {
          nb.inputs[k] = val;
          continue;
        }

        if (k === 'VARIABLE' || k === 'LIST' || k === 'BROADCAST_OPTION') {
          const enc = encodeField(k, val, lookup);
          if (enc) nb.fields[k] = enc;
          continue;
        }

        if (k === 'custom_block') {
          if (val && val.block) {
            const protoId = val.block;
            if (!newBlocks[protoId] && oldBlocks[protoId]) {
              const proto = oldBlocks[protoId];
              const np = {
                opcode: proto.opcode,
                next: null, parent: oldId,
                inputs: {},
                fields: encodeFields(proto.fields, lookup),
                shadow: true, topLevel: false
              };
              if (proto.mutation) np.mutation = sanitizeMutation(proto.mutation);
              newBlocks[protoId] = np;
            } else if (newBlocks[protoId]) {
              newBlocks[protoId].parent = oldId;
              newBlocks[protoId].shadow = true;
              newBlocks[protoId].topLevel = false;
            }
            nb.inputs.custom_block = [1, protoId];
          }
          continue;
        }

        if (val && typeof val === 'object' && !val.opcode && val.block && val.name !== undefined) {
          const argBlockId = val.block;
          if (!newBlocks[argBlockId] && oldBlocks[argBlockId]) {
            const argB = oldBlocks[argBlockId];
            const na = {
              opcode: argB.opcode,
              next: null, parent: oldId,
              inputs: {},
              fields: encodeFields(argB.fields, lookup),
              shadow: true, topLevel: false
            };
            if (argB.mutation) na.mutation = sanitizeMutation(argB.mutation);
            newBlocks[argBlockId] = na;
          } else if (newBlocks[argBlockId]) {
            newBlocks[argBlockId].parent = oldId;
            newBlocks[argBlockId].shadow = true;
            newBlocks[argBlockId].topLevel = false;
          }
          if (newBlocks[argBlockId]) {
            nb.inputs[k] = [1, argBlockId];
          }
          continue;
        }

        if (k === 'SUBSTACK' || k === 'SUBSTACK2') {
          if (isStackInputArray(val)) {
            nb.inputs[k] = val;
            continue;
          }
          if (val && Array.isArray(val.blocks) && val.blocks.length > 0) {
            const firstId = expandSubstack(val.blocks, oldId, newBlocks, genId, lookup);
            if (firstId) nb.inputs[k] = [2, firstId];
          }
          continue;
        }

        if (val && typeof val === 'object' && val.opcode) {
          if (nb.opcode === 'procedures_call' && nb.mutation) {
            const proto = lookup.protoByProccode && lookup.protoByProccode[nb.mutation.proccode];
            if (proto) {
              const idx = proto.argIds.indexOf(k);
              if (idx >= 0 && proto.argTypes[idx] === '%b') {
                const childId = makePrimitive(val, oldId, newBlocks, genId, lookup);
                if (childId) {
                  const cb = newBlocks[childId];
                  if (cb.opcode === 'text' || cb.opcode === 'math_number') {
                    const wrappedId = wrapAsBooleanValue(childId, newBlocks, genId, oldId);
                    nb.inputs[k] = [2, wrappedId];
                  } else {
                    const sh = cb.shadow === true;
                    nb.inputs[k] = sh ? [1, childId] : [2, childId];
                  }
                }
                continue;
              }
            }
          }

          const childId = makePrimitive(val, oldId, newBlocks, genId, lookup);
          if (childId) {
            const childBlock = newBlocks[childId];
            if (needsBooleanWrap(nb.opcode, k, childBlock)) {
              const wrappedId = wrapAsBoolean(childId, newBlocks, genId, oldId);
              nb.inputs[k] = [2, wrappedId];
            } else {
              const sh = childBlock.shadow === true;
              nb.inputs[k] = sh ? [1, childId] : [2, childId];
            }
          }
          continue;
        }

        if (typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean') {
          nb.fields[k] = [sanitizeXMLText(val)];
        }
      }
    }

    applyExtOpcodeOverride(newBlocks, opts.extOpcodeMap, log);

    const placeholderSources = [];
    if (!keepPlaceholders) {
      for (const [id, blk] of Object.entries(newBlocks)) {
        if (!blk || !blk.meta || !blk.meta.placeholder) continue;
        placeholderSources.push({
          source: blk.meta.source,
          truncated: !!blk.meta.truncated
        });

        const prev = blk.parent;
        const next = blk.next;
        if (prev && newBlocks[prev] && newBlocks[prev].next === id) {
          newBlocks[prev].next = next || null;
        }
        if (next && newBlocks[next]) {
          newBlocks[next].parent = prev || null;
        }
        for (const [oid, ob] of Object.entries(newBlocks)) {
          if (!ob || !ob.inputs || oid === id) continue;
          for (const [ik, iv] of Object.entries(ob.inputs)) {
            if (Array.isArray(iv) && iv[1] === id) {
              if (next && newBlocks[next]) {
                iv[1] = next;
                newBlocks[next].parent = oid;
              } else {
                delete ob.inputs[ik];
              }
            }
          }
        }
        delete newBlocks[id];
      }
      if (placeholderSources.length > 0) {
        log(`[sb3] extracted ${placeholderSources.length} placeholder blocks to comments (target ${target.name})`);
      }
    }

    const refStats = fixBlockRefs(newBlocks, {log});
    const dirty = refStats.removed || refStats.fixedRefs || refStats.fixedOrphans ||
                  refStats.fixedCycles || refStats.fixedShadow || refStats.fixedCoords;
    if (dirty) {
      log(`[sb3] fix-refs: removed=${refStats.removed} ` +
          `refs=${refStats.fixedRefs} orphans=${refStats.fixedOrphans} ` +
          `cycles=${refStats.fixedCycles} shadow=${refStats.fixedShadow} ` +
          `coords=${refStats.fixedCoords} remaining=${refStats.remaining}`);
    }

    for (const block of Object.values(newBlocks)) {
      if (!block || !block.fields) continue;
      if (Object.prototype.hasOwnProperty.call(block.fields, 'BROADCAST_OPTION')) {
        const v = block.fields.BROADCAST_OPTION;
        let name = '', id = '';
        if (Array.isArray(v)) { name = v[0] || ''; id = v[1] || ''; }
        else if (v && typeof v === 'object') { name = v.name || ''; id = v.id || ''; }

        if (id && stage && stage.broadcasts && stage.broadcasts[id] !== undefined) {
          name = stage.broadcasts[id];
        } else if (!id && name) {
          const hit = lookup.broadcastIndex && lookup.broadcastIndex.get(String(name).toLowerCase());
          if (hit) { name = hit.name; id = hit.id; }
          else { id = deterministicBroadcastId(name); }
        }

        block.fields.BROADCAST_OPTION = [sanitizeXMLText(String(name)), sanitizeXMLText(String(id))];

        if (stage) {
          if (!stage.broadcasts) stage.broadcasts = {};
          const exists = Object.entries(stage.broadcasts).some(
            ([tid, tname]) =>
              tid === id || String(tname).toLowerCase() === String(name).toLowerCase()
          );
          if (!exists) stage.broadcasts[id] = name;
        }
      }
    }

    if (placeholderSources.length > 0) {
      if (!target.comments) target.comments = {};
      for (let i = 0; i < placeholderSources.length; i++) {
        const cid = `ph_${String(target.name || 'target').replace(/[^\w]/g, '_')}_${i}`;
        target.comments[cid] = {
          blockId: null,
          x: 40 + (i % 3) * 340,
          y: 40 + Math.floor(i / 3) * 220,
          width: 300,
          height: 180,
          minimized: false,
          text: `[unresolved]\n${placeholderSources[i].source}`
        };
      }
    }

    target.blocks = newBlocks;
  }

  alignProcedureCalls(out, log);
  normalizeProceduresCallMutations(out, log);
  renameSimpleArgumentIds(out, log);
  normalizeProjectVars(out, log);

  for (const target of out.targets) {
    if (target && Object.prototype.hasOwnProperty.call(target, 'layerOrder')) {
      delete target.layerOrder;
    }
  }

  const targetCount = out.targets.length;
  let layerOrderValid = false;
  if (Array.isArray(out.layerOrder) && out.layerOrder.length === targetCount) {
    const seen = new Set();
    let isPermutation = true;
    for (const idx of out.layerOrder) {
      if (typeof idx !== 'number' || idx < 0 || idx >= targetCount || seen.has(idx)) {
        isPermutation = false;
        break;
      }
      seen.add(idx);
    }
    if (isPermutation) layerOrderValid = true;
  }
  if (!layerOrderValid) {
    out.layerOrder = out.targets.map((_, i) => i);
    log(`[sb3] rebuilt layerOrder for ${targetCount} targets`);
  }

  const zip = new JSZip();
  zip.file('project.json', JSON.stringify(out));
  for (const [name, data] of Object.entries(assets || {})) {
    zip.file(name, data);
  }
  return await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: {level: 6}
  });
};

module.exports = {buildSb3};