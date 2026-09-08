const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const { spawnSync } = require('child_process');
const readline = require('readline');

const MDAT_DATA_OFFSET = 48;
const MAX_NAL = 10 * 1024 * 1024;

function log(msg) { console.log(`[fix-vods] ${msg}`); }
function warn(msg) { console.warn(`[fix-vods] WARNING: ${msg}`); }

// One interface for every prompt. Creating a fresh one per question would work on a
// console but not on piped input, where closing the first interface ends stdin and
// every later question would come back empty.
let rl = null;
let stdinEnded = false;

function askQuestion(query) {
  if (stdinEnded) return Promise.resolve('');
  if (!rl) {
    rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.on('close', () => { stdinEnded = true; });
  }
  return new Promise(resolve => {
    // Without this, stdin ending before an answer arrives would leave the
    // promise pending forever.
    const onClose = () => resolve('');
    rl.once('close', onClose);
    rl.question(query, answer => { rl.removeListener('close', onClose); resolve(answer.trim()); });
  });
}

// Releases stdin so the process can exit once the last question has been asked.
function closeQuestions() { if (rl) { rl.close(); rl = null; } }

async function promptOutputMode() {
  console.log('');
  console.log('  How would you like to save the fixed files?');
  console.log('');
  console.log('    1) Save as new copies (*_fixed.mp4)  [RECOMMENDED]');
  console.log('       Original files remain untouched. Safe and reversible.');
  console.log('');
  console.log('    2) Replace originals in-place');
  console.log('       The fixed file is written separately first and only replaces');
  console.log('       the original after the repair succeeds. Still destructive:');
  console.log('       the broken original is deleted and cannot be re-processed');
  console.log('       later with better tools or a better reference file.');
  console.log('');
  const answer = await askQuestion('  Choose [1/2] (default: 1): ');
  if (answer === '2') {
    console.log('');
    console.log('  \x1b[31m!!! DANGER ZONE !!!\x1b[0m');
    const c1 = await askQuestion('  Type "YES I UNDERSTAND THE RISK" to proceed: ');
    if (c1 !== 'YES I UNDERSTAND THE RISK') { log('  Wise choice. Saving as new copies.'); return 'copy'; }
    const c2 = await askQuestion('  Are you ABSOLUTELY sure? [y/N]: ');
    if (c2.toLowerCase() !== 'y') { log('  Saving as new copies.'); return 'copy'; }
    return 'inplace';
  }
  return 'copy';
}

function findTool(name) {
  const suffixes = process.platform === 'win32' ? ['.exe', ''] : [''];
  for (const s of suffixes) {
    const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [name + s], {
      encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe']
    });
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim().split(/\r?\n/)[0];
  }
  return null;
}

// --- untrunc download (Windows) ---

function httpGet(url, dest, redirects) {
  redirects = redirects || 0;
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('too many redirects'));
    const req = https.get(url, {
      headers: { 'User-Agent': 'fix-vods', 'Accept': '*/*' }
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(httpGet(res.headers.location, dest, redirects + 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode} for ${url}`)); }
      if (dest) {
        const total = parseInt(res.headers['content-length'], 10) || 0;
        const showProgress = total > 0 && process.stdout.isTTY;
        let got = 0, lastPct = -1;
        if (total) log(`  size: ${(total / 1024 / 1024).toFixed(1)} MB`);
        res.on('data', chunk => {
          got += chunk.length;
          if (!showProgress) return;
          const pct = Math.floor(got * 20 / total) * 5;
          if (pct !== lastPct) { lastPct = pct; process.stdout.write(`\r  ${pct}%`); }
        });
        const out = fs.createWriteStream(dest);
        res.pipe(out);
        out.on('finish', () => {
          if (showProgress) process.stdout.write('\r      \r');
          out.close(() => resolve(dest));
        });
        out.on('error', reject);
        res.on('error', reject);
      } else {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', c => { data += c; });
        res.on('end', () => resolve(data));
        res.on('error', reject);
      }
    });
    req.on('error', reject);
    req.setTimeout(300000, () => req.destroy(new Error('download timed out')));
  });
}

function findExeIn(dir, pattern) {
  if (!fs.existsSync(dir)) return null;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (pattern.test(e.name)) return p;
    }
  }
  return null;
}

function findUntruncExe(dir) { return findExeIn(dir, /^untrunc(\.exe)?$/i); }

// Both projects publish their Windows builds under fixed asset names on a permanent
// "latest" release, so the files are fetched directly: no GitHub API call, no API rate limit.
const UNTRUNC_ZIP_URL = arch => `https://github.com/anthwlock/untrunc/releases/download/latest/untrunc_${arch}.zip`;
const FFMPEG_ZIP_URL = arch => `https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-${arch}-lgpl-shared.zip`;

async function downloadAndUnpack(url, destDir) {
  const name = url.slice(url.lastIndexOf('/') + 1);
  const zipPath = path.join(os.tmpdir(), name);
  log(`Downloading ${name} from ${new URL(url).host}...`);
  await httpGet(url, zipPath);

  fs.mkdirSync(destDir, { recursive: true });
  log('Unpacking...');
  let r = spawnSync('tar', ['-xf', zipPath, '-C', destDir], { encoding: 'utf8', timeout: 300000 });
  if (r.status !== 0) {
    r = spawnSync('powershell', ['-NoProfile', '-Command',
      `Expand-Archive -LiteralPath "${zipPath}" -DestinationPath "${destDir}" -Force`],
      { encoding: 'utf8', timeout: 300000 });
    if (r.status !== 0) throw new Error('could not unpack the zip (tried tar and Expand-Archive)');
  }
  try { fs.unlinkSync(zipPath); } catch {}
}

// untrunc is a separate GPL-licensed project. It is fetched from its own GitHub
// releases at the user's request and is never shipped with this script.
async function downloadUntrunc(destDir) {
  const arch = (process.arch === 'x64' || process.arch === 'arm64') ? 'x64' : 'x32';
  await downloadAndUnpack(UNTRUNC_ZIP_URL(arch), destDir);

  const exe = findUntruncExe(destDir);
  if (!exe) throw new Error('zip unpacked but no untrunc executable found inside');
  log(`untrunc installed: ${exe}`);
  return exe;
}

// ffmpeg is a separate LGPL/GPL-licensed project. The LGPL "shared" Windows build
// from BtbN/FFmpeg-Builds is fetched at the user's request. Only -c copy remuxing
// and ffprobe are needed here, so the LGPL variant is sufficient.
async function downloadFfmpeg(destDir) {
  const arch = process.arch === 'arm64' ? 'winarm64' : 'win64';
  await downloadAndUnpack(FFMPEG_ZIP_URL(arch), destDir);

  // The zip also contains headers, import libraries, and the ffplay player. None are needed here.
  for (const top of fs.readdirSync(destDir, { withFileTypes: true })) {
    if (!top.isDirectory()) continue;
    for (const sub of ['include', 'lib', 'doc', path.join('bin', 'ffplay.exe')]) {
      const p = path.join(destDir, top.name, sub);
      if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
    }
  }

  const ffmpeg = findExeIn(destDir, /^ffmpeg\.exe$/i);
  const ffprobe = findExeIn(destDir, /^ffprobe\.exe$/i);
  if (!ffmpeg || !ffprobe) throw new Error('zip unpacked but ffmpeg.exe/ffprobe.exe not found inside');
  log(`ffmpeg installed: ${ffmpeg}`);
  return { ffmpeg, ffprobe };
}

// --- probing ---

// Resolved in main(): full path to ffprobe, or null when it is unavailable.
let ffprobeBin = null;

function probeFile(f) {
  if (!ffprobeBin) return null;
  try {
    const r = spawnSync(ffprobeBin, ['-v', 'error', '-show_entries',
      'stream=codec_name,codec_type,width,height,r_frame_rate,sample_rate,channels',
      '-show_entries', 'format=duration,size', '-of', 'json', f],
      { encoding: 'utf8', timeout: 30000 });
    return r.status === 0 ? JSON.parse(r.stdout) : null;
  } catch { return null; }
}

function getRefFps(refPath) {
  const p = probeFile(refPath);
  const v = p && p.streams && p.streams.find(s => s.codec_type === 'video');
  const m = v && v.r_frame_rate && /^(\d+)\/(\d+)$/.exec(v.r_frame_rate);
  if (!m) return null;
  const num = parseInt(m[1], 10), den = parseInt(m[2], 10);
  if (!num || !den) return null;
  const fps = num / den;
  if (fps < 5 || fps > 240) return null;
  const g = gcd(num, den);
  return { num: num / g, den: den / g };
}

function readMp4Boxes(filePath) {
  const fd = fs.openSync(filePath, 'r');
  const fileSize = fs.fstatSync(fd).size;
  const boxes = [];
  let offset = 0;
  const hdr = Buffer.alloc(8);
  while (offset + 8 <= fileSize) {
    fs.readSync(fd, hdr, 0, 8, offset);
    const size = hdr.readUInt32BE(0);
    const type = hdr.toString('ascii', 4, 8);
    if (size < 8) break;
    boxes.push({ type, size, offset });
    if (offset + size > fileSize) break;
    offset += size;
  }
  fs.closeSync(fd);
  return { boxes, fileSize };
}

function isBrokenMp4(filePath) {
  const { boxes } = readMp4Boxes(filePath);
  const hasMoov = boxes.some(b => b.type === 'moov');
  const hasFtyp = boxes.some(b => b.type === 'ftyp');
  const hasMdat = boxes.some(b => b.type === 'mdat');
  if (!hasFtyp || !hasMdat) return { broken: false, reason: 'not MP4' };
  if (!hasMoov) return { broken: true, reason: 'missing moov' };
  // Without ffprobe the moov cannot be verified. Assume files that have one are fine
  if (!ffprobeBin) return { broken: false, reason: 'valid' };
  const p = probeFile(filePath);
  if (!p || !p.streams || p.streams.length === 0) return { broken: true, reason: 'moov corrupt' };
  return { broken: false, reason: 'valid' };
}

function verifyAndLog(filePath) {
  const p = probeFile(filePath);
  if (!p || !p.streams) return;
  for (const s of p.streams) {
    const info = s.codec_type === 'video'
      ? `${s.codec_name} ${s.width}x${s.height} ${s.r_frame_rate}fps`
      : `${s.codec_name} ${s.sample_rate}Hz ${s.channels}ch`;
    log(`  Verified: ${s.codec_type} - ${info}`);
  }
  if (p.format && p.format.duration) {
    const d = parseFloat(p.format.duration);
    log(`  Duration: ${Math.floor(d / 60)}m ${Math.floor(d % 60)}s`);
  }
}

// --- H.264 parsing ---

function gcd(a, b) { while (b) { const t = a % b; a = b; b = t; } return a; }

// Remove emulation-prevention bytes (00 00 03 -> 00 00) to get the raw RBSP
function unescapeRbsp(buf) {
  const out = Buffer.alloc(buf.length);
  let o = 0;
  for (let i = 0; i < buf.length; i++) {
    if (i >= 2 && buf[i] === 3 && buf[i - 1] === 0 && buf[i - 2] === 0 && (i + 1 >= buf.length || buf[i + 1] <= 3)) continue;
    out[o++] = buf[i];
  }
  return out.slice(0, o);
}

function parseSPS(spsBuf) {
  if (spsBuf.length < 4) return null;
  spsBuf = unescapeRbsp(spsBuf);
  const profile_idc = spsBuf[0];
  const level_idc = spsBuf[2];
  let p = 24;
  function rEU() {
    let l = 0;
    while (p < spsBuf.length * 8) { if ((spsBuf[p >> 3] >> (7 - (p & 7))) & 1) { p++; break; } l++; p++; }
    if (!l) return 0;
    let v = 1;
    for (let i = 0; i < l; i++) { v = (v << 1) | ((spsBuf[p >> 3] >> (7 - (p & 7))) & 1); p++; }
    return v - 1;
  }
  function rB(n) { let v = 0; for (let i = 0; i < n; i++) { v = v * 2 + ((spsBuf[p >> 3] >> (7 - (p & 7))) & 1); p++; } return v; }
  try {
    rEU();
    if ([100, 110, 122, 244, 44, 83, 86, 118, 128].includes(profile_idc)) {
      const c = rEU(); if (c === 3) p++; rEU(); rEU(); p++;
      if (rB(1)) { const n = c !== 3 ? 8 : 12; for (let i = 0; i < n; i++) { if (rB(1)) { let ls = 8, ns = 8; for (let j = 0; j < (i < 6 ? 16 : 64); j++) { if (ns) { const d = rEU(); ns = (ls + d + 256) % 256; } ls = ns || ls; } } } }
    }
    rEU();
    const pc = rEU();
    if (pc === 0) rEU();
    else if (pc === 1) { p++; rEU(); rEU(); const n = rEU(); for (let i = 0; i < n; i++) rEU(); }
    rEU(); p++;
    const w = rEU(), h = rEU(), f = rB(1);
    if (!f) rB(1);                     // mb_adaptive_frame_field_flag
    rB(1);                             // direct_8x8_inference_flag
    let cropL = 0, cropR = 0, cropT = 0, cropB = 0;
    if (rB(1)) { cropL = rEU(); cropR = rEU(); cropT = rEU(); cropB = rEU(); }
    // VUI, parsed only as far as timing_info (framerate)
    let fpsNum = null, fpsDen = null;
    if (rB(1)) {
      if (rB(1)) { if (rB(8) === 255) rB(32); }   // aspect_ratio_info (Extended_SAR)
      if (rB(1)) rB(1);                            // overscan_info
      if (rB(1)) { rB(4); if (rB(1)) rB(24); }     // video_signal_type + colour description
      if (rB(1)) { rEU(); rEU(); }                 // chroma_loc_info
      if (rB(1)) {                                 // timing_info_present_flag
        const numUnits = rB(32), timeScale = rB(32);
        const fps = numUnits > 0 ? timeScale / (2 * numUnits) : 0;
        if (fps >= 5 && fps <= 240) { fpsNum = timeScale; fpsDen = 2 * numUnits; }
      }
    }
    // crop units assume 4:2:0 chroma
    const width = (w + 1) * 16 - (cropL + cropR) * 2;
    const height = (2 - f) * (h + 1) * 16 - (cropT + cropB) * 2 * (2 - f);
    return { profile_idc, level_idc, width, height, fpsNum, fpsDen };
  } catch { return null; }
}

function findDataBoundary(fd, fileSize) {
  const probeBuf = Buffer.alloc(256 * 1024);
  let lo = MDAT_DATA_OFFSET, hi = fileSize;
  while (hi - lo > probeBuf.length) {
    const mid = lo + Math.floor((hi - lo) / 2);
    fs.readSync(fd, probeBuf, 0, probeBuf.length, mid);
    if (probeBuf.every(b => b === 0)) hi = mid; else lo = mid + probeBuf.length;
  }
  const b1 = Buffer.alloc(1);
  for (let i = Math.max(lo - probeBuf.length, MDAT_DATA_OFFSET); i < hi; i++) {
    fs.readSync(fd, b1, 0, 1, i);
    if (b1[0] === 0) {
      const check = Buffer.alloc(4096);
      fs.readSync(fd, check, 0, Math.min(check.length, fileSize - i), i);
      if (check.every(b => b === 0)) return i;
    }
  }
  return fileSize;
}

function parseAuAt(fd, filePos, dataEnd) {
  const bufSize = Math.min(200 * 1024, dataEnd - filePos);
  if (bufSize < 8) return null;
  const buf = Buffer.alloc(bufSize);
  fs.readSync(fd, buf, 0, bufSize, filePos);
  const nalus = [];
  let pos = 0;
  while (pos + 4 < buf.length) {
    const len = buf.readUInt32BE(pos);
    if (len < 2 || len > MAX_NAL || pos + 4 + len > buf.length) break;
    const hdr = buf[pos + 4];
    if ((hdr & 0x80) !== 0) break;
    const type = hdr & 0x1f;
    if (type > 31) break;
    nalus.push({ relOffset: pos, length: len, type });
    pos += 4 + len;
    if (type === 1 || type === 5) break;
  }
  if (nalus.length === 0) return null;
  const totalSize = nalus.reduce((sum, n) => sum + 4 + n.length, 0);
  return {
    nalus, totalSize,
    hasAUD: nalus[0].type === 9,
    hasSlice: nalus.some(n => n.type === 1 || n.type === 5),
    hasIDR: nalus.some(n => n.type === 5)
  };
}

function scanVideoAUs(fd, firstAU, dataEnd, dataStart) {
  dataStart = dataStart || MDAT_DATA_OFFSET;
  const videoAUs = [{ offset: dataStart, size: firstAU.totalSize, isKey: firstAU.hasIDR }];
  let pos = dataStart + firstAU.totalSize;
  const MIN_AU_SIZE = 500;
  const MAX_AUDIO_GAP = 2048;
  const laBuf = Buffer.alloc(4 * 1024 * 1024);

  while (pos < dataEnd) {
    const searchStart = pos + 100;
    const searchEnd = Math.min(pos + MAX_AUDIO_GAP, dataEnd);
    if (searchStart >= dataEnd) break;
    const toRead = searchEnd - searchStart;
    fs.readSync(fd, laBuf, 0, toRead, searchStart);
    let found = false;
    for (let i = 0; i <= toRead - 5; i++) {
      if (laBuf[i] === 0 && laBuf[i + 1] === 0 && laBuf[i + 2] === 0 && laBuf[i + 3] === 2 && laBuf[i + 4] === 9) {
        const candidate = searchStart + i;
        const au = parseAuAt(fd, candidate, dataEnd);
        if (au && au.hasAUD && au.hasSlice && au.totalSize >= MIN_AU_SIZE) {
          videoAUs.push({ offset: candidate, size: au.totalSize, isKey: au.hasIDR });
          pos = candidate + au.totalSize;
          found = true;
          break;
        }
      }
    }
    if (!found) {
      const wideEnd = Math.min(pos + 100 * 1024, dataEnd);
      const wideRead = wideEnd - pos;
      fs.readSync(fd, laBuf, 0, wideRead, pos);
      let wideFound = false;
      for (let i = 0; i <= wideRead - 5; i++) {
        if (laBuf[i] === 0 && laBuf[i + 1] === 0 && laBuf[i + 2] === 0 && laBuf[i + 3] === 2 && laBuf[i + 4] === 9) {
          const candidate = pos + i;
          const au = parseAuAt(fd, candidate, dataEnd);
          if (au && au.hasAUD && au.hasSlice && au.totalSize >= MIN_AU_SIZE) {
            videoAUs.push({ offset: candidate, size: au.totalSize, isKey: au.hasIDR });
            pos = candidate + au.totalSize;
            wideFound = true;
            break;
          }
        }
      }
      if (!wideFound) pos += 100 * 1024;
    }
    const count = videoAUs.length;
    if (count <= 10 || count % 2000 === 0) {
      const au = videoAUs[count - 1];
      log(`    AU[${count - 1}] at ${au.offset}, size ${au.size}`);
    }
  }
  return videoAUs;
}

function buildVideoMoov(videoAUs, spsBuf, spsNaluData, ppsNaluData, spsInfo, timescale, frameDuration) {
  const { width, height } = spsInfo;

  function box(type, payload) {
    const h = Buffer.alloc(8);
    h.writeUInt32BE(8 + payload.length, 0);
    h.write(type, 4);
    return Buffer.concat([h, payload]);
  }

  // Identity matrix for mvhd/tkhd (ISO 14496-12)
  const MATRIX = Buffer.from([
    0x00, 0x01, 0x00, 0x00, // a
    0x00, 0x00, 0x00, 0x00, // b
    0x00, 0x00, 0x00, 0x00, // c
    0x00, 0x00, 0x00, 0x00, // d
    0x00, 0x01, 0x00, 0x00, // e
    0x00, 0x00, 0x00, 0x00, // f
    0x00, 0x00, 0x00, 0x00, // u
    0x00, 0x00, 0x00, 0x00, // v
    0x40, 0x00, 0x00, 0x00, // w (1.0 in 2.30 fixed-point)
  ]);

  // === avcC ===
  const avcCLen = 19 + spsNaluData.length + ppsNaluData.length;
  const avcC = Buffer.alloc(avcCLen);
  avcC.writeUInt32BE(avcCLen, 0); avcC.write('avcC', 4);
  avcC[8] = 1; avcC[9] = spsBuf[0]; avcC[10] = spsBuf[1]; avcC[11] = spsBuf[2];
  avcC[12] = 0xFF; avcC[13] = 0xE1;
  avcC.writeUInt16BE(spsNaluData.length, 14); spsNaluData.copy(avcC, 16);
  avcC[16 + spsNaluData.length] = 1;
  avcC.writeUInt16BE(ppsNaluData.length, 17 + spsNaluData.length); ppsNaluData.copy(avcC, 19 + spsNaluData.length);

  // === avc1 (86-byte VisualSampleEntry header) ===
  const pasp = Buffer.alloc(16); pasp.writeUInt32BE(16, 0); pasp.write('pasp', 4); pasp.writeUInt32BE(1, 8); pasp.writeUInt32BE(1, 12);
  const btrt = Buffer.alloc(20); btrt.writeUInt32BE(20, 0); btrt.write('btrt', 4);
  const avc1Hdr = 86;
  const avc1 = Buffer.alloc(avc1Hdr + avcC.length + pasp.length + btrt.length);
  avc1.writeUInt32BE(avc1.length, 0); avc1.write('avc1', 4);
  avc1.writeUInt16BE(1, 14);           // data_reference_index
  avc1.writeUInt16BE(width, 32); avc1.writeUInt16BE(height, 34);
  avc1.writeUInt32BE(0x00480000, 36);  // horizresolution 72dpi
  avc1.writeUInt32BE(0x00480000, 40);  // vertresolution 72dpi
  avc1.writeUInt16BE(1, 48);           // frame_count
  // compressor_name: 32-byte Pascal string at offset 50
  const compName = Buffer.from([0x0C, ...Buffer.from('VideoHandler')]);
  compName.copy(avc1, 50);
  avc1.writeUInt16BE(0x0018, 82);      // depth = 24-bit
  avc1.writeInt16BE(-1, 84);           // pre_defined
  avcC.copy(avc1, avc1Hdr);
  pasp.copy(avc1, avc1Hdr + avcC.length);
  btrt.copy(avc1, avc1Hdr + avcC.length + pasp.length);

  // === stbl ===
  const vStsdHdr = Buffer.alloc(16);
  vStsdHdr.writeUInt32BE(16 + avc1.length, 0); vStsdHdr.write('stsd', 4); vStsdHdr.writeUInt32BE(0, 8); vStsdHdr.writeUInt32BE(1, 12);

  const vStts = Buffer.alloc(24); vStts.writeUInt32BE(24, 0); vStts.write('stts', 4); vStts.writeUInt32BE(1, 12); vStts.writeUInt32BE(videoAUs.length, 16); vStts.writeUInt32BE(frameDuration, 20);
  const vStsc = Buffer.alloc(28); vStsc.writeUInt32BE(28, 0); vStsc.write('stsc', 4); vStsc.writeUInt32BE(1, 12); vStsc.writeUInt32BE(1, 16); vStsc.writeUInt32BE(1, 20); vStsc.writeUInt32BE(1, 24);
  const vStsz = Buffer.alloc(20 + videoAUs.length * 4);
  vStsz.writeUInt32BE(20 + videoAUs.length * 4, 0); vStsz.write('stsz', 4); vStsz.writeUInt32BE(videoAUs.length, 16);
  videoAUs.forEach((au, i) => vStsz.writeUInt32BE(au.size, 20 + i * 4));
  const vStco = Buffer.alloc(16 + videoAUs.length * 4);
  vStco.writeUInt32BE(16 + videoAUs.length * 4, 0); vStco.write('stco', 4); vStco.writeUInt32BE(videoAUs.length, 12);
  videoAUs.forEach((au, i) => vStco.writeUInt32BE(au.offset, 16 + i * 4));

  // stss: keyframes at the IDR positions found during scanning
  const keyframes = [];
  videoAUs.forEach((au, i) => { if (au.isKey) keyframes.push(i + 1); });
  if (keyframes.length === 0) keyframes.push(1);
  const vStss = Buffer.alloc(16 + keyframes.length * 4);
  vStss.writeUInt32BE(16 + keyframes.length * 4, 0); vStss.write('stss', 4); vStss.writeUInt32BE(0, 8); vStss.writeUInt32BE(keyframes.length, 12);
  keyframes.forEach((k, i) => vStss.writeUInt32BE(k, 16 + i * 4));

  // === trak metadata ===
  const videoDuration = videoAUs.length * frameDuration;
  const vElst = Buffer.alloc(28); vElst.writeUInt32BE(28, 0); vElst.write('elst', 4); vElst.writeUInt32BE(1, 12); vElst.writeUInt32BE(videoDuration, 16); vElst.writeUInt32BE(0, 20); vElst.writeUInt16BE(1, 24);
  const vEdts = box('edts', vElst);

  const vStbl = box('stbl', Buffer.concat([vStsdHdr, avc1, vStts, vStss, vStsc, vStsz, vStco]));
  const vVmhd = Buffer.alloc(20); vVmhd.writeUInt32BE(20, 0); vVmhd.write('vmhd', 4); vVmhd.writeUInt32BE(1, 8);
  const vDref = Buffer.alloc(28); vDref.writeUInt32BE(28, 0); vDref.write('dref', 4);
  vDref.writeUInt32BE(0, 8); vDref.writeUInt32BE(1, 12);
  vDref.writeUInt32BE(12, 16); vDref.write('url ', 20); vDref.writeUInt32BE(1, 24);
  const vMinf = box('minf', Buffer.concat([vVmhd, box('dinf', vDref), vStbl]));

  const vMdhd = Buffer.alloc(32); vMdhd.writeUInt32BE(32, 0); vMdhd.write('mdhd', 4);
  vMdhd.writeUInt32BE(timescale, 20); vMdhd.writeUInt32BE(videoDuration, 24); vMdhd.writeUInt16BE(0x55C4, 28); // lang = 'und'
  const vHdlrP = Buffer.alloc(37); vHdlrP.write('vide', 8); vHdlrP.write('VideoHandler', 24);
  const vMdia = box('mdia', Buffer.concat([vMdhd, box('hdlr', vHdlrP), vMinf]));

  // tkhd v0 layout: matrix at byte 48, width at 84, height at 88 (ISO 14496-12)
  const vTkhd = Buffer.alloc(92); vTkhd.writeUInt32BE(92, 0); vTkhd.write('tkhd', 4);
  vTkhd.writeUInt32BE(3, 8);  // flags: enabled + in-movie
  vTkhd.writeUInt32BE(1, 20); // track_ID
  vTkhd.writeUInt32BE(videoDuration, 28); // duration
  MATRIX.copy(vTkhd, 48);
  vTkhd.writeUInt32BE(width << 16, 84);   // width, 16.16 fixed-point
  vTkhd.writeUInt32BE(height << 16, 88);  // height, 16.16 fixed-point

  const vTrak = box('trak', Buffer.concat([vTkhd, vEdts, vMdia]));

  // mvhd v0 layout: matrix at byte 44, next_track_ID at 104
  const mvhd = Buffer.alloc(108); mvhd.writeUInt32BE(108, 0); mvhd.write('mvhd', 4);
  mvhd.writeUInt32BE(timescale, 20); mvhd.writeUInt32BE(videoDuration, 24);
  mvhd.writeUInt32BE(0x00010000, 28); mvhd.writeUInt16BE(0x0100, 32); // rate, volume
  MATRIX.copy(mvhd, 44);
  mvhd.writeUInt32BE(2, 104); // next_track_ID

  return box('moov', Buffer.concat([mvhd, vTrak]));
}

function fixFile(inputPath, outputDir, ffmpegPath, referencePath, untruncPath, opts) {
  const r = fixFileInner(inputPath, outputDir, ffmpegPath, referencePath, untruncPath, opts);
  if (r.status === 'fixed' && opts.inplace) {
    try {
      fs.unlinkSync(inputPath);
      fs.renameSync(r.outputPath, inputPath);
      r.outputPath = inputPath;
      log(`  Replaced original: ${path.basename(inputPath)}`);
    } catch (e) {
      warn(`  Could not replace the original (${e.message}). Fixed file kept at: ${r.outputPath}`);
    }
  }
  return r;
}

function fixFileInner(inputPath, outputDir, ffmpegPath, referencePath, untruncPath, opts) {
  const fileName = path.basename(inputPath);
  const fixedName = fileName.replace(/\.mp4$/i, opts.inplace ? '_fixtmp.mp4' : '_fixed.mp4');
  const outputPath = path.join(outputDir, fixedName);

  if (fs.existsSync(outputPath)) {
    if (opts.inplace) {
      try { fs.unlinkSync(outputPath); } catch {} // stale temp from an interrupted run
    } else {
      log(`  Output exists, skipping: ${fixedName}`);
      return { status: 'skipped', reason: 'output exists' };
    }
  }

  // === Strategy 1: untrunc (video + audio) ===
  if (untruncPath && referencePath && fs.existsSync(referencePath)) {
    log(`  Trying untrunc (video + audio recovery)...`);
    try {
      const r = spawnSync(untruncPath, ['-n', '-sv', referencePath, inputPath], {
        encoding: 'utf8', timeout: 600000, stdio: ['pipe', 'pipe', 'pipe'],
        cwd: path.dirname(inputPath)
      });

      // untrunc appends directly to the input filename: <input>_fixed.mp4 or _fixed-sv.mp4.
      // For input "foo.mp4" this produces "foo.mp4_fixed-sv.mp4", not "foo_fixed-sv.mp4".
      const untruncOutSv = inputPath + '_fixed-sv.mp4';
      const untruncOut = inputPath + '_fixed.mp4';
      const untruncResult = fs.existsSync(untruncOutSv) ? untruncOutSv
        : fs.existsSync(untruncOut) ? untruncOut : null;

      if (untruncResult) {
        log(`  untrunc produced output, re-muxing...`);

        // Re-mux through ffmpeg to fix DTS timestamps and produce clean output
        if (ffmpegPath) {
          const remux = spawnSync(ffmpegPath, [
            '-v', 'error', '-fflags', '+genpts',
            '-i', untruncResult,
            '-c', 'copy', '-movflags', '+faststart',
            '-y', outputPath
          ], { encoding: 'utf8', timeout: 600000 });

          if (remux.status === 0 && fs.existsSync(outputPath)) {
            const info = probeFile(outputPath);
            const hasVideo = info && info.streams && info.streams.some(s => s.codec_type === 'video');

            if (hasVideo) {
              const audErr = spawnSync(ffmpegPath, ['-v', 'error', '-i', outputPath, '-f', 'null', '-'],
                { encoding: 'utf8', timeout: 600000 });
              const errCount = (audErr.stderr || '').trim().split('\n').filter(l => l.trim()).length;

              // Clean up untrunc temp files
              try { fs.unlinkSync(untruncResult); } catch {}
              if (untruncResult !== untruncOut && fs.existsSync(untruncOut)) try { fs.unlinkSync(untruncOut); } catch {}

              const outSize = fs.statSync(outputPath).size;
              const hasAudio = info.streams.some(s => s.codec_type === 'audio');
              log(`  Output: ${fixedName} (${(outSize / 1024 / 1024).toFixed(1)} MB)`);
              for (const s of info.streams) {
                const dur = s.duration ? ` ${parseFloat(s.duration).toFixed(0)}s` : '';
                log(`  Track: ${s.codec_type} - ${s.codec_name}${dur}`);
              }
              if (errCount > 0) log(`  DTS warnings: ${errCount} (harmless timestamp issues)`);
              return { status: 'fixed', outputPath, method: 'untrunc' + (hasAudio ? '+audio' : '') };
            }

            // untrunc produced no video track. Fall through to the moov build
            warn(`  untrunc output has no video track, falling through to the moov build...`);
            try { fs.unlinkSync(outputPath); } catch {}
          }
        }

        // Clean up untrunc temp files before falling through
        try { fs.unlinkSync(untruncResult); } catch {}
        if (untruncResult !== untruncOut && fs.existsSync(untruncOut)) try { fs.unlinkSync(untruncOut); } catch {}
      }

      // untrunc failed: log it and fall through
      const stderrPreview = (r.stderr || r.stdout || '').substring(0, 200);
      warn(`  untrunc failed: ${stderrPreview}`);
    } catch (e) {
      warn(`  untrunc error: ${e.message}`);
    }
  }

  // === Strategy 2: moov build + ffmpeg re-mux (video only) ===
  log(`  Building moov from scratch (video-only fallback)...`);
  const fileSize = fs.statSync(inputPath).size;
  const fd = fs.openSync(inputPath, 'r');

  try {
    log(`  Finding data boundary...`);
    const dataEnd = findDataBoundary(fd, fileSize);
    log(`  Real data: ${(dataEnd / 1024 / 1024).toFixed(1)} MB of ${(fileSize / 1024 / 1024).toFixed(1)} MB`);

    // Skip zero-padded prefix region (some files have pre-allocated but unwritten space).
    // Back up 4 bytes from the first non-zero byte so the zeros of an AVCC length
    // prefix (00 00 00 xx) are not mistaken for padding.
    let dataStart = MDAT_DATA_OFFSET;
    let foundData = false;
    const probeBuf = Buffer.alloc(256 * 1024);
    for (let off = MDAT_DATA_OFFSET; off < dataEnd && !foundData; off += probeBuf.length) {
      const n = Math.min(probeBuf.length, dataEnd - off);
      fs.readSync(fd, probeBuf, 0, n, off);
      for (let i = 0; i < n; i++) {
        if (probeBuf[i] !== 0) {
          dataStart = Math.max(MDAT_DATA_OFFSET, off + i - 4);
          foundData = true;
          break;
        }
      }
    }
    if (dataStart > MDAT_DATA_OFFSET) log(`  Skipping ${(dataStart / 1024 / 1024).toFixed(1)} MB zero-prefix`);

    log(`  Parsing first AU...`);
    // Try to parse an AU at dataStart. If that fails (not valid AVCC), scan forward for an AUD pattern plus SPS.
    let firstAU = parseAuAt(fd, dataStart, dataEnd);
    if (!firstAU || !firstAU.hasAUD) {
      // Scan forward for the first valid AU carrying SPS/PPS
      const scanBuf = Buffer.alloc(64 * 1024);
      let foundStart = -1;
      for (let off = dataStart; off < dataEnd && foundStart < 0; off += scanBuf.length - 20) {
        const n = Math.min(scanBuf.length, dataEnd - off);
        fs.readSync(fd, scanBuf, 0, n, off);
        for (let i = 0; i < n - 20; i++) {
          // Look for the AUD pattern: 00 00 00 02 09
          if (scanBuf[i]===0 && scanBuf[i+1]===0 && scanBuf[i+2]===0 && scanBuf[i+3]===2 && scanBuf[i+4]===9) {
            const au = parseAuAt(fd, off + i, dataEnd);
            if (au && au.hasAUD && au.nalus.some(n => n.type === 7)) {
              foundStart = off + i;
              firstAU = au;
              break;
            }
          }
        }
      }
      if (foundStart < 0) return { status: 'failed', reason: 'cannot find a valid H.264 AU with SPS in mdat' };
      dataStart = foundStart;
      log(`  Found first valid AU at ${(dataStart / 1024 / 1024).toFixed(1)} MB`);
    }

    const spsNalu = firstAU.nalus.find(n => n.type === 7);
    const ppsNalu = firstAU.nalus.find(n => n.type === 8);
    if (!spsNalu) return { status: 'failed', reason: 'no SPS' };

    const spsBuf = Buffer.alloc(spsNalu.length - 1);
    fs.readSync(fd, spsBuf, 0, spsNalu.length - 1, dataStart + spsNalu.relOffset + 5);
    const spsNaluData = Buffer.alloc(spsNalu.length);
    fs.readSync(fd, spsNaluData, 0, spsNalu.length, dataStart + spsNalu.relOffset + 4);
    const ppsNaluData = Buffer.alloc(ppsNalu.length);
    fs.readSync(fd, ppsNaluData, 0, ppsNalu.length, dataStart + ppsNalu.relOffset + 4);

    const spsInfo = parseSPS(spsBuf);
    if (!spsInfo) return { status: 'failed', reason: 'cannot parse SPS' };
    log(`  SPS: profile=${spsInfo.profile_idc} level=${spsInfo.level_idc} ${spsInfo.width}x${spsInfo.height}`);

    // Framerate: SPS VUI timing info, then the reference file, then 30fps
    let timescale, frameDuration, fpsSource;
    if (spsInfo.fpsNum && spsInfo.fpsDen) {
      const g = gcd(spsInfo.fpsNum, spsInfo.fpsDen);
      timescale = spsInfo.fpsNum / g; frameDuration = spsInfo.fpsDen / g;
      fpsSource = 'H.264 SPS';
    } else if (opts.refFps) {
      timescale = opts.refFps.num; frameDuration = opts.refFps.den;
      fpsSource = 'reference file';
    } else {
      timescale = 30; frameDuration = 1;
      fpsSource = 'assumed';
      warn(`  Could not detect framerate (no VUI timing in SPS, no reference file). Assuming 30 fps.`);
    }
    while (timescale < 10000) { timescale *= 10; frameDuration *= 10; }
    log(`  Framerate: ${(timescale / frameDuration).toFixed(3)} fps (${fpsSource})`);

    log(`  Scanning video AUs...`);
    const videoAUs = scanVideoAUs(fd, firstAU, dataEnd, dataStart);
    log(`  Found ${videoAUs.length} video AUs (${videoAUs.filter(a => a.isKey).length} keyframes)`);
    if (videoAUs.length < 10) return { status: 'failed', reason: 'too few AUs found' };

    log(`  Building moov...`);
    const moov = buildVideoMoov(videoAUs, spsBuf, spsNaluData, ppsNaluData, spsInfo, timescale, frameDuration);
    log(`  Moov: ${(moov.length / 1024).toFixed(0)} KB`);

    const lastAU = videoAUs[videoAUs.length - 1];
    const writeEnd = lastAU.offset + lastAU.size;

    // Write intermediate file: ftyp + corrected mdat + moov
    const interName = fileName.replace(/\.mp4$/i, '_inter.mp4');
    const interPath = path.join(outputDir, interName);
    const header = Buffer.alloc(48);
    fs.readSync(fd, header, 0, 48, 0);
    header.writeUInt32BE(writeEnd - 40, 40);

    log(`  Writing ${(writeEnd / 1024 / 1024).toFixed(1)} MB + moov...`);
    const out = fs.openSync(interPath, 'w');
    fs.writeSync(out, header);
    const copyBuf = Buffer.alloc(4 * 1024 * 1024);
    let cp = MDAT_DATA_OFFSET;
    while (cp < writeEnd) {
      const n = Math.min(copyBuf.length, writeEnd - cp);
      fs.readSync(fd, copyBuf, 0, n, cp);
      fs.writeSync(out, copyBuf, 0, n);
      cp += n;
    }
    fs.writeSync(out, moov);
    fs.closeSync(out);

    // ffmpeg re-mux (video only)
    if (ffmpegPath) {
      log(`  ffmpeg re-muxing (video only)...`);
      try {
        if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
        const r = spawnSync(ffmpegPath, [
          '-v', 'error', '-i', interPath,
          '-c', 'copy', '-movflags', '+faststart',
          '-map', '0:v',
          '-y', outputPath
        ], { encoding: 'utf8', timeout: 600000, stdio: ['pipe', 'pipe', 'pipe'] });

        if (r.status === 0 && fs.existsSync(outputPath)) {
          const v = ffprobeBin ? spawnSync(ffprobeBin, ['-v', 'error',
            '-show_entries', 'stream=codec_name,codec_type,nb_read_frames,duration',
            '-show_entries', 'format=duration',
            '-of', 'json', outputPath],
            { encoding: 'utf8', timeout: 600000 }) : null;
          const info = v && v.status === 0 ? JSON.parse(v.stdout) : null;

          if (info && info.streams) {
            try { fs.unlinkSync(interPath); } catch {}
            const outSize = fs.statSync(outputPath).size;
            log(`  Output: ${fixedName} (${(outSize / 1024 / 1024).toFixed(1)} MB)`);
            if (info.format && info.format.duration) {
              const d = parseFloat(info.format.duration);
              log(`  Duration: ${Math.floor(d / 60)}m ${Math.floor(d % 60)}s`);
            }
            for (const s of info.streams) {
              log(`  Track: ${s.codec_type} - ${s.codec_name}`);
            }
            warn(`  Video only (no audio). Audio recovery needs untrunc plus a reference file.`);
            return { status: 'fixed', outputPath, method: 'moov-build+remux' };
          }
        }
      } catch (e) {
        warn(`  ffmpeg re-mux error: ${e.message}`);
      }
    }

    // Fallback: keep the intermediate file as the output
    if (fs.existsSync(interPath)) {
      try { fs.copyFileSync(interPath, outputPath); fs.unlinkSync(interPath); } catch {}
    }
    verifyAndLog(outputPath);
    return { status: 'fixed', outputPath, method: 'moov-build' };

  } finally {
    fs.closeSync(fd);
  }
}

// --- Main ---
async function main() {
  const args = process.argv.slice(2);
  const inputs = [];            // directories and/or MP4 files, in any mix
  let outputDir = null;
  let referencePath = null;
  let outputMode = null;
  let allowDownload = true;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--input' || args[i] === '-i') inputs.push(args[++i]);
    else if (args[i] === '--output' || args[i] === '-o') outputDir = args[++i];
    else if (args[i] === '--reference' || args[i] === '-r') referencePath = args[++i];
    else if (args[i] === '--inplace') outputMode = 'inplace';
    else if (args[i] === '--copy') outputMode = 'copy';
    else if (args[i] === '--no-download') allowDownload = false;
    else if (args[i] === '--help' || args[i] === '-h') {
      console.log(`
Usage: node fix-vods.js [options] [path ...]

Each path is a directory (every MP4 inside is checked) or a single MP4 file;
mix them freely. With no path, the current directory is used.

Options:
  -i, --input <path>      Directory or MP4 file to process; may be repeated
  -o, --output <dir>      Output directory for fixed files (default: next to each file)
  -r, --reference <file>  Intact MP4 used by untrunc as a template for audio+video
                          recovery. Must be from the same source and in the same
                          format: same video codec, same audio codec, same output
                          format. A different clip of any length is fine. If
                          omitted, a valid MP4 among the inputs or next to the
                          broken files is used; failing that, the script asks.
      --copy              Save fixed files as new copies (*_fixed.mp4)
      --inplace           Replace originals after a successful repair (DANGEROUS)
      --no-download       Never download ffmpeg or untrunc; use only what is installed
  -h, --help              Show this help

Repairs MP4 files whose moov atom is missing (interrupted recordings).
With untrunc and a reference file it recovers video and audio. Without
them it rebuilds the moov from the H.264 stream, which recovers video
only. On Windows, ffmpeg and untrunc are downloaded from GitHub when they
are missing; the script asks first (see --no-download).
`);
      process.exit(0);
    } else if (args[i].startsWith('-')) {
      console.error(`Unknown option: ${args[i]} (see --help)`);
      process.exit(1);
    } else inputs.push(args[i]);
  }
  if (inputs.includes(undefined)) { console.error('Missing path after -i'); process.exit(1); }
  if (inputs.length === 0) inputs.push(process.cwd());

  // Expand the inputs into a list of candidate files. Directory scans skip earlier
  // outputs. Files named explicitly are taken as they are.
  const isMp4Name = f => /\.mp4$/i.test(f) && !/_fixed|_fixtmp/i.test(f);
  const allFiles = [];
  const seen = new Set();
  const explicitFiles = new Set();
  const addFile = f => {
    const abs = path.resolve(f);
    const key = abs.toLowerCase();
    if (seen.has(key)) return null;
    seen.add(key);
    allFiles.push(abs);
    return key;
  };
  for (const inp of inputs) {
    if (!fs.existsSync(inp)) { console.error(`Not found: ${inp}`); process.exit(1); }
    if (fs.statSync(inp).isDirectory()) {
      for (const f of fs.readdirSync(inp)) if (isMp4Name(f)) addFile(path.join(inp, f));
    } else {
      const key = addFile(inp);
      if (key) explicitFiles.add(key);
    }
  }

  const scriptDir = path.dirname(require.main ? require.main.filename : __filename);

  // ffmpeg/ffprobe: PATH, then ./ffmpeg/ next to the script, then (Windows) download
  const ffmpegDir = path.join(scriptDir, 'ffmpeg');
  let ffmpegPath = findTool('ffmpeg') || findExeIn(ffmpegDir, /^ffmpeg(\.exe)?$/i);
  let ffprobePath = findTool('ffprobe') || findExeIn(ffmpegDir, /^ffprobe(\.exe)?$/i);
  if ((!ffmpegPath || !ffprobePath) && process.platform === 'win32' && allowDownload) {
    const ans = await askQuestion('  ffmpeg not found. Download it from GitHub (BtbN/FFmpeg-Builds, about 65 MB)? [Y/n]: ');
    if (ans === '' || ans.toLowerCase().startsWith('y')) {
      try { ({ ffmpeg: ffmpegPath, ffprobe: ffprobePath } = await downloadFfmpeg(ffmpegDir)); }
      catch (e) { warn(`ffmpeg download failed: ${e.message}`); }
    }
  }
  if (!ffmpegPath) warn('ffmpeg not found; output may have moov issues');
  if (!ffprobePath) warn('ffprobe not found: files cannot be verified, so anything with a moov atom is assumed to be fine');
  ffprobeBin = ffprobePath;

  const brokenFiles = [];
  const validFiles = [];
  for (const f of allFiles) {
    let check;
    try { check = isBrokenMp4(f); }
    catch (e) { warn(`Cannot read ${path.basename(f)}: ${e.message}`); continue; }
    if (check.broken) brokenFiles.push(f);
    else if (check.reason === 'valid') validFiles.push(f);
    else if (explicitFiles.has(f.toLowerCase())) log(`Not an MP4, skipping: ${path.basename(f)}`);
  }

  if (brokenFiles.length === 0) { log(`No broken MP4 files found in: ${inputs.join(', ')}`); process.exit(0); }

  console.log('');
  log(`Found ${brokenFiles.length} broken MP4 file(s):`);
  for (const f of brokenFiles) {
    console.log(`  - ${path.basename(f)} (${(fs.statSync(f).size / 1024 / 1024).toFixed(1)} MB)`);
  }
  log(`Skipping ${allFiles.length - brokenFiles.length} already-valid or non-MP4 file(s)`);

  // Reference file: --reference flag, else the first valid MP4 among the inputs,
  // else a valid MP4 sitting next to the broken files (the usual case when only
  // broken files were dropped on the launcher).
  if (referencePath && !fs.existsSync(referencePath)) {
    warn(`Reference file not found: ${referencePath}`);
    referencePath = null;
  }
  if (!referencePath && validFiles.length > 0) {
    referencePath = validFiles[0];
    log(`Auto-selected reference: ${path.basename(referencePath)} (override with -r)`);
  }
  if (!referencePath) {
    for (const dir of [...new Set(brokenFiles.map(f => path.dirname(f)))]) {
      const cand = fs.readdirSync(dir).filter(isMp4Name).map(f => path.join(dir, f))
        .filter(f => !seen.has(path.resolve(f).toLowerCase()))
        .find(f => { try { return isBrokenMp4(f).reason === 'valid'; } catch { return false; } });
      if (cand) {
        referencePath = cand;
        log(`Auto-selected reference: ${path.basename(cand)} (found next to the broken files; override with -r)`);
        break;
      }
    }
  }

  // untrunc: ./untrunc/ next to the script, then the script dir, then PATH, then download
  const untruncDir = path.join(scriptDir, 'untrunc');
  let untruncPath = findUntruncExe(untruncDir);
  if (!untruncPath) {
    for (const c of [path.join(scriptDir, 'untrunc.exe'), path.join(scriptDir, 'untrunc')]) {
      if (fs.existsSync(c) && fs.statSync(c).isFile()) { untruncPath = c; break; }
    }
  }
  if (!untruncPath) untruncPath = findTool('untrunc');

  if (!untruncPath) {
    if (process.platform === 'win32' && allowDownload) {
      const ans = await askQuestion('  untrunc not found. Download it from GitHub (anthwlock/untrunc, about 13 MB)? [Y/n]: ');
      if (ans === '' || ans.toLowerCase().startsWith('y')) {
        try { untruncPath = await downloadUntrunc(untruncDir); }
        catch (e) { warn(`untrunc download failed: ${e.message}`); }
      }
    } else {
      warn('untrunc not found. Install it (or build it from https://github.com/anthwlock/untrunc) for audio recovery.');
    }
  }

  if (!untruncPath) warn('untrunc unavailable; only the video track can be recovered');

  if (!referencePath && untruncPath) {
    const dirs = [...new Set(brokenFiles.map(f => path.dirname(f)))];
    console.log('');
    console.log('  No working recording was found next to the broken files.');
    console.log('');
    console.log('  To recover audio, untrunc needs one intact MP4 to use as a template. It has');
    console.log('  to come from the same source and be in the same format: the same video codec,');
    console.log('  the same audio codec, and the same output format. It does not have to be the');
    console.log('  same recording: a different clip of any length is fine, as long as it came');
    console.log('  from the same setup.');
    console.log('');
    console.log('  Give its path below, or copy such a file next to the broken ones and run');
    console.log('  this again. Any name ending in .mp4 is picked up automatically, so');
    console.log(dirs.length > 1 ? '  saving it in any of these folders works:' : '  saving it here works:');
    for (const d of dirs.slice(0, 3)) console.log('    ' + path.join(d, 'reference.mp4'));
    if (dirs.length > 3) console.log(`    ...and ${dirs.length - 3} more folder(s)`);
    console.log('  (names ending in _fixed.mp4 are skipped; those are this tool\'s output)');
    console.log('');
    console.log('  Without one, only the video track can be restored.');
    const ans = (await askQuestion('  Path to a working MP4, or press Enter to skip and only recover video: ')).replace(/^"|"$/g, '');
    if (ans) {
      if (!fs.existsSync(ans) || !fs.statSync(ans).isFile()) warn(`Not found: ${ans}`);
      else {
        let ok = false;
        try { ok = isBrokenMp4(ans).reason === 'valid'; } catch {}
        if (ok) { referencePath = path.resolve(ans); log(`Using reference: ${path.basename(referencePath)}`); }
        else warn(`Not a working MP4, ignoring it: ${path.basename(ans)}`);
      }
    }
    console.log('');
  }
  if (!referencePath) warn('No working reference file; untrunc audio recovery unavailable');

  const refFps = referencePath ? getRefFps(referencePath) : null;

  if (!outputMode) outputMode = await promptOutputMode();
  closeQuestions();   // no more prompts from here on
  if (outputMode === 'inplace') outputDir = null;   // temp files go next to each original
  if (outputDir && !fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  log(`Mode: ${outputMode === 'copy' ? 'new copies (*_fixed.mp4)' : 'IN-PLACE REPLACE'}`);
  log(`ffmpeg: ${ffmpegPath || 'not found'}`);
  log(`untrunc: ${untruncPath || 'not found'}`);
  log(`Reference: ${referencePath ? path.basename(referencePath) : 'none'}`);
  log(`Output: ${outputDir || 'next to each file'}`);
  console.log('');

  const opts = { inplace: outputMode === 'inplace', refFps };
  const results = { fixed: 0, skipped: 0, failed: 0 };
  for (const file of brokenFiles) {
    log(`Processing: ${path.basename(file)}`);
    const r = fixFile(file, outputDir || path.dirname(file), ffmpegPath, referencePath, untruncPath, opts);
    console.log('');
    if (r.status === 'fixed') results.fixed++;
    else if (r.status === 'skipped') results.skipped++;
    else { results.failed++; warn(`  Failed: ${r.reason || 'unknown'}`); }
  }
  log(`Done: ${results.fixed} fixed, ${results.skipped} skipped, ${results.failed} failed`);
}

if (require.main === module) {
  main().catch(e => { console.error(e); process.exit(1); });
}

module.exports = { parseSPS, downloadUntrunc, downloadFfmpeg, buildVideoMoov };
