const sharp = require('sharp');
const { parseKtx, buildKtx } = require('ktx-parse'); // install ktx-parse
const os = require('os');

const FACE_NAMES = ['+X','-X','+Y','-Y','+Z','-Z'];
const CONVENTIONS = {
  Engineering: { upAxis: 'Z', handed: 'R' },
  OpenGL:      { upAxis: 'Y', handed: 'R' },
  Unreal:      { upAxis: 'Z', handed: 'L' },
  Unity:       { upAxis: 'Y', handed: 'L' }
};

// ... (include basisForConvention, mat3MulVec, mat3Transpose, dirToFaceUV, etc.)
// Use same helper implementations from previous file (omitted here for brevity).
// Paste the functions: basisForConvention, mat3MulVec, mat3Transpose, dirToFaceUV,
// mat3Transpose, convertVectorBetweenConventions, sampleFaceNearest, readFaces, FACE_NAMES, CONVENTIONS, etc.

// ---------- KTX I/O helpers ----------

// parseKtx(buffer) returns an object describing levels/images; we expect cubemap with 6 faces.
// This helper extracts the first mip level and returns an object:
// { faces: Map faceName-> { w,h,data }, faceOrder: array of face names in input file order }
async function readKtx(buffer) {
  const k = parseKtx(buffer); // throws on invalid
  // ktx-parse exposes ktx.header, ktx.images: array of levels; for cubemap, images[0] is array of 6 faces
  if (!k.header || !k.images || k.images.length === 0) throw new Error('Invalid KTX file');
  const level0 = k.images[0];
  // level0 should be an array of 6 face objects (each with pixelData Uint8Array)
  if (!Array.isArray(level0) || level0.length < 6) throw new Error('Not a cubemap or missing faces');
  // Determine width/height from header
  const w = k.header.pixelWidth;
  const h = k.header.pixelHeight;
  if (w !== h) throw new Error('Non-square faces not supported');
  // ktx-parse gives faces in the order stored in file. We'll assume canonical order +X,-X,+Y,-Y,+Z,-Z
  // If the file stores in a different order, user must provide ordering; many KTX cubemaps follow canonical.
  const faces = {};
  for (let i = 0; i < 6; i++) {
    const img = level0[i];
    // img.pixelData is Uint8Array in the file format's pixel encoding; parseKtx should give raw RGBA for uncompressed
    let data = img.pixelData;
    // If data is not RGBA raw, use sharp to decode buffer (e.g., PNG inside KTX) — handle common cases:
    if (!(data instanceof Uint8Array) || data.length !== w * h * 4) {
      // try to decode with sharp (supports PNG/JPEG inside)
      const decoded = await sharp(Buffer.from(data)).ensureAlpha().raw().toBuffer();
      data = decoded;
    } else {
      data = Buffer.from(data);
    }
    faces[FACE_NAMES[i]] = { w, h, data, channels: 4 };
  }
  return { faces, faceOrder: FACE_NAMES.slice() };
}

// Build a KTX2 buffer from 6 RGBA face Buffers using ktx-parse builder.
// options: {isKTX2: true/false, format: 'RGBA8' }
function writeKtx(faceBuffersMap, faceOrder = FACE_NAMES, options = { isKTX2: true }) {
  // build images array: single level with 6 faces in the specified order
  const facesArray = faceOrder.map(fn => {
    const f = faceBuffersMap[fn];
    return { pixelData: f.data, width: f.w, height: f.h };
  });
  const ktx = buildKtx({
    pixelWidth: facesArray[0].width,
    pixelHeight: facesArray[0].height,
    images: [facesArray],
    isKTX2: options.isKTX2,
    // choose uncompressed RGBA8 format
    vkFormat: 'VK_FORMAT_R8G8B8A8_UNORM'
  });
  return Buffer.from(ktx);
}

// ---------- Core conversion using raw face maps ----------

async function convertCubemapFromFaceMap(faceMap, srcConvention, dstConvention) {
  // faceMap: faceName-> {w,h,data}
  const srcBasis = basisForConvention(CONVENTIONS[srcConvention]);
  const dstBasis = basisForConvention(CONVENTIONS[dstConvention]);
  const faceSize = faceMap[FACE_NAMES[0]].w;
  const dstRawFaces = {};
  for (const faceName of FACE_NAMES) {
    const w = faceSize, h = faceSize;
    const out = Buffer.alloc(w*h*4);
    for (let y=0;y<h;y++) {
      for (let x=0;x<w;x++) {
        const u = (2*(x + 0.5)/w - 1);
        const v = (2*(y + 0.5)/h - 1);
        let dirLocal;
        switch(faceName) {
          case '+X': dirLocal = [1, -v, -u]; break;
          case '-X': dirLocal = [-1, -v, u]; break;
          case '+Y': dirLocal = [u, 1, v]; break;
          case '-Y': dirLocal = [u, -1, -v]; break;
          case '+Z': dirLocal = [u, -v, 1]; break;
          case '-Z': dirLocal = [-u, -v, -1]; break;
        }
        const L = Math.hypot(dirLocal[0],dirLocal[1],dirLocal[2]);
        dirLocal = dirLocal.map(c => c / L);
        const srcDirLocal = convertVectorBetweenConventions(dirLocal, dstBasis, srcBasis);
        const { face: srcFace, u: su, v: sv } = dirToFaceUV(srcDirLocal[0], srcDirLocal[1], srcDirLocal[2]);
        const rgba = sampleFaceNearest(faceMap[srcFace], su, sv);
        const idx = (y*w + x)*4;
        out[idx]=rgba[0]; out[idx+1]=rgba[1]; out[idx+2]=rgba[2]; out[idx+3]=rgba[3];
      }
    }
    dstRawFaces[faceName] = { w: faceSize, h: faceSize, data: out };
  }
  return dstRawFaces;
}

// ---------- Public wrapper: accepts KTX/KTX2 Buffer in, returns KTX/KTX2 Buffer out ----------
async function convertCubemapKtx(inputKtxBuffer, srcConvention, dstConvention, opts = { isKTX2: true }) {
  // read KTX into face map
  const { faces: srcFaces, faceOrder } = await readKtx(inputKtxBuffer);
  // convert
  const dstFaces = await convertCubemapFromFaceMap(srcFaces, srcConvention, dstConvention);
  // write KTX (preserve KTX2 if requested)
  const outBuf = writeKtx(dstFaces, FACE_NAMES, opts);
  return outBuf;
}

module.exports = {
  convertCubemapKtx,
  convertCubemapFromFaceMap,
  writeKtx,
  readKtx,
  FACE_NAMES,
  CONVENTIONS
};