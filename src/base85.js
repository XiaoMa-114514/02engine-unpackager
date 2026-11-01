'use strict';

const getBase85DecodeValue = (code) => {
  if (code === 0x28) code = 0x3c;
  if (code === 0x29) code = 0x3e;
  return code - 0x2a;
};

const decode = (str) => {
  const outLength = Math.ceil(str.length / 5) * 4;
  const out = new Uint8Array(outLength);
  const view = new DataView(out.buffer);
  for (let i = 0, j = 0; i < str.length; i += 5, j += 4) {
    view.setUint32(j, (
      getBase85DecodeValue(i + 4 < str.length ? str.charCodeAt(i + 4) : 0x2a) * 85 * 85 * 85 * 85 +
      getBase85DecodeValue(i + 3 < str.length ? str.charCodeAt(i + 3) : 0x2a) * 85 * 85 * 85 +
      getBase85DecodeValue(i + 2 < str.length ? str.charCodeAt(i + 2) : 0x2a) * 85 * 85 +
      getBase85DecodeValue(i + 1 < str.length ? str.charCodeAt(i + 1) : 0x2a) * 85 +
    ), true);
  }
  return out;
};

module.exports = {decode};
