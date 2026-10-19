'use strict';

// Electron's nativeImage is unavailable in worker_threads. Decode the actual
// pixel stream here; assets.cjs still checks headers, dimensions and byte limits.
const { PNG } = require('pngjs');
const jpeg = require('jpeg-js');

module.exports = {
  createFromBuffer(bytes) {
    const image = bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
      ? PNG.sync.read(bytes, { checkCRC: true })
      : jpeg.decode(bytes, { useTArray: true, formatAsRGBA: false, tolerantDecoding: false,
        maxResolutionInMP: 64 * 1024 * 1024 / 1000000, maxMemoryUsageInMB: 1024 });
    const size = { width: image.width, height: image.height };
    return { isEmpty: () => !size.width || !size.height, getSize: () => ({ ...size }) };
  },
};
