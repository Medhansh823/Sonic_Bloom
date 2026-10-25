const audio = document.querySelector('#audio');
const fileInput = document.querySelector('#audio-file');
const playButton = document.querySelector('#play-button');
const playIcon = document.querySelector('#play-icon');
const canvas = document.querySelector('#visualizer');
const ctx = canvas.getContext('2d');
const canvasWrap = document.querySelector('.canvas-wrap');
const fullscreenButton = document.querySelector('#fullscreen-button');
const hint = document.querySelector('#canvas-hint');
const trackTitle = document.querySelector('#track-title');
const playerTrackName = document.querySelector('#player-track-name');
const playerSubtitle = document.querySelector('#player-subtitle');
const statusChip = document.querySelector('#status-chip');
const progressFill = document.querySelector('#progress-fill');
const currentTimeLabel = document.querySelector('#current-time');
const durationLabel = document.querySelector('#duration');
const sensitivityInput = document.querySelector('#sensitivity');
const glowInput = document.querySelector('#glow');
const sensitivityValue = document.querySelector('#sensitivity-value');
const glowValue = document.querySelector('#glow-value');
const modeButtons = [...document.querySelectorAll('.mode-switch .mode-button')];
const resetButton = document.querySelector('#reset-button');
const micButton = document.querySelector('#mic-button');
const micStatus = document.querySelector('#mic-status');
const extensionCapture = document.querySelector('#extension-capture');
const captureTabButton = document.querySelector('#capture-tab-button');
const captureDesktopButton = document.querySelector('#capture-desktop-button');
const stopCaptureButton = document.querySelector('#stop-capture-button');
const captureHelp = document.querySelector('#capture-help');

let audioContext = null;
let analyser = null;
let sourceNode = null;
let micSourceNode = null;
let micStream = null;
let externalSourceNode = null;
let externalStream = null;
let externalActive = false;
let frequencyData = null;
let waveformData = null;
let currentMode = 'bars';
let sensitivity = 0.65;
let glow = 0.70;
let objectUrl = null;
let animationFrame = 0;
let lastBass = 0;
let particles = [];
let micActive = false;
const extensionApi = typeof chrome !== 'undefined' && chrome.runtime && chrome.tabCapture;
const captureTabIdParam = new URLSearchParams(window.location.search).get('captureTabId');
const captureTabId = captureTabIdParam === null ? null : Number(captureTabIdParam);
const PARTICLE_COUNT = 150;
const palette = ['#b69aff', '#e78cfa', '#fb83c7', '#8be7ef'];

function formatTime(seconds) {
  if (!Number.isFinite(seconds)) return '0:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60).toString().padStart(2, '0');
  return `${mins}:${secs}`;
}

function resizeCanvas() {
  const rect = canvas.getBoundingClientRect();
  const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.max(1, Math.floor(rect.width * pixelRatio));
  canvas.height = Math.max(1, Math.floor(rect.height * pixelRatio));
  ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
}

function updateFullscreenButton() {
  const isFullscreen = document.fullscreenElement === canvasWrap;
  fullscreenButton.textContent = isFullscreen ? '×' : '⛶';
  fullscreenButton.setAttribute('aria-label', isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen');
  fullscreenButton.title = isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen';
}

fullscreenButton.addEventListener('click', async () => {
  try {
    if (document.fullscreenElement === canvasWrap) {
      await document.exitFullscreen();
    } else if (!document.fullscreenElement) {
      await canvasWrap.requestFullscreen();
    }
  } catch (error) {
    console.error('Could not change visualizer fullscreen mode:', error);
    playerSubtitle.textContent = 'Fullscreen is unavailable in this browser or window.';
  }
});

document.addEventListener('fullscreenchange', () => {
  updateFullscreenButton();
  resizeCanvas();
  if (audio.paused && !micActive && !externalActive) drawIdleState();
});

function prepareAudioGraph() {
  if (audioContext) return true;
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) {
    statusChip.textContent = 'UNSUPPORTED';
    playerSubtitle.textContent = 'Try a recent version of Chrome, Edge, or Firefox.';
    return false;
  }

  try {
    audioContext = new AudioContextClass();
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.82;
    sourceNode = audioContext.createMediaElementSource(audio);
    sourceNode.connect(analyser);
    sourceNode.connect(audioContext.destination);
    frequencyData = new Uint8Array(analyser.frequencyBinCount);
    waveformData = new Uint8Array(analyser.fftSize);
    return true;
  } catch (error) {
    console.error('Could not initialize audio visualization:', error);
    statusChip.textContent = 'AUDIO ERROR';
    playerSubtitle.textContent = 'Audio visualization could not be initialized.';
    return false;
  }
}

function updateCaptureControls(active, message) {
  externalActive = active;
  if (extensionCapture.hidden) return;
  captureTabButton.hidden = active;
  captureDesktopButton.hidden = active;
  stopCaptureButton.hidden = !active;
  captureHelp.textContent = message;
}

function stopExternalCapture(message = 'Audio capture stopped.') {
  if (externalSourceNode) {
    externalSourceNode.disconnect();
    externalSourceNode = null;
  }
  if (externalStream) {
    externalStream.getTracks().forEach(track => track.stop());
    externalStream = null;
  }
  externalActive = false;
  updateCaptureControls(false, message);
  playButton.disabled = !audio.src;
  if (audio.paused && !micActive) {
    statusChip.textContent = audio.src ? 'PAUSED' : 'READY';
    if (!audio.src) hint.classList.remove('hidden');
    drawIdleState();
  }
}

async function startExternalCapture(stream, label, monitorAudio) {
  if (!prepareAudioGraph()) {
    stream.getTracks().forEach(track => track.stop());
    return;
  }
  stopMic();
  stopExternalCapture('Switching audio source…');
  audio.pause();
  try {
    if (audioContext.state === 'suspended') await audioContext.resume();
    externalStream = stream;
    externalSourceNode = audioContext.createMediaStreamSource(stream);
    externalSourceNode.connect(analyser);
    if (monitorAudio) externalSourceNode.connect(audioContext.destination);
    stream.getTracks().forEach(track => {
      track.addEventListener('ended', () => {
        if (externalStream === stream) stopExternalCapture('The shared audio source ended.');
      }, { once: true });
    });
    updateCaptureControls(true, monitorAudio
      ? 'Capturing this tab. Its audio is routed through SonicBloom so you can continue hearing it.'
      : 'Capturing shared screen audio locally. Audio is not played back through SonicBloom.');
    trackTitle.textContent = label;
    playerTrackName.textContent = label;
    playerSubtitle.textContent = 'Audio is analyzed locally and is not recorded or uploaded.';
    statusChip.textContent = 'CAPTURING';
    playButton.disabled = true;
    hint.classList.add('hidden');
    startAnimation();
  } catch (error) {
    console.error('Could not start audio capture:', error);
    stopExternalCapture('Could not start capture. Try again and check browser permissions.');
    statusChip.textContent = 'CAPTURE ERROR';
  }
}

async function captureActiveTab() {
  if (!extensionApi || !Number.isInteger(captureTabId) || captureTabId < 0) {
    captureHelp.textContent = 'Open SonicBloom by clicking the extension while the tab you want to capture is active.';
    return;
  }
  captureTabButton.disabled = true;
  captureHelp.textContent = 'Requesting audio access for the selected tab…';
  try {
    const streamId = await new Promise((resolve, reject) => {
      chrome.tabCapture.getMediaStreamId({ targetTabId: captureTabId }, id => {
        const error = chrome.runtime.lastError;
        if (error) reject(new Error(error.message));
        else if (!id) reject(new Error('The browser did not provide a tab audio stream.'));
        else resolve(id);
      });
    });
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId
        }
      },
      video: false
    });
    await startExternalCapture(stream, 'Browser tab audio', true);
  } catch (error) {
    console.error('Could not capture browser tab audio:', error);
    captureHelp.textContent = error.message || 'Could not capture this tab. Try clicking the extension from the tab you want to hear.';
    statusChip.textContent = 'CAPTURE ERROR';
  } finally {
    captureTabButton.disabled = false;
  }
}

async function captureDesktopAudio() {
  captureDesktopButton.disabled = true;
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      audio: true,
      video: true
    });
    const audioTracks = stream.getAudioTracks();
    if (!audioTracks.length) {
      stream.getTracks().forEach(track => track.stop());
      throw new Error('No shared audio was available. Choose a source with system audio enabled.');
    }
    await startExternalCapture(stream, 'Shared screen audio', false);
  } catch (error) {
    console.error('Could not capture shared screen audio:', error);
    captureHelp.textContent = error.name === 'NotAllowedError'
      ? 'Screen/audio sharing was cancelled or denied.'
      : error.message || 'Could not capture screen audio in this browser or operating system.';
    statusChip.textContent = 'CAPTURE ERROR';
  } finally {
    captureDesktopButton.disabled = false;
  }
}

if (extensionApi) {
  extensionCapture.hidden = false;
  captureTabButton.addEventListener('click', captureActiveTab);
  captureDesktopButton.addEventListener('click', captureDesktopAudio);
  stopCaptureButton.addEventListener('click', () => stopExternalCapture());
}

function updateMicStatus(active) {
  micActive = active;
  micStatus.textContent = active ? 'MIC ACTIVE' : 'MIC';
  micStatus.classList.toggle('active', active);
  micButton.classList.toggle('active', active);
  micButton.setAttribute('aria-pressed', String(active));
}

function stopMic() {
  updateMicStatus(false);
  if (micSourceNode) {
    micSourceNode.disconnect();
    micSourceNode = null;
  }
  if (micStream) {
    micStream.getTracks().forEach(track => track.stop());
    micStream = null;
  }
  if (audio.paused) {
    statusChip.textContent = audio.src ? 'PAUSED' : 'READY';
    if (!audio.src) hint.classList.remove('hidden');
    drawIdleState();
  }
}

async function toggleMic() {
  if (micActive) {
    stopMic();
    return;
  }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    statusChip.textContent = 'UNSUPPORTED';
    playerSubtitle.textContent = 'Microphone input requires a supported browser on HTTPS or localhost.';
    return;
  }
  if (!prepareAudioGraph()) return;

  micButton.disabled = true;
  try {
    if (audioContext.state === 'suspended') await audioContext.resume();
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    if (externalActive) stopExternalCapture('Switched to microphone input.');
    micSourceNode = audioContext.createMediaStreamSource(micStream);
    micSourceNode.connect(analyser);
    micStream.getAudioTracks().forEach(track => {
      track.addEventListener('ended', stopMic, { once: true });
    });
    updateMicStatus(true);
    statusChip.textContent = audio.paused ? 'MIC ACTIVE' : 'MIC + PLAYING';
    playerSubtitle.textContent = 'Microphone input is active and stays in your browser.';
    hint.classList.add('hidden');
    startAnimation();
  } catch (error) {
    console.error('Could not start microphone input:', error);
    statusChip.textContent = 'MIC ERROR';
    playerSubtitle.textContent = error.name === 'NotAllowedError'
      ? 'Microphone permission was denied.'
      : 'Could not access the microphone. Check your browser and device settings.';
    if (micStream) {
      micStream.getTracks().forEach(track => track.stop());
      micStream = null;
    }
    if (micSourceNode) {
      micSourceNode.disconnect();
      micSourceNode = null;
    }
  } finally {
    micButton.disabled = false;
  }
}

function setMode(mode) {
  currentMode = mode;
  modeButtons.forEach(button => {
    const active = button.dataset.mode === mode;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  if (audio.paused && !micActive) drawIdleState();
}

fileInput.addEventListener('change', () => {
  const file = fileInput.files && fileInput.files[0];
  if (!file) return;
  if (externalActive) stopExternalCapture();
  if (micActive) stopMic();
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = URL.createObjectURL(file);
  audio.pause();
  audio.src = objectUrl;
  audio.load();
  const name = file.name.replace(/\.[^/.]+$/, '');
  trackTitle.textContent = name;
  playerTrackName.textContent = name;
  playerSubtitle.textContent = `${(file.size / (1024 * 1024)).toFixed(1)} MB · Local file`;
  playButton.disabled = false;
  hint.classList.remove('hidden');
  statusChip.textContent = 'LOADED';
  progressFill.style.width = '0%';
  currentTimeLabel.textContent = '0:00';
  durationLabel.textContent = '0:00';
  if (!micActive) drawIdleState();
});

playButton.addEventListener('click', async () => {
  if (!audio.src) return;
  if (!prepareAudioGraph()) return;
  try {
    if (audioContext.state === 'suspended') await audioContext.resume();
    if (audio.paused) await audio.play();
    else audio.pause();
  } catch (error) {
    console.error('Could not play selected audio:', error);
    statusChip.textContent = 'PLAYBACK ERROR';
    playerSubtitle.textContent = 'This audio format may not be supported by your browser.';
  }
});

audio.addEventListener('play', () => {
  playIcon.textContent = 'Ⅱ';
  playButton.setAttribute('aria-label', 'Pause');
  statusChip.textContent = micActive ? 'MIC + PLAYING' : 'PLAYING';
  hint.classList.add('hidden');
  startAnimation();
});
audio.addEventListener('pause', () => {
  playIcon.textContent = '▶';
  playButton.setAttribute('aria-label', 'Play');
  if (!audio.ended && audio.src) statusChip.textContent = micActive ? 'MIC ACTIVE' : 'PAUSED';
  if (!micActive) drawIdleState();
});
audio.addEventListener('ended', () => {
  statusChip.textContent = micActive ? 'MIC ACTIVE' : 'FINISHED';
  playIcon.textContent = '▶';
  playButton.setAttribute('aria-label', 'Play');
});
audio.addEventListener('loadedmetadata', () => {
  durationLabel.textContent = formatTime(audio.duration);
});
audio.addEventListener('timeupdate', () => {
  currentTimeLabel.textContent = formatTime(audio.currentTime);
  if (Number.isFinite(audio.duration) && audio.duration > 0) {
    progressFill.style.width = `${(audio.currentTime / audio.duration) * 100}%`;
  }
});
audio.addEventListener('error', () => {
  if (!audio.src) return;
  statusChip.textContent = 'LOAD ERROR';
  playerSubtitle.textContent = 'This audio file could not be loaded by your browser.';
});

modeButtons.forEach(button => {
  button.addEventListener('click', () => setMode(button.dataset.mode));
});

sensitivityInput.addEventListener('input', () => {
  sensitivity = Number(sensitivityInput.value) / 100;
  sensitivityValue.value = `${sensitivityInput.value}%`;
  sensitivityValue.textContent = `${sensitivityInput.value}%`;
});
glowInput.addEventListener('input', () => {
  glow = Number(glowInput.value) / 100;
  glowValue.value = `${glowInput.value}%`;
  glowValue.textContent = `${glowInput.value}%`;
});
resetButton.addEventListener('click', () => {
  sensitivityInput.value = '65';
  glowInput.value = '70';
  sensitivity = 0.65;
  glow = 0.70;
  sensitivityValue.value = '65%';
  sensitivityValue.textContent = '65%';
  glowValue.value = '70%';
  glowValue.textContent = '70%';
  setMode('bars');
});
micButton.addEventListener('click', toggleMic);

function clearCanvas() {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  ctx.clearRect(0, 0, width, height);
  return { width, height };
}

function drawIdleState() {
  const { width, height } = clearCanvas();
  const middle = height / 2;
  ctx.save();
  ctx.globalAlpha = 0.28;
  ctx.strokeStyle = '#9b83e8';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, middle);
  ctx.lineTo(width, middle);
  ctx.stroke();
  for (let i = 0; i < 48; i++) {
    const x = (i / 48) * width + 2;
    const barHeight = 3 + (Math.sin(i * 0.7) + 1) * 5;
    ctx.fillStyle = palette[i % palette.length];
    ctx.fillRect(x, middle - barHeight / 2, Math.max(2, width / 170), barHeight);
  }
  ctx.restore();
}

function drawSpectrum(width, height) {
  analyser.getByteFrequencyData(frequencyData);
  const count = Math.max(1, Math.min(96, Math.floor(width / 5)));
  const gap = 2;
  const barWidth = Math.max(1, (width - gap * (count - 1)) / count);
  const centerY = height * 0.53;
  const maxHeight = height * 0.42;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < count; i++) {
    const t = i / count;
    const bin = Math.min(frequencyData.length - 1, Math.floor(Math.pow(t, 1.75) * frequencyData.length));
    const raw = frequencyData[bin] / 255;
    const level = Math.min(1, Math.pow(raw * (0.65 + sensitivity), 0.85));
    const barHeight = Math.max(2, level * maxHeight);
    const x = i * (barWidth + gap);
    const color = palette[Math.floor((i / count) * (palette.length - 1))];
    ctx.shadowBlur = 18 * glow;
    ctx.shadowColor = color;
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.55 + level * 0.45;
    roundedRect(ctx, x, centerY - barHeight, barWidth, barHeight, Math.min(4, barWidth / 2));
    ctx.globalAlpha *= 0.48;
    roundedRect(ctx, x, centerY + 5, barWidth, barHeight * 0.42, Math.min(4, barWidth / 2));
  }
  ctx.restore();
  drawBassPulse(width, height);
}

function drawWaveform(width, height) {
  analyser.getByteTimeDomainData(waveformData);
  const middle = height / 2;
  const slice = width / waveformData.length;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.lineWidth = 2;
  ctx.shadowBlur = 18 * glow;
  ctx.shadowColor = '#b69aff';
  const gradient = ctx.createLinearGradient(0, 0, width, 0);
  gradient.addColorStop(0, '#b69aff');
  gradient.addColorStop(0.55, '#fb83c7');
  gradient.addColorStop(1, '#8be7ef');
  ctx.strokeStyle = gradient;
  ctx.beginPath();
  for (let i = 0; i < waveformData.length; i++) {
    const x = i * slice;
    const displacement = ((waveformData[i] - 128) / 128) * (height * 0.38) * (0.6 + sensitivity);
    const y = middle + displacement;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
  ctx.shadowBlur = 0;
  ctx.globalAlpha = 0.18;
  ctx.strokeStyle = '#b6a9e8';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, middle);
  ctx.lineTo(width, middle);
  ctx.stroke();
  ctx.restore();
}

function drawCircles(width, height) {
  analyser.getByteFrequencyData(frequencyData);
  const centerX = width / 2;
  const centerY = height / 2;
  const baseRadius = Math.min(width, height) * 0.12;
  const count = 64;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < count; i++) {
    const bin = Math.floor((i / count) * frequencyData.length * 0.7);
    const level = frequencyData[bin] / 255;
    const angle = (i / count) * Math.PI * 2;
    const inner = baseRadius + level * height * 0.16 * (0.5 + sensitivity);
    const outer = inner + 2 + level * 12;
    const color = palette[Math.floor((i / count) * palette.length)];
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.35 + level * 0.65;
    ctx.lineWidth = 2 + level * 3;
    ctx.shadowBlur = 14 * glow;
    ctx.shadowColor = color;
    ctx.beginPath();
    ctx.moveTo(centerX + Math.cos(angle) * inner, centerY + Math.sin(angle) * inner);
    ctx.lineTo(centerX + Math.cos(angle) * outer, centerY + Math.sin(angle) * outer);
    ctx.stroke();
  }
  ctx.restore();
  drawBassPulse(width, height);
}

function drawParticles(width, height) {
  analyser.getByteFrequencyData(frequencyData);
  while (particles.length < PARTICLE_COUNT) {
    particles.push({
      x: Math.random() * width,
      y: Math.random() * height,
      size: 1 + Math.random() * 2.5,
      phase: Math.random() * Math.PI * 2,
      speed: 0.3 + Math.random() * 0.9
    });
  }
  let bass = 0;
  for (let i = 0; i < Math.min(12, frequencyData.length); i++) bass += frequencyData[i] / 255;
  bass /= Math.min(12, frequencyData.length);

  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  particles.forEach((particle, index) => {
    const bin = Math.floor((index / particles.length) * frequencyData.length * 0.7);
    const level = frequencyData[bin] / 255;
    particle.phase += particle.speed * 0.012;
    particle.x += Math.cos(particle.phase) * (0.25 + level * 1.2);
    particle.y += Math.sin(particle.phase) * (0.25 + level * 1.2);
    if (particle.x < 0) particle.x += width;
    if (particle.x > width) particle.x -= width;
    if (particle.y < 0) particle.y += height;
    if (particle.y > height) particle.y -= height;
    const color = palette[index % palette.length];
    ctx.globalAlpha = 0.25 + level * 0.75;
    ctx.fillStyle = color;
    ctx.shadowBlur = (4 + bass * 18) * glow;
    ctx.shadowColor = color;
    ctx.beginPath();
    ctx.arc(particle.x, particle.y, particle.size + level * 2, 0, Math.PI * 2);
    ctx.fill();
  });
  ctx.restore();
}

function drawAurora(width, height) {
  analyser.getByteFrequencyData(frequencyData);
  const bands = [0, 0, 0, 0];
  for (let i = 0; i < frequencyData.length; i++) {
    const band = Math.min(bands.length - 1, Math.floor((i / frequencyData.length) * bands.length));
    bands[band] += frequencyData[i] / 255;
  }
  bands.forEach((_, i) => {
    const start = Math.floor((i / bands.length) * frequencyData.length);
    const end = Math.floor(((i + 1) / bands.length) * frequencyData.length);
    bands[i] /= Math.max(1, end - start);
  });

  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (let band = 0; band < bands.length; band++) {
    const level = Math.min(1, bands[band] * (0.8 + sensitivity));
    const baseline = height * (0.78 - band * 0.13);
    const amplitude = height * (0.08 + level * 0.32);
    const color = palette[band];
    const gradient = ctx.createLinearGradient(0, baseline - amplitude, 0, height);
    gradient.addColorStop(0, `${color}00`);
    gradient.addColorStop(0.55, `${color}${Math.round((0.12 + level * 0.22) * 255).toString(16).padStart(2, '0')}`);
    gradient.addColorStop(1, `${color}00`);
    ctx.beginPath();
    ctx.moveTo(0, height);
    for (let x = 0; x <= width; x += 8) {
      const progress = x / width;
      const wave = Math.sin(progress * Math.PI * (2 + band) + performance.now() * 0.0007) * amplitude;
      const secondaryWave = Math.sin(progress * Math.PI * 5 - performance.now() * 0.0004) * amplitude * 0.25;
      ctx.lineTo(x, baseline + wave + secondaryWave);
    }
    ctx.lineTo(width, height);
    ctx.closePath();
    ctx.fillStyle = gradient;
    ctx.shadowBlur = 22 * glow;
    ctx.shadowColor = color;
    ctx.fill();
  }
  ctx.restore();
}

function drawBassPulse(width, height) {
  let total = 0;
  const bins = Math.min(12, frequencyData.length);
  for (let i = 0; i < bins; i++) total += frequencyData[i] / 255;
  const bass = total / bins;
  lastBass += (bass - lastBass) * 0.12;
  const radius = 24 + lastBass * 78 * (0.5 + sensitivity);
  const halo = ctx.createRadialGradient(width / 2, height * 0.53, 2, width / 2, height * 0.53, radius);
  halo.addColorStop(0, `rgba(191, 146, 255, ${0.04 + lastBass * 0.12})`);
  halo.addColorStop(1, 'rgba(191, 146, 255, 0)');
  ctx.save();
  ctx.fillStyle = halo;
  ctx.fillRect(width / 2 - radius, height * 0.53 - radius, radius * 2, radius * 2);
  ctx.restore();
}

function roundedRect(context, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  context.beginPath();
  context.moveTo(x + r, y);
  context.arcTo(x + width, y, x + width, y + height, r);
  context.arcTo(x + width, y + height, x, y + height, r);
  context.arcTo(x, y + height, x, y, r);
  context.arcTo(x, y, x + width, y, r);
  context.closePath();
  context.fill();
}

function renderFrame() {
  animationFrame = 0;
  const { width, height } = clearCanvas();
  if (!analyser || !frequencyData || (audio.paused && !micActive && !externalActive)) {
    drawIdleState();
    return;
  }
  if (currentMode === 'wave') drawWaveform(width, height);
  else if (currentMode === 'circles') drawCircles(width, height);
  else if (currentMode === 'particles') drawParticles(width, height);
  else if (currentMode === 'aurora') drawAurora(width, height);
  else drawSpectrum(width, height);
  animationFrame = requestAnimationFrame(renderFrame);
}

function startAnimation() {
  if (!animationFrame) animationFrame = requestAnimationFrame(renderFrame);
}

window.addEventListener('resize', () => {
  resizeCanvas();
  if (audio.paused && !micActive && !externalActive) drawIdleState();
});
window.addEventListener('beforeunload', () => {
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  if (micStream) micStream.getTracks().forEach(track => track.stop());
  if (externalStream) externalStream.getTracks().forEach(track => track.stop());
});

resizeCanvas();
updateFullscreenButton();
drawIdleState();
