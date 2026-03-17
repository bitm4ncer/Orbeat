/**
 * Audio Input Capture — Record from mic/interface into orbitrack
 *
 * Signal path:
 *   getUserMedia(deviceId) → MediaStreamSource → inputGain → ScriptProcessorNode (PCM capture)
 *                                                           ↘ (monitor) → destinationGain
 */

import { getAudioContext } from 'superdough';
import { getMasterGain } from './routingEngine';

// ── Module state ──────────────────────────────────────────────────────────────
let stream: MediaStream | null = null;
let sourceNode: MediaStreamAudioSourceNode | null = null;
let scriptNode: ScriptProcessorNode | null = null;
let inputGain: GainNode | null = null;
let analyserNode: AnalyserNode | null = null;
let leftChunks: Float32Array[] = [];
let rightChunks: Float32Array[] = [];
let capturing = false;
let monitoring = false;
let sampleRate = 44100;
let startTime = 0;

// ── Device enumeration ────────────────────────────────────────────────────────

export interface AudioInputDevice {
  deviceId: string;
  label: string;
  groupId: string;
}

export async function getAudioInputDevices(): Promise<AudioInputDevice[]> {
  if (!navigator.mediaDevices) {
    console.warn('[AudioInput] navigator.mediaDevices not available (needs HTTPS or localhost)');
    return [];
  }

  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const inputs = devices.filter(d => d.kind === 'audioinput');
    const outputs = devices.filter(d => d.kind === 'audiooutput');
    console.log('[AudioInput] enumerateDevices:', {
      total: devices.length,
      inputs: inputs.length,
      outputs: outputs.length,
      inputList: inputs.map(d => d.label || `(no label) [${d.deviceId.slice(0, 8)}]`),
      outputList: outputs.map(d => d.label || `(no label) [${d.deviceId.slice(0, 8)}]`),
    });
    return inputs.map(d => ({
      deviceId: d.deviceId,
      label: d.label || `Input ${d.deviceId.slice(0, 8)}`,
      groupId: d.groupId,
    }));
  } catch (err) {
    console.error('[AudioInput] enumerateDevices failed:', err);
    return [];
  }
}

// ── Output device enumeration ─────────────────────────────────────────────────

export interface AudioOutputDevice {
  deviceId: string;
  label: string;
  groupId: string;
}

export async function getAudioOutputDevices(requestPermission = false): Promise<AudioOutputDevice[]> {
  if (!navigator.mediaDevices) return [];
  try {
    // On HTTPS, browsers hide device labels until a media permission is granted.
    // Check if we already have permission; if not and requested, ask for it.
    let hasPermission = false;
    if (navigator.permissions) {
      try {
        const status = await navigator.permissions.query({ name: 'microphone' as PermissionName });
        hasPermission = status.state === 'granted';
      } catch { /* permissions API may not support 'microphone' query */ }
    }

    if (!hasPermission && requestPermission) {
      const err = await requestMicPermission();
      if (!err) hasPermission = true;
    }

    const devices = await navigator.mediaDevices.enumerateDevices();
    const outputs = devices.filter(d => d.kind === 'audiooutput');
    return outputs.map(d => ({
      deviceId: d.deviceId,
      label: d.label || `Output ${d.deviceId.slice(0, 8)}`,
      groupId: d.groupId,
    }));
  } catch (err) {
    console.error('[AudioOutput] enumerateDevices failed:', err);
    return [];
  }
}

/** Switch the AudioContext output to a specific device. Returns null on success, error message on failure. */
export async function setAudioOutputDevice(deviceId: string): Promise<string | null> {
  try {
    const ctx = getAudioContext() as AudioContext;
    if (!('setSinkId' in ctx)) {
      return 'Your browser does not support audio output device selection (setSinkId)';
    }
    await (ctx as any).setSinkId(deviceId);
    console.log('[AudioOutput] Switched to device:', deviceId);
    return null;
  } catch (err: any) {
    console.error('[AudioOutput] setSinkId failed:', err);
    return err?.message ?? 'Failed to switch audio output device';
  }
}

/** Request microphone permission — call this before enumerating to get labels */
export async function requestMicPermission(): Promise<string | null> {
  if (!navigator.mediaDevices?.getUserMedia) {
    return 'getUserMedia not supported (needs HTTPS or localhost)';
  }
  try {
    const tempStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    tempStream.getTracks().forEach(t => t.stop());
    console.log('[AudioInput] Mic permission granted');
    return null; // success
  } catch (err: any) {
    const msg = err?.name === 'NotAllowedError'
      ? 'Microphone permission denied — check browser settings'
      : err?.name === 'NotFoundError'
        ? 'No microphone found'
        : `Mic access failed: ${err?.message || err}`;
    console.error('[AudioInput]', msg);
    return msg;
  }
}

/** Subscribe to device connect/disconnect events */
export function onAudioDeviceChange(callback: () => void): () => void {
  navigator.mediaDevices.addEventListener('devicechange', callback);
  return () => navigator.mediaDevices.removeEventListener('devicechange', callback);
}

// ── Start capture ─────────────────────────────────────────────────────────────

export async function startInputCapture(deviceId?: string): Promise<boolean> {
  if (capturing) return false;

  try {
    const constraints: MediaStreamConstraints = {
      audio: deviceId
        ? { deviceId: { exact: deviceId }, echoCancellation: false, noiseSuppression: false, autoGainControl: false }
        : { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    };

    stream = await navigator.mediaDevices.getUserMedia(constraints);

    const ac = getAudioContext() as AudioContext;
    sampleRate = ac.sampleRate;

    // Source → inputGain → scriptNode (PCM capture)
    sourceNode = ac.createMediaStreamSource(stream);
    inputGain = ac.createGain();
    inputGain.gain.value = 1;

    // Analyser for level metering (leaf node — not in audio path)
    analyserNode = ac.createAnalyser();
    analyserNode.fftSize = 2048;
    analyserNode.smoothingTimeConstant = 0.3;

    // ScriptProcessor for PCM capture
    scriptNode = ac.createScriptProcessor(4096, 2, 2);
    leftChunks = [];
    rightChunks = [];

    scriptNode.onaudioprocess = (e) => {
      leftChunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
      if (e.inputBuffer.numberOfChannels > 1) {
        rightChunks.push(new Float32Array(e.inputBuffer.getChannelData(1)));
      } else {
        // Mono input → duplicate to right channel
        rightChunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
      }
    };

    sourceNode.connect(inputGain);
    inputGain.connect(analyserNode);
    inputGain.connect(scriptNode);
    // ScriptProcessor must connect to destination to fire onaudioprocess
    scriptNode.connect(ac.destination);

    startTime = Date.now();
    capturing = true;
    console.log('[AudioInput] Capture started');
    return true;
  } catch (err) {
    console.error('[AudioInput] Failed to start capture:', err);
    cleanup();
    return false;
  }
}

// ── Stop capture ──────────────────────────────────────────────────────────────

export function stopInputCapture(): AudioBuffer | null {
  if (!capturing) return null;

  capturing = false;

  // Stop monitoring if active
  if (monitoring) setInputMonitor(false);

  // Disconnect audio graph
  try { sourceNode?.disconnect(); } catch { /* ok */ }
  try { scriptNode?.disconnect(); } catch { /* ok */ }
  try { inputGain?.disconnect(); } catch { /* ok */ }
  if (scriptNode) scriptNode.onaudioprocess = null;

  // Stop media stream
  stream?.getTracks().forEach(t => t.stop());

  // Merge PCM chunks → AudioBuffer
  const left = mergeBuffers(leftChunks);
  const right = mergeBuffers(rightChunks);
  leftChunks = [];
  rightChunks = [];

  if (left.length === 0) {
    cleanup();
    return null;
  }

  const ac = getAudioContext() as AudioContext;
  const buffer = ac.createBuffer(2, left.length, sampleRate);
  buffer.getChannelData(0).set(left);
  buffer.getChannelData(1).set(right);

  console.log(`[AudioInput] Captured ${(left.length / sampleRate).toFixed(1)}s @ ${sampleRate}Hz`);
  cleanup();
  return buffer;
}

// ── Monitor (hear input through speakers) ─────────────────────────────────────

export function setInputMonitor(enabled: boolean): void {
  if (!inputGain) return;

  const masterGain = getMasterGain();
  if (!masterGain) return;

  if (enabled && !monitoring) {
    inputGain.connect(masterGain);
    monitoring = true;
  } else if (!enabled && monitoring) {
    try { inputGain.disconnect(masterGain); } catch { /* ok */ }
    monitoring = false;
  }
}

export function isMonitoring(): boolean {
  return monitoring;
}

// ── Level metering ────────────────────────────────────────────────────────────

const levelBuf = new Float32Array(2048);

export function getInputLevel(): number {
  if (!analyserNode || !capturing) return -Infinity;

  analyserNode.getFloatTimeDomainData(levelBuf);
  let peak = 0;
  for (let i = 0; i < levelBuf.length; i++) {
    const abs = Math.abs(levelBuf[i]);
    if (abs > peak) peak = abs;
  }

  return peak > 0 ? 20 * Math.log10(peak) : -Infinity;
}

export function getInputAnalyser(): AnalyserNode | null {
  return analyserNode;
}

// ── State queries ─────────────────────────────────────────────────────────────

export function isCapturing(): boolean {
  return capturing;
}

export function getCaptureDuration(): number {
  if (!capturing) return 0;
  return Date.now() - startTime;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function mergeBuffers(chunks: Float32Array[]): Float32Array {
  let totalLen = 0;
  for (const c of chunks) totalLen += c.length;
  const result = new Float32Array(totalLen);
  let offset = 0;
  for (const c of chunks) {
    result.set(c, offset);
    offset += c.length;
  }
  return result;
}

function cleanup(): void {
  sourceNode = null;
  scriptNode = null;
  inputGain = null;
  analyserNode = null;
  stream = null;
}
