'use strict';

/* ==========================================================
   OPTICAL_QR_TRANSFER
   프레임 포맷: QRS1|SID|IDX|TOTAL|CRC32|BASE64_DATA
     - SID   : 4자리 세션 식별자 (전송 시작마다 새로 생성)
     - IDX   : 프레임 번호 (0 = 메타데이터, 1..N = 데이터 청크)
     - TOTAL : 전체 프레임 수 (메타데이터 포함)
     - CRC32 : 이 프레임 payload의 CRC32 (위조/손상 프레임 즉시 폐기용)
     - DATA  : payload의 Base64 인코딩

   정확도 확보 전략
     1. 프레임 단위 CRC32 검증 → 오인식된 프레임은 즉시 폐기 (재조립에 섞이지 않음)
     2. 파일 전체 CRC32 재검증 → 재조립 후 최종 무결성 확인
     3. QR을 표준 흑백(검정 모듈 / 흰 배경)으로 렌더링 → 인식 신뢰도 최우선
     4. 세션 ID로 서로 다른 전송을 격리 → 세션 간 프레임 혼입 방지
     5. 전송측은 전체 프레임을 무한 반복 → 놓친 프레임은 다음 루프에서 재수신
   ========================================================== */

const FRAME_RE = /^QRS1\|([A-Z0-9]{4})\|(\d+)\|(\d+)\|(\d+)\|([A-Za-z0-9+/=]*)$/;

/* ---------------------------------------------------------- */
/* CRC32                                                        */
/* ---------------------------------------------------------- */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

/* ---------------------------------------------------------- */
/* base64 <-> Uint8Array                                        */
/* ---------------------------------------------------------- */

function bytesToBase64(bytes) {
  let binary = '';
  const chunkSz = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSz) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSz));
  }
  return btoa(binary);
}

function base64ToBytes(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/* ---------------------------------------------------------- */
/* misc helpers                                                 */
/* ---------------------------------------------------------- */

function formatBytes(n) {
  if (!isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatTime(sec) {
  sec = Math.max(0, Math.floor(sec));
  const m = String(Math.floor(sec / 60)).padStart(2, '0');
  const s = String(sec % 60).padStart(2, '0');
  return `${m}:${s}`;
}

function makeLogger(el) {
  return function log(msg, cls) {
    const line = document.createElement('div');
    if (cls) line.className = cls;
    const t = new Date().toLocaleTimeString('ko-KR', { hour12: false });
    line.textContent = `[${t}] ${msg}`;
    el.appendChild(line);
    while (el.children.length > 80) el.removeChild(el.firstChild);
    el.scrollTop = el.scrollHeight;
  };
}

function randomSid() {
  return Math.random().toString(36).slice(2, 6).toUpperCase().padEnd(4, '0');
}

/* ==========================================================
   TAB SWITCHING
   ========================================================== */

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`panel-${btn.dataset.tab}`).classList.add('active');
  });
});

/* ==========================================================
   SEND
   ========================================================== */

(function initSender() {
  const dropZone      = document.getElementById('dropZone');
  const fileInput      = document.getElementById('fileInput');
  const dropText       = document.getElementById('dropText');
  const fileInfo       = document.getElementById('fileInfo');
  const fileNameEl     = document.getElementById('fileName');
  const fileSizeEl     = document.getElementById('fileSize');

  const chunkSizeInput = document.getElementById('chunkSize');
  const chunkSizeVal   = document.getElementById('chunkSizeVal');
  const fpsInput       = document.getElementById('fps');
  const fpsVal         = document.getElementById('fpsVal');
  const eccGroup       = document.getElementById('eccGroup');

  const btnStartSend   = document.getElementById('btnStartSend');
  const btnStopSend    = document.getElementById('btnStopSend');

  const qrCanvas       = document.getElementById('qrCanvas');
  const qrIdle         = document.getElementById('qrIdle');
  const qrCtx          = qrCanvas.getContext('2d');

  const sendProgress   = document.getElementById('sendProgress');
  const sendFrameIdxEl = document.getElementById('sendFrameIdx');
  const sendFrameTotalEl = document.getElementById('sendFrameTotal');
  const sendLoopCountEl = document.getElementById('sendLoopCount');
  const sendLogEl      = document.getElementById('sendLog');
  const log            = makeLogger(sendLogEl);

  const exportRepeatsInput = document.getElementById('exportRepeats');
  const exportRepeatsVal   = document.getElementById('exportRepeatsVal');
  const btnExportVideo     = document.getElementById('btnExportVideo');
  const btnStopExport      = document.getElementById('btnStopExport');
  const exportProgress     = document.getElementById('exportProgress');
  const exportStatusLine   = document.getElementById('exportStatusLine');

  let currentFile = null;
  let currentFileBytes = null;
  let currentEcc = 'Q';

  let sendFrames = [];      // 프레임 문자열 배열
  let qrCache = new Map();  // idx -> {count, modules}
  let sendTimer = null;
  let sendIdx = 0;
  let loopCount = 0;

  function setControlsDisabled(disabled) {
    [chunkSizeInput, fpsInput, fileInput, exportRepeatsInput].forEach(el => el.disabled = disabled);
    eccGroup.querySelectorAll('button').forEach(b => b.disabled = disabled);
    dropZone.style.pointerEvents = disabled ? 'none' : '';
  }

  // ---- 파일 선택 ----

  function handleFile(file) {
    if (!file) return;
    currentFile = file;
    const reader = new FileReader();
    reader.onload = () => {
      currentFileBytes = new Uint8Array(reader.result);
      fileNameEl.textContent = file.name;
      fileSizeEl.textContent = formatBytes(file.size);
      fileInfo.classList.remove('hidden');
      dropText.classList.add('hidden');
      btnStartSend.disabled = false;
      btnExportVideo.disabled = false;
      log(`FILE_LOADED: ${file.name} (${formatBytes(file.size)})`, 'ok');
    };
    reader.onerror = () => log('ERROR: 파일 읽기 실패', 'err');
    reader.readAsArrayBuffer(file);
  }

  fileInput.addEventListener('change', e => handleFile(e.target.files[0]));

  ['dragenter', 'dragover'].forEach(ev =>
    dropZone.addEventListener(ev, e => { e.preventDefault(); dropZone.classList.add('drag-over'); })
  );
  ['dragleave', 'drop'].forEach(ev =>
    dropZone.addEventListener(ev, e => { e.preventDefault(); dropZone.classList.remove('drag-over'); })
  );
  dropZone.addEventListener('drop', e => {
    if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
  });

  // ---- 컨트롤 ----

  chunkSizeInput.addEventListener('input', () => { chunkSizeVal.textContent = chunkSizeInput.value; });
  fpsInput.addEventListener('input', () => { fpsVal.textContent = fpsInput.value; });
  exportRepeatsInput.addEventListener('input', () => { exportRepeatsVal.textContent = exportRepeatsInput.value; });

  eccGroup.addEventListener('click', e => {
    const btn = e.target.closest('button[data-ecc]');
    if (!btn) return;
    eccGroup.querySelectorAll('button').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentEcc = btn.dataset.ecc;
    qrCache.clear();
  });

  // ---- 프레임 빌드 ----

  function buildFrames(bytes, fileMeta, chunkSize) {
    const sid = randomSid();
    const totalDataChunks = Math.max(1, Math.ceil(bytes.length / chunkSize));
    const total = totalDataChunks + 1; // +1 메타데이터

    const meta = {
      name: fileMeta.name,
      size: bytes.length,
      mime: fileMeta.type || 'application/octet-stream',
      chunks: totalDataChunks,
      crc: crc32(bytes)
    };
    const metaBytes = new TextEncoder().encode(JSON.stringify(meta));

    const frames = [makeFrame(sid, 0, total, metaBytes)];
    for (let i = 0; i < totalDataChunks; i++) {
      const start = i * chunkSize;
      const part = bytes.subarray(start, Math.min(start + chunkSize, bytes.length));
      frames.push(makeFrame(sid, i + 1, total, part));
    }
    return frames;
  }

  function makeFrame(sid, idx, total, byteChunk) {
    const crc = crc32(byteChunk);
    const b64 = bytesToBase64(byteChunk);
    return `QRS1|${sid}|${idx}|${total}|${crc}|${b64}`;
  }

  // ---- QR 렌더링 (표준 흑백 / 크리스프 픽셀) ----

  function getQRModules(idx) {
    if (qrCache.has(idx)) return qrCache.get(idx);
    const qr = qrcode(0, currentEcc);
    qr.addData(sendFrames[idx]);
    qr.make();
    const count = qr.getModuleCount();
    const modules = new Array(count);
    for (let r = 0; r < count; r++) {
      const row = new Uint8Array(count);
      for (let c = 0; c < count; c++) row[c] = qr.isDark(r, c) ? 1 : 0;
      modules[r] = row;
    }
    const data = { count, modules };
    qrCache.set(idx, data);
    return data;
  }

  function drawQR(idx) {
    const { count, modules } = getQRModules(idx);
    const margin = 4;          // 조용한 영역(quiet zone) — 인식률에 중요
    const cell = 6;            // 모듈당 픽셀 (크리스프 렌더링)
    const totalModules = count + margin * 2;
    const px = totalModules * cell;

    qrCanvas.width = px;
    qrCanvas.height = px;
    qrCtx.fillStyle = '#ffffff';
    qrCtx.fillRect(0, 0, px, px);
    qrCtx.fillStyle = '#000000';
    for (let r = 0; r < count; r++) {
      const row = modules[r];
      for (let c = 0; c < count; c++) {
        if (row[c]) qrCtx.fillRect((c + margin) * cell, (r + margin) * cell, cell, cell);
      }
    }
  }

  // ---- 송신 루프 ----

  function tickSend() {
    drawQR(sendIdx);
    sendFrameIdxEl.textContent = sendIdx + 1;
    sendFrameTotalEl.textContent = sendFrames.length;
    sendProgress.style.width = `${((sendIdx + 1) / sendFrames.length) * 100}%`;

    sendIdx++;
    if (sendIdx >= sendFrames.length) {
      sendIdx = 0;
      loopCount++;
      sendLoopCountEl.textContent = loopCount;
      log(`LOOP ${loopCount} COMPLETE — 처음부터 다시 전송`, 'warn');
    }
  }

  function startSend() {
    if (!currentFile || !currentFileBytes) return;

    const chunkSize = parseInt(chunkSizeInput.value, 10);
    const fps = parseInt(fpsInput.value, 10);

    sendFrames = buildFrames(currentFileBytes, currentFile, chunkSize);
    qrCache.clear();
    sendIdx = 0;
    loopCount = 0;
    sendLoopCountEl.textContent = 0;

    log(`ENCODING_START: ${sendFrames.length} FRAMES / ECC=${currentEcc} / ${chunkSize}B per chunk`, 'ok');

    qrIdle.classList.add('hidden');
    btnStartSend.classList.add('hidden');
    btnStopSend.classList.remove('hidden');
    setControlsDisabled(true);

    clearInterval(sendTimer);
    sendTimer = setInterval(tickSend, 1000 / fps);
    tickSend();
  }

  function stopSend() {
    clearInterval(sendTimer);
    sendTimer = null;
    qrIdle.classList.remove('hidden');
    btnStartSend.classList.remove('hidden');
    btnStopSend.classList.add('hidden');
    setControlsDisabled(false);
    log('TRANSMISSION_STOPPED', 'warn');
  }

  // ---- 영상 내보내기 (QR 스트림 → webm) ----
  //
  // 캔버스 크기가 프레임마다(메타데이터/마지막 청크 등) 다를 수 있어
  // 라이브 전송용 drawQR을 그대로 쓰면 영상 해상도가 도중에 바뀌어 버린다.
  // 그래서 내보내기 전체 프레임 중 최대 모듈 수를 먼저 계산해 캔버스 크기를
  // 고정하고, 작은 프레임은 중앙에 정렬해서 그린다 — 항상 동일 해상도 유지.

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  let exportCancelled = false;

  async function exportVideo() {
    if (!currentFile || !currentFileBytes) return;

    if (!qrCanvas.captureStream || !window.MediaRecorder) {
      log('ERROR: 이 브라우저는 영상 내보내기(MediaRecorder)를 지원하지 않습니다', 'err');
      return;
    }

    if (sendTimer) stopSend(); // 실시간 전송 중이면 먼저 중지

    const chunkSize = parseInt(chunkSizeInput.value, 10);
    const fps = parseInt(fpsInput.value, 10);
    const repeats = parseInt(exportRepeatsInput.value, 10);

    const exportFrames = buildFrames(currentFileBytes, currentFile, chunkSize);
    const savedFrames = sendFrames;
    const savedCache = qrCache;
    sendFrames = exportFrames;
    qrCache = new Map();

    // 최대 모듈 수 계산 → 고정 해상도 결정
    let maxCount = 0;
    for (let i = 0; i < exportFrames.length; i++) {
      const { count } = getQRModules(i);
      if (count > maxCount) maxCount = count;
    }
    const margin = 4;
    const cell = 6;
    const fixedTotalModules = maxCount + margin * 2;
    const fixedPx = fixedTotalModules * cell;
    qrCanvas.width = fixedPx;
    qrCanvas.height = fixedPx;

    function drawFixed(idx) {
      const { count, modules } = getQRModules(idx);
      qrCtx.fillStyle = '#ffffff';
      qrCtx.fillRect(0, 0, fixedPx, fixedPx);
      qrCtx.fillStyle = '#000000';
      const off = Math.floor((fixedTotalModules - (count + margin * 2)) / 2);
      for (let r = 0; r < count; r++) {
        const row = modules[r];
        for (let c = 0; c < count; c++) {
          if (row[c]) qrCtx.fillRect((c + margin + off) * cell, (r + margin + off) * cell, cell, cell);
        }
      }
    }

    exportCancelled = false;
    qrIdle.classList.add('hidden');
    setControlsDisabled(true);
    btnStartSend.disabled = true;
    btnExportVideo.classList.add('hidden');
    btnStopExport.classList.remove('hidden');
    exportStatusLine.textContent = 'RECORDING...';
    log(`VIDEO_EXPORT_START: ${exportFrames.length} FRAMES x${repeats} LOOPS / ${fixedPx}x${fixedPx}px`, 'ok');

    const stream = qrCanvas.captureStream(0); // 수동 프레임 모드
    const track = stream.getVideoTracks()[0];
    const manualFrames = typeof track.requestFrame === 'function';

    let mimeType = 'video/webm;codecs=vp9';
    if (!MediaRecorder.isTypeSupported(mimeType)) mimeType = 'video/webm;codecs=vp8';
    if (!MediaRecorder.isTypeSupported(mimeType)) mimeType = 'video/webm';

    const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 8000000 });
    const recordedChunks = [];
    recorder.ondataavailable = e => { if (e.data && e.data.size > 0) recordedChunks.push(e.data); };
    const stopped = new Promise(resolve => { recorder.onstop = resolve; });
    recorder.start();

    const totalTicks = exportFrames.length * repeats;
    const frameDelay = 1000 / fps;
    let tick = 0;

    outer:
    for (let rep = 0; rep < repeats; rep++) {
      for (let i = 0; i < exportFrames.length; i++) {
        if (exportCancelled) break outer;
        drawFixed(i);
        if (manualFrames) track.requestFrame();
        tick++;
        exportProgress.style.width = `${(tick / totalTicks) * 100}%`;
        await sleep(frameDelay);
      }
    }

    recorder.stop();
    await stopped;

    sendFrames = savedFrames;
    qrCache = savedCache;

    if (!exportCancelled) {
      const blob = new Blob(recordedChunks, { type: 'video/webm' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${currentFile.name}.qrstream.webm`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      log(`VIDEO_EXPORT_DONE: ${exportFrames.length} FRAMES x${repeats} LOOPS`, 'ok');
      exportStatusLine.textContent = 'DONE';
    } else {
      log('VIDEO_EXPORT_CANCELLED', 'warn');
      exportStatusLine.textContent = 'CANCELLED';
    }

    qrIdle.classList.remove('hidden');
    setControlsDisabled(false);
    btnStartSend.disabled = false;
    btnExportVideo.classList.remove('hidden');
    btnStopExport.classList.add('hidden');
    exportProgress.style.width = '0%';
  }

  btnStartSend.addEventListener('click', startSend);
  btnStopSend.addEventListener('click', stopSend);
  btnExportVideo.addEventListener('click', exportVideo);
  btnStopExport.addEventListener('click', () => { exportCancelled = true; });
})();

/* ==========================================================
   RECEIVE
   ========================================================== */

(function initReceiver() {
  const video          = document.getElementById('video');
  const videoIdle       = document.getElementById('videoIdle');
  const btnStartScan    = document.getElementById('btnStartScan');
  const btnStopScan     = document.getElementById('btnStopScan');
  const btnReset        = document.getElementById('btnReset');

  const mRecv           = document.getElementById('mRecv');
  const mCorrupt        = document.getElementById('mCorrupt');
  const mElapsed        = document.getElementById('mElapsed');
  const mSpeed          = document.getElementById('mSpeed');
  const chunkMatrix      = document.getElementById('chunkMatrix');

  const recvResult       = document.getElementById('recvResult');
  const recvFileName     = document.getElementById('recvFileName');
  const recvDownload     = document.getElementById('recvDownload');

  const recvLogEl        = document.getElementById('recvLog');
  const log              = makeLogger(recvLogEl);

  const videoDropZone    = document.getElementById('videoDropZone');
  const videoFileInput   = document.getElementById('videoFileInput');
  const videoDropText    = document.getElementById('videoDropText');
  const videoFileInfo    = document.getElementById('videoFileInfo');
  const videoFileNameEl  = document.getElementById('videoFileName');
  const sampleIntervalInput = document.getElementById('sampleInterval');
  const sampleIntervalVal   = document.getElementById('sampleIntervalVal');
  const btnAnalyzeVideo  = document.getElementById('btnAnalyzeVideo');
  const btnStopAnalyze   = document.getElementById('btnStopAnalyze');
  const analyzeProgress  = document.getElementById('analyzeProgress');
  const analyzeStatusLine = document.getElementById('analyzeStatusLine');

  const scanCanvas = document.createElement('canvas');
  const scanCtx = scanCanvas.getContext('2d', { willReadFrequently: true });

  let stream = null;
  let scanning = false;
  let rafId = null;

  let session = null;      // {sid, total, meta, chunks:Map, corrupt, startTime}
  let matrixCells = [];
  let elapsedTimer = null;

  function newSession() {
    session = { sid: null, total: 0, meta: null, chunks: new Map(), corrupt: 0, startTime: Date.now() };
    matrixCells = [];
    chunkMatrix.innerHTML = '';
    mRecv.textContent = '0/0';
    mCorrupt.textContent = '0';
    mElapsed.textContent = '00:00';
    mSpeed.textContent = '0 B/s';
    recvResult.classList.add('hidden');
    if (recvDownload.href) { URL.revokeObjectURL(recvDownload.href); recvDownload.removeAttribute('href'); }
  }

  function buildMatrix(total) {
    chunkMatrix.innerHTML = '';
    matrixCells = new Array(total);
    for (let i = 0; i < total; i++) {
      const cell = document.createElement('div');
      cell.className = 'matrix-cell';
      chunkMatrix.appendChild(cell);
      matrixCells[i] = cell;
    }
  }

  function markCell(idx) {
    if (matrixCells[idx]) matrixCells[idx].classList.add('received');
  }

  // ---- 카메라 제어 ----

  async function startScan() {
    if (!session) newSession();
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false
      });
    } catch (e) {
      log(`ERROR: 카메라 접근 실패 — ${e.message}`, 'err');
      return;
    }
    video.srcObject = stream;
    await video.play();
    videoIdle.classList.add('hidden');
    scanning = true;
    btnStartScan.classList.add('hidden');
    btnStopScan.classList.remove('hidden');

    if (!elapsedTimer) elapsedTimer = setInterval(updateElapsed, 500);
    log('SCAN_STARTED', 'ok');
    rafId = requestAnimationFrame(scanLoop);
  }

  function stopScan() {
    scanning = false;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null;
    if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
    video.srcObject = null;
    videoIdle.classList.remove('hidden');
    btnStartScan.classList.remove('hidden');
    btnStopScan.classList.add('hidden');
    if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = null; }
  }

  function resetAll() {
    stopScan();
    if (analyzing) cancelAnalyze = true;
    newSession();
    log('SESSION_RESET', 'warn');
  }

  // ---- 스캔 루프 ----

  function scanLoop() {
    if (!scanning) return;
    if (video.readyState === video.HAVE_ENOUGH_DATA && video.videoWidth) {
      scanCanvas.width = video.videoWidth;
      scanCanvas.height = video.videoHeight;
      scanCtx.drawImage(video, 0, 0, scanCanvas.width, scanCanvas.height);
      const imageData = scanCtx.getImageData(0, 0, scanCanvas.width, scanCanvas.height);
      // 송신측이 항상 표준 흑백(비반전)으로 렌더링하므로 dontInvert로 고정 —
      // 불필요한 반전 시도를 생략해 프레임당 연산을 줄이고 스캔 주기를 안정화한다.
      const code = jsQR(imageData.data, imageData.width, imageData.height, { inversionAttempts: 'dontInvert' });
      if (code && code.data) handleFrame(code.data);
    }
    rafId = requestAnimationFrame(scanLoop);
  }

  // ---- 프레임 처리 ----

  function handleFrame(text) {
    const m = FRAME_RE.exec(text);
    if (!m) return; // 우리 프로토콜이 아님 — 조용히 무시

    const [, sid, idxStr, totalStr, crcStr, b64] = m;
    const idx = parseInt(idxStr, 10);
    const total = parseInt(totalStr, 10);
    const expectedCrc = parseInt(crcStr, 10) >>> 0;

    if (!session) newSession();

    if (session.sid && session.sid !== sid) return; // 다른 세션의 프레임 — 무시 (RESET 필요)
    if (!session.sid) {
      session.sid = sid;
      session.total = total;
      buildMatrix(total);
      log(`SESSION_LOCKED: SID=${sid} TOTAL_FRAMES=${total}`, 'ok');
    }
    if (session.chunks.has(idx)) return; // 이미 수신함 (송신측 반복 루프로 인한 중복)

    let bytes;
    try {
      bytes = base64ToBytes(b64);
    } catch (e) {
      session.corrupt++;
      updateMetrics();
      return;
    }

    const actualCrc = crc32(bytes);
    if (actualCrc !== expectedCrc) {
      session.corrupt++;
      updateMetrics();
      log(`FRAME_${idx} CRC_MISMATCH — 폐기`, 'err');
      return;
    }

    session.chunks.set(idx, bytes);
    markCell(idx);

    if (idx === 0) {
      try {
        session.meta = JSON.parse(new TextDecoder().decode(bytes));
      } catch (e) {
        log('METADATA_PARSE_ERROR', 'err');
      }
    }

    updateMetrics();
    log(`FRAME_${idx}/${total - 1} OK`, 'ok');

    checkComplete();
  }

  function checkComplete() {
    if (!session.meta) return;
    const need = session.meta.chunks;
    for (let i = 1; i <= need; i++) {
      if (!session.chunks.has(i)) return;
    }

    const parts = [];
    for (let i = 1; i <= need; i++) parts.push(session.chunks.get(i));
    const totalLen = parts.reduce((s, p) => s + p.length, 0);
    const full = new Uint8Array(totalLen);
    let offset = 0;
    for (const p of parts) { full.set(p, offset); offset += p.length; }

    if (crc32(full) !== session.meta.crc) {
      log('FILE_CRC_MISMATCH — 재조립 실패, 계속 대기 중', 'err');
      return;
    }

    const blob = new Blob([full], { type: session.meta.mime || 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    recvDownload.href = url;
    recvDownload.download = session.meta.name || 'received_file';
    recvFileName.textContent = `${session.meta.name} (${formatBytes(session.meta.size)})`;
    recvResult.classList.remove('hidden');
    log(`TRANSFER_COMPLETE: ${session.meta.name}`, 'ok');
    stopScan();
  }

  function updateMetrics() {
    const total = session.meta ? session.meta.chunks : (session.total ? session.total - 1 : 0);
    const received = session.chunks.size - (session.chunks.has(0) ? 1 : 0);
    mRecv.textContent = `${received}/${total || '?'}`;
    mCorrupt.textContent = session.corrupt;

    let bytesReceived = 0;
    session.chunks.forEach((v, k) => { if (k !== 0) bytesReceived += v.length; });
    const elapsedSec = (Date.now() - session.startTime) / 1000;
    const speed = elapsedSec > 0 ? bytesReceived / elapsedSec : 0;
    mSpeed.textContent = `${formatBytes(speed)}/s`;
  }

  function updateElapsed() {
    if (!session) return;
    mElapsed.textContent = formatTime((Date.now() - session.startTime) / 1000);
  }

  // ---- 영상 업로드 분석 ----
  //
  // 실시간 카메라 스캔과 달리 재생 속도에 의존하지 않고, video.currentTime을
  // 일정 간격으로 정밀하게 이동(seek)시키며 프레임을 하나씩 캡처해 분석한다.
  // 재생 기반 방식은 디코딩 속도에 따라 프레임을 건너뛸 수 있지만, seek 기반은
  // 설정한 간격의 프레임을 놓치지 않고 전부 검사하므로 인식 정확도가 더 높다.

  let pendingVideoFile = null;
  let analyzing = false;
  let cancelAnalyze = false;

  videoFileInput.addEventListener('change', e => {
    const f = e.target.files[0];
    if (!f) return;
    pendingVideoFile = f;
    videoFileNameEl.textContent = f.name;
    videoFileInfo.classList.remove('hidden');
    videoDropText.classList.add('hidden');
    btnAnalyzeVideo.disabled = false;
    log(`VIDEO_FILE_LOADED: ${f.name}`, 'ok');
  });

  ['dragenter', 'dragover'].forEach(ev =>
    videoDropZone.addEventListener(ev, e => { e.preventDefault(); videoDropZone.classList.add('drag-over'); })
  );
  ['dragleave', 'drop'].forEach(ev =>
    videoDropZone.addEventListener(ev, e => { e.preventDefault(); videoDropZone.classList.remove('drag-over'); })
  );
  videoDropZone.addEventListener('drop', e => {
    if (e.dataTransfer.files[0]) {
      videoFileInput.files = e.dataTransfer.files;
      videoFileInput.dispatchEvent(new Event('change'));
    }
  });

  sampleIntervalInput.addEventListener('input', () => { sampleIntervalVal.textContent = sampleIntervalInput.value; });

  function seekTo(vid, time) {
    return new Promise(resolve => {
      function onSeeked() { vid.removeEventListener('seeked', onSeeked); resolve(); }
      vid.addEventListener('seeked', onSeeked);
      vid.currentTime = Math.min(time, vid.duration || time);
    });
  }

  async function analyzeVideo() {
    if (!pendingVideoFile || analyzing) return;
    if (scanning) stopScan(); // 라이브 스캔 중이면 먼저 중지
    if (!session) newSession();

    analyzing = true;
    cancelAnalyze = false;
    btnAnalyzeVideo.classList.add('hidden');
    btnStopAnalyze.classList.remove('hidden');
    analyzeStatusLine.textContent = 'ANALYZING...';
    log(`VIDEO_ANALYSIS_START: ${pendingVideoFile.name}`, 'ok');

    const vid = document.createElement('video');
    vid.muted = true;
    vid.playsInline = true;
    const url = URL.createObjectURL(pendingVideoFile);
    vid.src = url;

    try {
      await new Promise((resolve, reject) => {
        vid.addEventListener('loadedmetadata', resolve, { once: true });
        vid.addEventListener('error', () => reject(new Error('비디오를 열 수 없습니다')), { once: true });
      });
    } catch (err) {
      log(`ERROR: ${err.message}`, 'err');
      URL.revokeObjectURL(url);
      analyzing = false;
      btnAnalyzeVideo.classList.remove('hidden');
      btnStopAnalyze.classList.add('hidden');
      analyzeStatusLine.textContent = 'ERROR';
      return;
    }

    const canvas = document.createElement('canvas');
    canvas.width = vid.videoWidth;
    canvas.height = vid.videoHeight;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    const step = parseInt(sampleIntervalInput.value, 10) / 1000;
    const duration = vid.duration || 0;
    let t = 0;
    let sampled = 0;

    while (t <= duration + 1e-6) {
      if (cancelAnalyze) break;
      await seekTo(vid, t);
      ctx.drawImage(vid, 0, 0, canvas.width, canvas.height);
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      // 외부에서 만들어진 영상일 수도 있으므로 반전 색상까지 함께 시도한다
      // (실시간 카메라 스캔과 달리 성능보다 정확도를 우선한다)
      const code = jsQR(imageData.data, imageData.width, imageData.height, { inversionAttempts: 'attemptBoth' });
      if (code && code.data) handleFrame(code.data);
      sampled++;
      analyzeProgress.style.width = `${Math.min(100, (t / (duration || 1)) * 100)}%`;
      t += step;
    }

    URL.revokeObjectURL(url);
    analyzing = false;
    btnAnalyzeVideo.classList.remove('hidden');
    btnStopAnalyze.classList.add('hidden');
    analyzeProgress.style.width = '0%';

    if (cancelAnalyze) {
      log(`VIDEO_ANALYSIS_CANCELLED (${sampled} FRAMES_SAMPLED)`, 'warn');
      analyzeStatusLine.textContent = 'CANCELLED';
    } else {
      log(`VIDEO_ANALYSIS_DONE: ${sampled} FRAMES_SAMPLED`, 'ok');
      analyzeStatusLine.textContent = 'DONE';
    }
  }

  btnAnalyzeVideo.addEventListener('click', analyzeVideo);
  btnStopAnalyze.addEventListener('click', () => { cancelAnalyze = true; });

  btnStartScan.addEventListener('click', startScan);
  btnStopScan.addEventListener('click', stopScan);
  btnReset.addEventListener('click', resetAll);

  newSession();
})();
