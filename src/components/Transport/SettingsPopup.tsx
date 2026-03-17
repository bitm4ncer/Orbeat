/** Settings popup with audio, MIDI, and app settings */

import { useState, useEffect, useRef, useCallback } from 'react';
import { useStore } from '../../state/store';
import { MidiSettingsPanel } from '../MidiSettings/MidiSettingsPanel';
import { getAudioInputDevices, requestMicPermission, getInputLevel, isCapturing, getCaptureDuration, onAudioDeviceChange, type AudioInputDevice, getAudioOutputDevices, setAudioOutputDevice as setAudioOutput, type AudioOutputDevice } from '../../audio/audioInput';
import { getAutosaveEnabled, setAutosaveEnabled, getAutosaveInterval, setAutosaveInterval, getInitialAutosave, setInitialAutosave } from '../../storage/sessionAutosave';
import { getCobaltEndpoint, setCobaltEndpoint, getCobaltApiKey, setCobaltApiKey, DEFAULT_ENDPOINT } from '../../storage/cobaltSettings';
import { testCobaltConnection } from '../../audio/videoImport';
import { log } from '../../logging/logger';

interface SettingsSection {
  id: string;
  label: string;
  icon: string;
}

const SECTIONS: SettingsSection[] = [
  { id: 'info', label: 'Info', icon: 'info' },
  { id: 'midi', label: 'MIDI', icon: 'midi' },
  { id: 'audio', label: 'Audio', icon: 'audio' },
  { id: 'sources', label: 'Sources', icon: 'sources' },
  { id: 'storage', label: 'Storage', icon: 'storage' },
  { id: 'display', label: 'Display', icon: 'display' },
  { id: 'log', label: 'Log', icon: 'log' },
  { id: 'shortcuts', label: 'Shortcuts', icon: 'shortcuts' },
  { id: 'about', label: 'About', icon: 'about' },
];

function renderIcon(iconName: string): React.ReactNode {
  const iconProps = 'w-4 h-4 text-text-secondary';

  switch (iconName) {
    case 'info':
      return <svg className={iconProps} fill="currentColor" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" fill="none"/><line x1="12" y1="16" x2="12" y2="12" stroke="currentColor" strokeWidth="2"/><circle cx="12" cy="8" r="0.5" fill="currentColor"/></svg>;
    case 'midi':
      return <svg className={iconProps} fill="currentColor" viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="1" stroke="currentColor" strokeWidth="2" fill="none"/><line x1="8" y1="9" x2="8" y2="15" stroke="currentColor" strokeWidth="2"/><line x1="16" y1="9" x2="16" y2="15" stroke="currentColor" strokeWidth="2"/><circle cx="12" cy="12" r="2" fill="currentColor"/></svg>;
    case 'audio':
      return <svg className={iconProps} fill="currentColor" viewBox="0 0 24 24"><path d="M12 3v18M8 5v14M16 5v14M4 8v8M20 8v8" stroke="currentColor" strokeWidth="2"/></svg>;
    case 'display':
      return <svg className={iconProps} fill="none" viewBox="0 0 24 24"><rect x="2" y="3" width="20" height="14" rx="1" stroke="currentColor" strokeWidth="2"/><path d="M8 17h8" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/><path d="M9 20h6" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>;
    case 'shortcuts':
      return <svg className={iconProps} fill="none" viewBox="0 0 24 24"><path d="M4 6h16M4 12h16M4 18h16" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>;
    case 'sources':
      return <svg className={iconProps} fill="none" viewBox="0 0 24 24"><path d="M12 2v8l3-3M12 10l-3-3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/><path d="M20 12v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/><path d="M4 22h16" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>;
    case 'storage':
      return <svg className={iconProps} fill="none" viewBox="0 0 24 24"><path d="M4 7v10c0 1.1.9 2 2 2h12a2 2 0 002-2V7" stroke="currentColor" strokeWidth="2"/><path d="M20 7H4a2 2 0 01-2-2V5a2 2 0 012-2h16a2 2 0 012 2v0a2 2 0 01-2 2z" stroke="currentColor" strokeWidth="2"/><path d="M10 12h4" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>;
    case 'log':
      return <svg className={iconProps} fill="none" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2" stroke="currentColor" strokeWidth="2"/><path d="M7 9l3 3-3 3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/><path d="M13 15h4" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>;
    case 'about':
      return <svg className={iconProps} fill="none" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2"/><path d="M12 16v-4M12 8h.01" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>;
    default:
      return null;
  }
}

function AudioOutputSection() {
  const audioOutputDeviceId = useStore((s) => s.audioOutputDeviceId);
  const storeSetOutputDevice = useStore((s) => s.setAudioOutputDevice);
  const [devices, setDevices] = useState<AudioOutputDevice[]>([]);
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsPermission, setNeedsPermission] = useState(false);

  const refreshDevices = useCallback(async (requestPermission = false) => {
    const d = await getAudioOutputDevices(requestPermission);
    setDevices(d);
    // Check if we got real labels or just generic fallbacks
    const hasLabels = d.some(dev => dev.label && !dev.label.startsWith('Output '));
    setNeedsPermission(!hasLabels && d.length <= 1);
  }, []);

  useEffect(() => {
    refreshDevices();
    const unsub = onAudioDeviceChange(() => { refreshDevices(); });
    return unsub;
  }, [refreshDevices]);

  // Apply saved device on mount
  useEffect(() => {
    if (audioOutputDeviceId) {
      setAudioOutput(audioOutputDeviceId).then((err) => {
        if (err) setError(err);
      });
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleChange = useCallback(async (deviceId: string) => {
    setError(null);
    setSwitching(true);
    const id = deviceId || null;
    if (id) {
      const err = await setAudioOutput(deviceId);
      if (err) {
        setError(err);
        setSwitching(false);
        return;
      }
    }
    storeSetOutputDevice(id);
    setSwitching(false);
  }, [storeSetOutputDevice]);

  return (
    <div className="space-y-2 mb-4">
      <label className="text-xs font-medium text-text-secondary">Output Device</label>
      <select
        value={audioOutputDeviceId ?? ''}
        onChange={(e) => handleChange(e.target.value)}
        disabled={switching}
        className="w-full px-3 py-2 text-xs bg-bg-tertiary border border-border rounded text-text-primary focus:outline-none focus:border-accent"
      >
        <option value="">System Default</option>
        {devices.map((d) => (
          <option key={d.deviceId} value={d.deviceId}>
            {d.label}
          </option>
        ))}
      </select>
      {needsPermission && (
        <button
          onClick={() => refreshDevices(true)}
          className="w-full px-3 py-1.5 text-xs bg-accent/20 border border-accent/40 rounded text-accent hover:bg-accent/30 transition-colors"
        >
          Detect Audio Devices
        </button>
      )}
      {needsPermission && (
        <p className="text-[10px] text-text-secondary/50">
          Browser requires permission to list audio devices. Click above — a popup will ask you to allow microphone access.
        </p>
      )}
      {error && (
        <p className="text-xs text-red-400 mt-1">{error}</p>
      )}
      {!needsPermission && devices.length === 0 && (
        <p className="text-[10px] text-text-secondary/50 mt-1">
          No output devices detected. Your browser may not support output device enumeration.
        </p>
      )}
    </div>
  );
}

function AudioInputSection() {
  const audioInputDeviceId = useStore((s) => s.audioInputDeviceId);
  const audioInputMonitor = useStore((s) => s.audioInputMonitor);
  const isCapturingInput = useStore((s) => s.isCapturingInput);
  const setAudioInputDevice = useStore((s) => s.setAudioInputDevice);
  const setAudioInputMonitor = useStore((s) => s.setAudioInputMonitor);
  const startAudioCapture = useStore((s) => s.startAudioCapture);
  const stopAudioCapture = useStore((s) => s.stopAudioCapture);

  const [devices, setDevices] = useState<AudioInputDevice[]>([]);
  const [level, setLevel] = useState(-Infinity);
  const [elapsed, setElapsed] = useState(0);
  const [permissionGranted, setPermissionGranted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rafRef = useRef(0);

  const refreshDevices = useCallback(async () => {
    const d = await getAudioInputDevices();
    setDevices(d);
    // If we got devices with labels, permission was already granted
    if (d.length > 0 && d.some(dev => dev.label && !dev.label.startsWith('Input '))) {
      setPermissionGranted(true);
    }
  }, []);

  const handleGrantPermission = useCallback(async () => {
    setError(null);
    const err = await requestMicPermission();
    if (err) {
      setError(err);
    } else {
      setPermissionGranted(true);
      await refreshDevices();
    }
  }, [refreshDevices]);

  // Enumerate on mount (labels appear if permission was previously granted)
  // getUserMedia must only be called from a user click — browsers silently block it otherwise
  useEffect(() => {
    refreshDevices();
    const unsub = onAudioDeviceChange(() => { refreshDevices(); });
    return unsub;
  }, [refreshDevices]);

  // Level meter + timer animation loop
  useEffect(() => {
    if (!isCapturingInput) { setLevel(-Infinity); setElapsed(0); return; }
    const tick = () => {
      setLevel(getInputLevel());
      setElapsed(getCaptureDuration());
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [isCapturingInput]);

  // Also show level when device is selected (even before recording)
  useEffect(() => {
    if (isCapturingInput) return; // already handled above
    if (!isCapturing()) return;
    const tick = () => {
      setLevel(getInputLevel());
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [audioInputDeviceId, isCapturingInput]);

  const levelDb = level > -Infinity ? Math.max(-60, level) : -60;
  const levelPct = Math.max(0, Math.min(100, ((levelDb + 60) / 60) * 100));

  const formatTime = useCallback((ms: number) => {
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    return `${m}:${String(s % 60).padStart(2, '0')}`;
  }, []);

  return (
    <div className="border-t border-border/30 pt-4 mt-4">
      <h3 className="text-sm font-semibold text-text-primary mb-4">Audio Input</h3>

      {/* Permission grant */}
      {!permissionGranted && (
        <div className="mb-4 space-y-2">
          <button
            onClick={handleGrantPermission}
            className="flex items-center gap-2 px-3 py-2 rounded text-xs font-medium bg-accent/20 text-accent border border-accent/30 hover:bg-accent/30 transition-colors"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
              <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
              <line x1="12" y1="19" x2="12" y2="23" />
            </svg>
            Allow Microphone Access
          </button>
          {error && (
            <p className="text-xs text-red-400">{error}</p>
          )}
        </div>
      )}

      {/* Device selector */}
      <div className="space-y-1 mb-4">
        <label className="text-xs font-medium text-text-secondary">Input Device</label>
        <select
          value={audioInputDeviceId ?? 'none'}
          onChange={(e) => setAudioInputDevice(e.target.value === 'none' ? null : e.target.value)}
          className="w-full px-2 py-1.5 text-xs bg-background border border-border rounded"
          disabled={!permissionGranted && devices.length === 0}
        >
          <option value="none">— None —</option>
          {devices.map((d) => (
            <option key={d.deviceId} value={d.deviceId}>
              {d.label}
            </option>
          ))}
        </select>
        {permissionGranted && devices.length === 0 && (
          <div className="flex items-center gap-2">
            <p className="text-xs text-text-secondary/50">No audio input devices detected</p>
            <button
              onClick={refreshDevices}
              className="text-[10px] px-1.5 py-0.5 rounded bg-bg-tertiary border border-border hover:bg-bg-tertiary/80 text-text-secondary"
            >
              Refresh
            </button>
          </div>
        )}
      </div>

      {/* Monitor toggle */}
      <div className="flex items-center gap-2 mb-4">
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={audioInputMonitor}
            onChange={(e) => setAudioInputMonitor(e.target.checked)}
            className="w-4 h-4 rounded"
            disabled={!isCapturingInput}
          />
          <span className="text-xs text-text-secondary">Monitor (hear input)</span>
        </label>
      </div>

      {/* Level meter */}
      {isCapturingInput && (
        <div className="mb-4 space-y-1">
          <label className="text-xs font-medium text-text-secondary">Input Level</label>
          <div className="h-3 bg-bg-tertiary rounded border border-border/30 overflow-hidden">
            <div
              className="h-full transition-all duration-75 rounded"
              style={{
                width: `${levelPct}%`,
                background: levelPct > 85 ? '#ef4444' : levelPct > 65 ? '#f59e0b' : '#22c55e',
              }}
            />
          </div>
          <div className="flex justify-between text-[10px] text-text-secondary/50 font-mono">
            <span>-60 dB</span>
            <span>{levelDb > -60 ? `${levelDb.toFixed(0)} dB` : '—'}</span>
            <span>0 dB</span>
          </div>
        </div>
      )}

      {/* Record button + timer */}
      <div className="flex items-center gap-3">
        <button
          onClick={() => isCapturingInput ? stopAudioCapture() : startAudioCapture()}
          className={`flex items-center gap-2 px-3 py-1.5 rounded text-xs font-medium transition-colors ${
            isCapturingInput
              ? 'bg-red-500/20 text-red-400 border border-red-500/30 hover:bg-red-500/30 animate-pulse'
              : 'bg-bg-tertiary border border-border hover:bg-bg-tertiary/80 text-text-primary cursor-pointer'
          }`}
        >
          <span className={`w-2.5 h-2.5 rounded-full ${isCapturingInput ? 'bg-red-500' : 'bg-red-400/60'}`} />
          {isCapturingInput ? 'Stop' : 'Record'}
        </button>

        {isCapturingInput && (
          <span className="text-xs font-mono text-red-400">{formatTime(elapsed)}</span>
        )}

        {!isCapturingInput && (
          <span className="text-xs text-text-secondary/50">
            Recording auto-loads into selected looper
          </span>
        )}
      </div>
    </div>
  );
}

function getDockerDownloadUrl(): { url: string; label: string } {
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes('win')) return { url: 'https://desktop.docker.com/win/main/amd64/Docker%20Desktop%20Installer.exe', label: 'Download Docker Desktop for Windows' };
  if (ua.includes('mac')) {
    // Apple Silicon detection via platform or userAgent
    const isArm = navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1
      || ua.includes('arm') || navigator.platform === 'MacARM';
    return isArm
      ? { url: 'https://desktop.docker.com/mac/main/arm64/Docker.dmg', label: 'Download Docker Desktop for Mac (Apple Silicon)' }
      : { url: 'https://desktop.docker.com/mac/main/amd64/Docker.dmg', label: 'Download Docker Desktop for Mac (Intel)' };
  }
  return { url: 'https://docs.docker.com/desktop/install/linux/', label: 'Install Docker Desktop for Linux' };
}

function downloadCobaltInstaller(): void {
  const ua = navigator.userAgent.toLowerCase();
  const isWindows = ua.includes('win');

  const windowsScript = `@echo off
echo ============================================
echo   orbitrack - cobalt installer
echo ============================================
echo.

where docker >nul 2>nul
if %errorlevel% neq 0 (
    echo Docker is not installed or not in PATH.
    echo Please install Docker Desktop first, then run this script again.
    echo https://www.docker.com/products/docker-desktop/
    pause
    exit /b 1
)

:: Check if Docker daemon is responding
docker info >nul 2>nul
if %errorlevel% equ 0 goto :dockerready

echo Docker Desktop is not running. Starting it...
start "" "C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe"
echo Waiting for Docker to start...
set /a attempts=0

:waitloop
timeout /t 3 /nobreak >nul
docker info >nul 2>nul
if %errorlevel% equ 0 goto :dockerready
set /a attempts+=1
if %attempts% geq 30 (
    echo.
    echo Docker did not start after 90 seconds.
    echo Please start Docker Desktop manually and run this script again.
    pause
    exit /b 1
)
echo   Still waiting... (%attempts%/30)
goto :waitloop

:dockerready
echo Docker is running.
echo.

echo Pulling cobalt image...
docker pull ghcr.io/imputnet/cobalt:latest
if %errorlevel% neq 0 (
    echo.
    echo Failed to pull image.
    pause
    exit /b 1
)

echo.
echo Stopping old cobalt container if running...
docker stop orbitrack-cobalt >nul 2>nul
docker rm orbitrack-cobalt >nul 2>nul

echo.
echo Starting cobalt on port 9000...
docker run -d --name orbitrack-cobalt -p 9000:9000 -e API_URL=http://localhost:9000 -e API_CORS_WILDCARD=1 --restart unless-stopped ghcr.io/imputnet/cobalt:latest

if %errorlevel% equ 0 (
    echo.
    echo ============================================
    echo   cobalt is running at http://localhost:9000
    echo   Set this as your endpoint in orbitrack
    echo   Sources settings.
    echo ============================================
) else (
    echo.
    echo Failed to start container. Check Docker Desktop.
)
echo.
pause
`;

  const unixScript = `#!/bin/bash
echo "============================================"
echo "  orbitrack - cobalt installer"
echo "============================================"
echo ""

if ! command -v docker &> /dev/null; then
    echo "Docker is not installed or not in PATH."
    echo "Please install Docker Desktop first, then run this script again."
    echo "https://www.docker.com/products/docker-desktop/"
    exit 1
fi

# Check if Docker daemon is responding
if ! docker info &> /dev/null; then
    echo "Docker Desktop is not running. Starting it..."
    if [[ "$(uname)" == "Darwin" ]]; then
        open -a Docker
    else
        systemctl --user start docker-desktop 2>/dev/null || true
    fi
    echo "Waiting for Docker to start..."
    attempts=0
    while ! docker info &> /dev/null; do
        sleep 3
        attempts=$((attempts + 1))
        if [ $attempts -ge 30 ]; then
            echo "Docker did not start after 90 seconds."
            echo "Please start Docker Desktop manually and run this script again."
            exit 1
        fi
        echo "  Still waiting... ($attempts/30)"
    done
fi
echo "Docker is running."
echo ""

echo "Pulling cobalt image..."
docker pull ghcr.io/imputnet/cobalt:latest || { echo "Failed to pull image."; exit 1; }

echo ""
echo "Stopping old cobalt container if running..."
docker stop orbitrack-cobalt 2>/dev/null
docker rm orbitrack-cobalt 2>/dev/null

echo ""
echo "Starting cobalt on port 9000..."
docker run -d --name orbitrack-cobalt -p 9000:9000 \\
  -e API_URL=http://localhost:9000 \\
  -e API_CORS_WILDCARD=1 \\
  --restart unless-stopped \\
  ghcr.io/imputnet/cobalt:latest

if [ $? -eq 0 ]; then
    echo ""
    echo "============================================"
    echo "  cobalt is running at http://localhost:9000"
    echo "  Set this as your endpoint in orbitrack"
    echo "  Sources settings."
    echo "============================================"
else
    echo ""
    echo "Failed to start container. Check Docker."
fi
`;

  const content = isWindows ? windowsScript : unixScript;
  const filename = isWindows ? 'orbitrack-cobalt-install.bat' : 'orbitrack-cobalt-install.sh';
  const blob = new Blob([content], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function SourcesSettings() {
  const [endpoint, setEndpoint] = useState(() => getCobaltEndpoint());
  const [apiKey, setApiKey] = useState(() => getCobaltApiKey());
  const [testStatus, setTestStatus] = useState<'idle' | 'testing' | 'ok' | 'fail'>('idle');

  const handleEndpointChange = (val: string) => {
    setEndpoint(val);
    setCobaltEndpoint(val);
    setTestStatus('idle');
  };

  const handleApiKeyChange = (val: string) => {
    setApiKey(val);
    setCobaltApiKey(val);
    setTestStatus('idle');
  };

  const handleTest = async () => {
    setTestStatus('testing');
    const ok = await testCobaltConnection(endpoint, apiKey || undefined);
    setTestStatus(ok ? 'ok' : 'fail');
  };

  const docker = getDockerDownloadUrl();

  return (
    <div className="p-6 space-y-6">
      <div>
        <h3 className="text-sm font-semibold text-text-primary mb-1">Cobalt Media Fetch</h3>
        <p className="text-xs text-text-secondary/50 mb-4">
          Import audio from YouTube, TikTok, SoundCloud, Instagram & more via{' '}
          <a href="https://cobalt.tools" target="_blank" rel="noopener noreferrer" className="text-accent/60 hover:text-accent transition-colors">cobalt.tools</a>.
          Run cobalt locally for the best results — datacenter IPs are often blocked.
        </p>
      </div>

      {/* Step 1: Install Docker */}
      <div>
        <h3 className="text-sm font-semibold text-text-primary mb-3">1. Install Docker</h3>
        <div className="p-3 bg-bg-tertiary/50 rounded border border-border/30 space-y-3">
          <p className="text-xs text-text-secondary/70 leading-relaxed">
            cobalt runs as a Docker container. Install Docker Desktop if you don't have it yet.
          </p>
          <a
            href={docker.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 px-3 py-2 text-xs font-medium rounded border border-accent/30 bg-accent/10 text-accent hover:bg-accent/20 transition-colors"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3"/>
            </svg>
            {docker.label}
          </a>
          <p className="text-[10px] text-text-secondary/40">Free for personal use</p>
        </div>
      </div>

      {/* Step 2: One-click cobalt install */}
      <div>
        <h3 className="text-sm font-semibold text-text-primary mb-3">2. Start Cobalt</h3>
        <div className="p-3 bg-bg-tertiary/50 rounded border border-border/30 space-y-3">
          <p className="text-xs text-text-secondary/70 leading-relaxed">
            Download and run this script to pull the cobalt image and start it on port 9000.
          </p>
          <button
            onClick={downloadCobaltInstaller}
            className="inline-flex items-center gap-2 px-3 py-2 text-xs font-medium rounded border border-accent/30 bg-accent/10 text-accent hover:bg-accent/20 transition-colors cursor-pointer"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>
            </svg>
            Download Installer Script
          </button>
          <p className="text-[10px] text-text-secondary/40">
            Requires Docker Desktop running. The script pulls the image, removes any old container, and starts cobalt.
          </p>
        </div>
      </div>

      {/* Step 3: Configure endpoint */}
      <div>
        <h3 className="text-sm font-semibold text-text-primary mb-3">3. Configure</h3>
        <div className="space-y-3">
          <div className="space-y-1">
            <label className="text-xs font-medium text-text-secondary">Cobalt API Endpoint</label>
            <input
              type="url"
              value={endpoint}
              onChange={(e) => handleEndpointChange(e.target.value)}
              placeholder="http://localhost:9000"
              className="w-full px-2 py-1.5 text-xs bg-background border border-border rounded outline-none focus:border-accent transition-colors"
            />
            {endpoint === DEFAULT_ENDPOINT && (
              <p className="text-[10px] text-text-secondary/40">
                Using default server (some content may be blocked — local Docker recommended)
              </p>
            )}
          </div>

          <div className="space-y-1">
            <label className="text-xs font-medium text-text-secondary">API Key <span className="text-text-secondary/40">(optional)</span></label>
            <input
              type="password"
              value={apiKey}
              onChange={(e) => handleApiKeyChange(e.target.value)}
              placeholder="For private instances"
              className="w-full px-2 py-1.5 text-xs bg-background border border-border rounded outline-none focus:border-accent transition-colors"
            />
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={handleTest}
              disabled={testStatus === 'testing' || !endpoint.trim()}
              className="px-3 py-1.5 text-xs font-medium rounded border border-border bg-bg-tertiary hover:bg-bg-tertiary/80 text-text-primary transition-colors disabled:opacity-40 cursor-pointer disabled:cursor-not-allowed"
            >
              {testStatus === 'testing' ? 'Testing...' : 'Test Connection'}
            </button>
            {testStatus === 'ok' && <span className="text-xs text-green-400">Connected</span>}
            {testStatus === 'fail' && <span className="text-xs text-red-400">Connection failed</span>}
          </div>
        </div>
      </div>
    </div>
  );
}

export function SettingsPopup({ onClose }: { onClose: () => void }) {
  const [activeTab, setActiveTab] = useState<string>('info');
  const masterVolume = useStore((s) => s.masterVolume);
  const setMasterVolume = useStore((s) => s.setMasterVolume);

  return (
    <>
      <div
        className="fixed inset-0 z-40 backdrop-blur-sm bg-black/40"
        onClick={onClose}
      />

      <div
        className="fixed inset-0 z-50 flex items-center justify-center p-4 animate-[slideUp_0.3s_ease-out]"
        onClick={onClose}
      >
        <div
          className="bg-bg-secondary border border-border rounded-lg shadow-2xl overflow-hidden w-full max-w-5xl h-[50vh] flex flex-col"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center justify-between px-6 py-4 border-b border-border bg-bg-tertiary/50">
            <h2 className="text-lg font-semibold text-text-primary">Settings</h2>
            <button
              onClick={onClose}
              className="w-6 h-6 rounded-full border border-border text-text-secondary hover:border-white/30 hover:text-text-primary transition-colors flex items-center justify-center text-sm"
              title="Close settings"
            >
              ✕
            </button>
          </div>

          <div className="flex flex-1 min-h-0">
            <div className="w-48 border-r border-border bg-bg-tertiary/30 flex flex-col">
              {SECTIONS.map((section) => (
                <button
                  key={section.id}
                  onClick={() => setActiveTab(section.id)}
                  className={`px-4 py-3 text-sm text-left transition-colors border-l-2 cursor-pointer flex items-center gap-3 ${
                    activeTab === section.id
                      ? 'border-l-accent bg-bg-tertiary text-text-primary font-medium'
                      : 'border-l-transparent text-text-secondary hover:bg-bg-tertiary/50'
                  }`}
                >
                  <span className="flex-shrink-0">{renderIcon(section.icon)}</span>
                  {section.label}
                </button>
              ))}
            </div>

            <div className="flex-1 overflow-y-auto">
              {activeTab === 'info' && (
                <div className="p-6 space-y-6">
                  {/* Polyrhythmic Concept */}
                  <div>
                    <h3 className="text-sm font-semibold text-text-primary mb-3">Polyrhythmic Sequencing</h3>
                    <div className="space-y-2 text-xs text-text-secondary/70 leading-relaxed">
                      <p>
                        orbitrack creates complex rhythms by layering independent hit patterns across instruments. Each Orb (instrument) has its own hit count and step size, letting you build polyrhythms where patterns interlock at different intervals.
                      </p>
                      <p>
                        For example: a bass with 4 hits per 16-step loop, drums with 3 hits per 16 steps, and a synth with 5 hits creates a naturally cycling pattern that resolves after 16 steps.
                      </p>
                    </div>
                  </div>

                  {/* Scroll Adjustments */}
                  <div className="border-t border-border/30 pt-4">
                    <h3 className="text-sm font-semibold text-text-primary mb-3">Scroll Adjustments</h3>
                    <div className="space-y-3 text-xs text-text-secondary/70 leading-relaxed">
                      <div>
                        <div className="text-accent/80 font-mono mb-1">Hit Count:</div>
                        <div><span className="px-2 py-0.5 bg-bg-tertiary rounded border border-border/50 text-white/70 font-mono text-[10px]">Scroll</span> up/down anywhere on the Orb to add/remove hits in the current instrument.</div>
                      </div>
                      <div>
                        <div className="text-accent/80 font-mono mb-1">Step Count:</div>
                        <div>Hold <span className="text-accent/80 font-mono">Ctrl</span> while <span className="px-2 py-0.5 bg-bg-tertiary rounded border border-border/50 text-white/70 font-mono text-[10px]">scrolling</span> to adjust the loop length (number of steps displayed).</div>
                      </div>
                      <div>
                        <div className="text-accent/80 font-mono mb-1">Volume:</div>
                        <div>Hold <span className="text-accent/80 font-mono">Alt</span> while <span className="px-2 py-0.5 bg-bg-tertiary rounded border border-border/50 text-white/70 font-mono text-[10px]">scrolling</span> to adjust the instrument's volume in real-time.</div>
                      </div>
                      <div>
                        <div className="text-accent/80 font-mono mb-1">Velocity:</div>
                        <div>Hover over a note block and <span className="px-2 py-0.5 bg-bg-tertiary rounded border border-border/50 text-white/70 font-mono text-[10px]">scroll</span> to adjust that note's velocity (1-127). Enable the <span className="text-accent/80 font-mono">VEL</span> button to see velocity bars below the grid.</div>
                      </div>
                    </div>
                  </div>

                  {/* Velocity Controls */}
                  <div className="border-t border-border/30 pt-4">
                    <h3 className="text-sm font-semibold text-text-primary mb-3">Velocity (Piano Roll)</h3>
                    <div className="space-y-2 text-xs text-text-secondary/70">
                      <div><span className="text-accent/80 font-mono">VEL button</span> — Toggle velocity lane below grid</div>
                      <div><span className="text-accent/80 font-mono">Drag bars</span> — Adjust velocity (1-127)</div>
                      <div><span className="text-accent/80 font-mono">Hover + Scroll</span> — Change velocity on note</div>
                      <div className="mt-2">Note opacity reflects velocity. Velocity affects audio gain in samplers.</div>
                    </div>
                  </div>

                  {/* Scenes & Track View */}
                  <div className="border-t border-border/30 pt-4">
                    <h3 className="text-sm font-semibold text-text-primary mb-3">Scenes & Track View</h3>
                    <div className="space-y-3 text-xs text-text-secondary/70 leading-relaxed">
                      <div>
                        <div className="text-accent/80 font-mono mb-1">Creating Scenes:</div>
                        <div>Select one or more Orbs (Shift+Click), then press <span className="text-accent/80 font-mono">Ctrl+G</span> to group them into a Scene.</div>
                      </div>

                      <div>
                        <div className="text-accent/80 font-mono mb-1">Track View:</div>
                        <div>Click the <span className="text-accent/80 font-mono">TRACK</span> button in the bottom right to enter Track Mode. Drag scene blocks to arrange the order and length of each scene.</div>
                      </div>

                      <div>
                        <div className="text-accent/80 font-mono mb-1">Scene Controls:</div>
                        <div>Click to select, drag to reorder. Use the colored label to rename scenes.</div>
                      </div>
                    </div>
                  </div>

                  {/* MIDI Integration */}
                  <div className="border-t border-border/30 pt-4">
                    <h3 className="text-sm font-semibold text-text-primary mb-3">MIDI Input & Note Generation</h3>
                    <div className="space-y-2 text-xs text-text-secondary/70 leading-relaxed">
                      <p>
                        Connect a MIDI keyboard in the MIDI settings to play notes live. The piano roll automatically generates appropriate note numbers based on the selected instrument's voice and octave offset.
                      </p>
                      <p>
                        In the piano roll toolbar, use <span className="text-accent/80 font-mono">Base Oct</span> (0-8) to set the octave and <span className="text-accent/80 font-mono">Span</span> (1-4) to control the range of playable notes.
                      </p>
                      <p>
                        MIDI velocity from your keyboard is automatically captured and applied to each note, letting you perform with dynamic expression.
                      </p>
                    </div>
                  </div>
                </div>
              )}

              {activeTab === 'midi' && (
                <div className="p-6">
                  <h3 className="text-sm font-semibold text-text-primary mb-4">MIDI Configuration</h3>
                  <MidiSettingsPanel />
                </div>
              )}

              {activeTab === 'audio' && (
                <div className="p-6 space-y-6">
                  <div>
                    <h3 className="text-sm font-semibold text-text-primary mb-4">Audio Output</h3>

                    <div className="space-y-2">
                      <label className="text-xs font-medium text-text-secondary">Master Volume</label>
                      <div className="flex items-center gap-3">
                        <input
                          type="range"
                          min={0}
                          max={1}
                          step={0.01}
                          value={masterVolume}
                          onChange={(e) => setMasterVolume(parseFloat(e.target.value))}
                          className="flex-1 h-2 bg-bg-tertiary border border-border rounded cursor-pointer"
                          style={{ '--slider-color': '#94a3b8' } as React.CSSProperties}
                        />
                        <span className="text-xs font-mono text-text-secondary w-10 text-right">
                          {Math.round(masterVolume * 100)}%
                        </span>
                      </div>
                    </div>

                    <div className="mt-4">
                      <AudioOutputSection />
                    </div>

                    <div className="mt-2 p-3 bg-bg-tertiary/50 rounded border border-border/30">
                      <p className="text-xs text-text-secondary/70">
                        Audio context: <span className="font-mono text-accent">Web Audio API</span>
                      </p>
                      <p className="text-xs text-text-secondary/70 mt-1">
                        Output device selection requires Chrome 110+ or Edge 110+. Other browsers use the system default.
                      </p>
                    </div>
                  </div>

                  <AudioInputSection />
                </div>
              )}

              {activeTab === 'sources' && (
                <SourcesSettings />
              )}

              {activeTab === 'display' && (
                <DisplaySettings />
              )}

              {activeTab === 'log' && (
                <LogSettings />
              )}

              {activeTab === 'shortcuts' && (
                <div className="p-6 space-y-6">
                  {/* General Shortcuts */}
                  <div>
                    <h3 className="text-sm font-semibold text-text-primary mb-3">General Shortcuts</h3>
                    <div className="space-y-1 text-xs">
                      <div className="flex justify-between"><span className="text-accent/80 font-mono">Space</span><span>Play / Stop</span></div>
                      <div className="flex justify-between"><span className="text-accent/80 font-mono">Click ring</span><span>Add hit</span></div>
                      <div className="flex justify-between"><span className="text-accent/80 font-mono">Double-click hit</span><span>Remove hit</span></div>
                      <div className="flex justify-between"><span className="text-accent/80 font-mono">Drag hit</span><span>Reposition hit</span></div>
                      <div className="flex justify-between"><span className="text-accent/80 font-mono">Scroll</span><span>Adjust hit count</span></div>
                      <div className="flex justify-between"><span className="text-accent/80 font-mono">Ctrl + Scroll</span><span>Adjust step count</span></div>
                      <div className="flex justify-between"><span className="text-accent/80 font-mono">Alt + Scroll</span><span>Adjust volume</span></div>
                      <div className="flex justify-between"><span className="text-accent/80 font-mono">Shift + Scroll</span><span>Zoom grid view</span></div>
                      <div className="flex justify-between"><span className="text-accent/80 font-mono">S button</span><span>Solo instrument</span></div>
                      <div className="flex justify-between"><span className="text-accent/80 font-mono">M button</span><span>Mute instrument</span></div>
                      <div className="flex justify-between"><span className="text-accent/80 font-mono">Shift + Click</span><span>Select multiple Orbs</span></div>
                      <div className="flex justify-between"><span className="text-accent/80 font-mono">Ctrl + G</span><span>Group Orbs to Scene</span></div>
                      <div className="flex justify-between"><span className="text-accent/80 font-mono">Shift + Ctrl + G</span><span>Ungroup</span></div>
                      <div className="flex justify-between"><span className="text-accent/80 font-mono">Ctrl + Z</span><span>Undo</span></div>
                      <div className="flex justify-between"><span className="text-accent/80 font-mono">Ctrl + Shift + Z</span><span>Redo</span></div>
                      <div className="flex justify-between"><span className="text-accent/80 font-mono">Enter</span><span>Rename selected</span></div>
                      <div className="flex justify-between"><span className="text-accent/80 font-mono">Delete / Backspace</span><span>Delete selected</span></div>
                      <div className="flex justify-between"><span className="text-accent/80 font-mono">Ctrl + Shift + P</span><span>Toggle Performance Monitor</span></div>
                    </div>
                  </div>

                  {/* Live Mode */}
                  <div className="border-t border-border/30 pt-4">
                    <h3 className="text-sm font-semibold text-text-primary mb-3">Live Mode</h3>
                    <div className="space-y-1 text-xs">
                      <div className="flex justify-between"><span className="text-accent/80 font-mono">1 – 9</span><span>Launch scene by index</span></div>
                      <div className="flex justify-between"><span className="text-accent/80 font-mono">0 / Escape</span><span>Stop live scene</span></div>
                    </div>
                  </div>

                  {/* Piano Keys */}
                  <div className="border-t border-border/30 pt-4">
                    <h3 className="text-sm font-semibold text-text-primary mb-3">Piano Keys (Synth selected)</h3>
                    <div className="space-y-2">
                      {/* Black keys */}
                      <div className="flex gap-1 items-start text-xs">
                        {[['W','C#'],['E','D#']].map(([k,n])=>(
                          <div key={k} className="text-center">
                            <div className="bg-accent/20 border border-accent/40 rounded px-2 py-0.5 text-accent/80 font-mono">{k}</div>
                            <div className="text-text-secondary/60 text-[10px] mt-0.5">{n}</div>
                          </div>
                        ))}
                        <div className="w-3" />
                        {[['T','F#'],['Y','G#'],['U','A#']].map(([k,n])=>(
                          <div key={k} className="text-center">
                            <div className="bg-accent/20 border border-accent/40 rounded px-2 py-0.5 text-accent/80 font-mono">{k}</div>
                            <div className="text-text-secondary/60 text-[10px] mt-0.5">{n}</div>
                          </div>
                        ))}
                      </div>
                      {/* White keys */}
                      <div className="flex gap-1 items-start text-xs">
                        {[['A','C'],['S','D'],['D','E'],['F','F'],['G','G'],['H','A'],['J','B']].map(([k,n])=>(
                          <div key={k+n} className="text-center">
                            <div className="bg-accent/10 border border-accent/30 rounded px-2 py-0.5 text-accent/80 font-mono">{k}</div>
                            <div className="text-text-secondary/60 text-[10px] mt-0.5">{n}</div>
                          </div>
                        ))}
                      </div>
                      {/* Octave & velocity */}
                      <div className="flex gap-1 items-start text-xs pt-1">
                        <div className="text-center">
                          <div className="bg-blue-500/20 border border-blue-500/40 rounded px-1.5 py-0.5 text-blue-400/80 font-mono">Z</div>
                          <div className="text-text-secondary/60 text-[10px] mt-0.5">Oct-</div>
                        </div>
                        <div className="text-center">
                          <div className="bg-blue-500/20 border border-blue-500/40 rounded px-1.5 py-0.5 text-blue-400/80 font-mono">X</div>
                          <div className="text-text-secondary/60 text-[10px] mt-0.5">Oct+</div>
                        </div>
                        <div className="w-3" />
                        <div className="text-center">
                          <div className="bg-red-500/20 border border-red-500/40 rounded px-1.5 py-0.5 text-red-400/80 font-mono">C</div>
                          <div className="text-text-secondary/60 text-[10px] mt-0.5">Vel-</div>
                        </div>
                        <div className="text-center">
                          <div className="bg-red-500/20 border border-red-500/40 rounded px-1.5 py-0.5 text-red-400/80 font-mono">V</div>
                          <div className="text-text-secondary/60 text-[10px] mt-0.5">Vel+</div>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Scenes & Track View */}
                  <div className="border-t border-border/30 pt-4">
                    <h3 className="text-sm font-semibold text-text-primary mb-3">Scenes & Track View</h3>
                    <div className="space-y-3 text-xs text-text-secondary leading-relaxed">
                      <div>
                        <div className="text-accent/80 font-mono mb-0.5">Creating Scenes:</div>
                        <div>Select one or more Orbs (Shift+Click), then press <span className="text-accent/80 font-mono">Ctrl+G</span> to group them into a Scene. Scenes appear as colored blocks at the bottom.</div>
                      </div>
                      <div>
                        <div className="text-accent/80 font-mono mb-0.5">Track View:</div>
                        <div>Click the <span className="text-accent/80">TRACK</span> button to enter Track Mode. Drag scene blocks in the timeline to arrange the order and length of each scene. Each scene bar shows how many bars it loops for.</div>
                      </div>
                      <div>
                        <div className="text-accent/80 font-mono mb-0.5">Scene Controls:</div>
                        <div>Within each scene block: Click to select, drag to reorder, use the colored label to rename. Right-click to remove from scene.</div>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {activeTab === 'storage' && (
                <StorageSettings />
              )}

              {activeTab === 'about' && (
                <div className="p-6 space-y-6">
                  <div>
                    <h3 className="text-sm font-semibold text-text-primary mb-2">orbitrack</h3>
                    <p className="text-xs text-text-secondary/70">Polyrhythmic Web Sequencer</p>
                    <p className="text-xs text-text-secondary/50 mt-2">v0.1.0</p>
                  </div>

                  <div className="space-y-2 text-xs text-text-secondary/70 pt-4 border-t border-border/30">
                    <p className="font-mono">
                      Built with <span className="text-accent">React</span>, <span className="text-accent">Tone.js</span>, <span className="text-accent">Web Audio API</span>
                    </p>
                    <p className="mt-2">
                      Audio synthesis powered by <span className="text-accent">superdough</span>
                    </p>
                    <p className="mt-2">
                      State management with <span className="text-accent">Zustand</span>
                    </p>
                  </div>

                  <div className="pt-4 border-t border-border/30">
                    <p className="text-xs text-text-secondary/50">
                      🎵 Create, perform, and share polyrhythmic sequences in your browser
                    </p>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

// ── Display Settings Tab ─────────────────────────────────────────────────────

const ORB_MODES: { id: 'classic' | 'led' | 'rotate' | 'chase'; label: string; desc: string }[] = [
  { id: 'chase', label: 'Chase', desc: 'Fixed dot ring — colored hits chase clockwise through the grid' },
  { id: 'classic', label: 'Classic', desc: 'Smooth dots on a ring with trigger line' },
  { id: 'led', label: 'LED', desc: 'Fixed grid of LED dots that light up on hits' },
  { id: 'rotate', label: 'Dot Ring', desc: 'Fixed circle of dots — colored hits rotate past bottom indicator' },
];

function LogSettings() {
  const logEnabled = useStore((s) => s.logEnabled);
  const setLogEnabled = useStore((s) => s.setLogEnabled);
  const showLogConsole = useStore((s) => s.showLogConsole);
  const setShowLogConsole = useStore((s) => s.setShowLogConsole);
  const showPerformanceMonitor = useStore((s) => s.showPerformanceMonitor);
  const setShowPerformanceMonitor = useStore((s) => s.setShowPerformanceMonitor);
  const [bufferCount, setBufferCount] = useState(log.getCount());
  const [sessionDur, setSessionDur] = useState(0);
  const [snapshots, setSnapshots] = useState(log.getSnapshotCount());

  useEffect(() => {
    const iv = setInterval(() => {
      setBufferCount(log.getCount());
      setSessionDur(log.getSessionDuration());
      setSnapshots(log.getSnapshotCount());
    }, 1000);
    return () => clearInterval(iv);
  }, []);

  const fmtDuration = (ms: number) => {
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    const h = Math.floor(m / 60);
    if (h > 0) return `${h}h ${m % 60}m ${s % 60}s`;
    if (m > 0) return `${m}m ${s % 60}s`;
    return `${s}s`;
  };

  const btnClass = 'px-3 py-1.5 text-xs font-medium rounded border border-border bg-bg-tertiary hover:bg-bg-tertiary/80 text-text-primary transition-colors cursor-pointer';

  return (
    <div className="p-6 space-y-6">
      <div>
        <h3 className="text-sm font-semibold text-text-primary mb-1">Log & Diagnostics</h3>
        <p className="text-xs text-text-secondary/50 mb-4">Structured logging for performance analysis and debugging</p>

        <div className="space-y-3">
          <label className="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={logEnabled}
              onChange={(e) => setLogEnabled(e.target.checked)}
              className="accent-accent w-3.5 h-3.5"
            />
            <div>
              <span className="text-xs text-text-primary font-medium">Enable Logging</span>
              <p className="text-[10px] text-text-secondary/50 mt-0.5">Captures engine events, performance data, and state changes</p>
            </div>
          </label>

          <label className="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={showLogConsole}
              onChange={(e) => setShowLogConsole(e.target.checked)}
              className="accent-accent w-3.5 h-3.5"
            />
            <div>
              <span className="text-xs text-text-primary font-medium">Show Console Panel</span>
              <p className="text-[10px] text-text-secondary/50 mt-0.5">Display the log console at the bottom of the screen</p>
            </div>
          </label>
        </div>
      </div>

      {/* Diagnostics */}
      <div className="border-t border-border/30 pt-4">
        <h3 className="text-xs font-semibold text-text-secondary/70 uppercase tracking-wider mb-3">Diagnostics</h3>
        <label className="flex items-center gap-3 p-3 bg-bg-tertiary/50 rounded border border-border/30 cursor-pointer">
          <input
            type="checkbox"
            checked={showPerformanceMonitor}
            onChange={(e) => setShowPerformanceMonitor(e.target.checked)}
            className="accent-accent w-3.5 h-3.5"
          />
          <div>
            <span className="text-xs text-text-primary font-medium">Performance Monitor</span>
            <p className="text-[10px] text-text-secondary/50 mt-0.5">Show FPS, audio latency, and voice count in Effects panel</p>
          </div>
        </label>
      </div>

      {/* Session Stats */}
      <div className="border-t border-border/30 pt-4">
        <h3 className="text-xs font-semibold text-text-secondary/70 uppercase tracking-wider mb-3">Session Stats</h3>
        <div className="grid grid-cols-3 gap-3">
          <div className="bg-bg-tertiary/30 rounded-lg p-3 text-center">
            <div className="text-lg font-mono text-accent">{bufferCount.toLocaleString()}</div>
            <div className="text-[10px] text-text-secondary/50 mt-0.5">/ 5,000 entries</div>
          </div>
          <div className="bg-bg-tertiary/30 rounded-lg p-3 text-center">
            <div className="text-lg font-mono text-text-primary">{logEnabled ? fmtDuration(sessionDur) : '—'}</div>
            <div className="text-[10px] text-text-secondary/50 mt-0.5">session duration</div>
          </div>
          <div className="bg-bg-tertiary/30 rounded-lg p-3 text-center">
            <div className="text-lg font-mono text-[#a78bfa]">{snapshots}</div>
            <div className="text-[10px] text-text-secondary/50 mt-0.5">perf snapshots</div>
          </div>
        </div>
      </div>

      {/* Actions */}
      <div className="border-t border-border/30 pt-4">
        <h3 className="text-xs font-semibold text-text-secondary/70 uppercase tracking-wider mb-3">Actions</h3>
        <div className="flex flex-wrap gap-2">
          <button
            className={btnClass}
            onClick={() => log.takePerformanceSnapshot()}
            disabled={!logEnabled}
            style={{ opacity: logEnabled ? 1 : 0.4 }}
          >
            Take Snapshot
          </button>
          <button className={btnClass} onClick={() => log.downloadAsJSON()} disabled={bufferCount === 0} style={{ opacity: bufferCount > 0 ? 1 : 0.4 }}>
            Download JSON
          </button>
          <button className={btnClass} onClick={() => log.downloadAsText()} disabled={bufferCount === 0} style={{ opacity: bufferCount > 0 ? 1 : 0.4 }}>
            Download TXT
          </button>
          <button
            className={`${btnClass} ${bufferCount > 0 ? 'hover:border-red-400/50 hover:text-red-400' : ''}`}
            onClick={() => { log.clear(); setBufferCount(0); }}
            disabled={bufferCount === 0}
            style={{ opacity: bufferCount > 0 ? 1 : 0.4 }}
          >
            Clear Logs
          </button>
        </div>
      </div>

      {/* Info */}
      <div className="border-t border-border/30 pt-4">
        <div className="text-[10px] text-text-secondary/40 space-y-1 font-mono">
          <p>Ring buffer: 5,000 entries max (oldest overwritten)</p>
          <p>Perf snapshots: auto every 30s when logging is active</p>
          <p>Zero overhead when disabled — all log calls are no-ops</p>
        </div>
      </div>
    </div>
  );
}

function DisplaySettings() {
  const orbitDisplayMode = useStore((s) => s.orbitDisplayMode);
  const setOrbitDisplayMode = useStore((s) => s.setOrbitDisplayMode);

  return (
    <div className="p-6 space-y-6">
      {/* Orb Appearance */}
      <div>
        <h3 className="text-sm font-semibold text-text-primary mb-1">Orb Display Mode</h3>
        <p className="text-xs text-text-secondary/50 mb-4">Choose how instrument orbs render hits</p>

        <div className="grid grid-cols-4 gap-3">
          {ORB_MODES.map((mode) => (
            <button
              key={mode.id}
              onClick={() => setOrbitDisplayMode(mode.id)}
              className={`p-4 rounded-lg border text-left transition-all cursor-pointer ${
                orbitDisplayMode === mode.id
                  ? 'border-accent bg-accent/10'
                  : 'border-border/50 bg-bg-tertiary/30 hover:bg-bg-tertiary/60'
              }`}
            >
              {/* Preview icon */}
              <div className="mb-3 flex justify-center">
                <OrbPreview mode={mode.id} active={orbitDisplayMode === mode.id} />
              </div>
              <p className={`text-xs font-medium ${orbitDisplayMode === mode.id ? 'text-accent' : 'text-text-primary'}`}>
                {mode.label}
              </p>
              <p className="text-[10px] text-text-secondary/50 mt-0.5 leading-snug">{mode.desc}</p>
            </button>
          ))}
        </div>
      </div>

      {/* Theme */}
      <div className="border-t border-border/30 pt-4">
        <h3 className="text-sm font-semibold text-text-primary mb-4">Theme</h3>
        <div className="flex items-center justify-between p-3 bg-bg-tertiary/50 rounded border border-border/30">
          <div>
            <p className="text-xs font-medium text-text-primary">Dark Theme</p>
            <p className="text-xs text-text-secondary/60 mt-0.5">Always enabled</p>
          </div>
          <span className="text-sm text-accent">●</span>
        </div>
      </div>

      {/* Canvas */}
      <div className="border-t border-border/30 pt-4">
        <h3 className="text-sm font-semibold text-text-primary mb-4">Canvas</h3>
        <div className="space-y-2">
          <label className="text-xs font-medium text-text-secondary">Resolution</label>
          <div className="p-3 bg-bg-tertiary/50 rounded border border-border/30 text-xs text-text-secondary/70 font-mono">
            <p>Canvas resolution automatically adapts to your screen DPI</p>
            <p className="mt-1">Current: {window.devicePixelRatio.toFixed(2)}x</p>
          </div>
        </div>
      </div>

    </div>
  );
}

/** Tiny canvas-like SVG preview of the orb mode */
function OrbPreview({ mode, active }: { mode: 'classic' | 'led' | 'rotate' | 'chase'; active: boolean }) {
  const accent = active ? '#6d8cff' : '#64748b';
  const dim = active ? 'rgba(255,255,255,0.12)' : 'rgba(255,255,255,0.06)';
  const r = 22; // ring radius
  const cx = 28;
  const cy = 28;
  const steps = 12;

  if (mode === 'led') {
    // LED mode: fixed grid of dots, some lit
    const litSteps = new Set([0, 3, 5, 8, 11]);
    const triggeredStep = 3;
    return (
      <svg width="56" height="56" viewBox="0 0 56 56">
        <circle cx={cx} cy={cy} r={r} fill="none" stroke={dim} strokeWidth="1" />
        {Array.from({ length: steps }, (_, i) => {
          const angle = (i / steps) * Math.PI * 2 - Math.PI / 2;
          const x = cx + Math.cos(angle) * r;
          const y = cy + Math.sin(angle) * r;
          const isLit = litSteps.has(i);
          const isTriggered = i === triggeredStep;
          return (
            <circle
              key={i}
              cx={x}
              cy={y}
              r={isTriggered ? 3.5 : isLit ? 3 : 2}
              fill={isTriggered ? '#ffffff' : isLit ? accent : dim}
            />
          );
        })}
      </svg>
    );
  }

  if (mode === 'rotate') {
    // Rotate mode: fixed dots, colored ones shifted, indicator at bottom
    const litDisplaySteps = new Set([1, 4, 6, 9]);
    return (
      <svg width="56" height="56" viewBox="0 0 56 56">
        <circle cx={cx} cy={cy} r={r} fill="none" stroke={dim} strokeWidth="1" />
        {Array.from({ length: steps }, (_, i) => {
          const angle = (i / steps) * Math.PI * 2 - Math.PI / 2;
          const x = cx + Math.cos(angle) * r;
          const y = cy + Math.sin(angle) * r;
          const isLit = litDisplaySteps.has(i);
          return (
            <circle
              key={i}
              cx={x}
              cy={y}
              r={isLit ? 3 : 2}
              fill={isLit ? accent : dim}
            />
          );
        })}
        {/* Fixed indicator line at bottom (6 o'clock) */}
        <line
          x1={cx}
          y1={cy + r + 2}
          x2={cx}
          y2={cy + r + 8}
          stroke={active ? '#ffffff' : '#94a3b8'}
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      </svg>
    );
  }

  if (mode === 'chase') {
    // Chase mode: all dots visible as gray, hits colored
    const litDisplaySteps = new Set([1, 4, 6, 9]);
    return (
      <svg width="56" height="56" viewBox="0 0 56 56">
        {Array.from({ length: steps }, (_, i) => {
          const angle = (i / steps) * Math.PI * 2 - Math.PI / 2;
          const x = cx + Math.cos(angle) * r;
          const y = cy + Math.sin(angle) * r;
          const isLit = litDisplaySteps.has(i);
          return (
            <circle
              key={i}
              cx={x}
              cy={y}
              r={isLit ? 3 : 2.5}
              fill={isLit ? accent : (active ? 'rgba(180,180,190,0.35)' : 'rgba(140,140,150,0.25)')}
            />
          );
        })}
        <line
          x1={cx}
          y1={cy + r + 2}
          x2={cx}
          y2={cy + r + 8}
          stroke={active ? '#ffffff' : '#94a3b8'}
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      </svg>
    );
  }

  // Classic mode: smooth dots on ring
  const hitAngles = [0, 0.25, 0.42, 0.67, 0.92];
  return (
    <svg width="56" height="56" viewBox="0 0 56 56">
      <circle cx={cx} cy={cy} r={r} fill="none" stroke={dim} strokeWidth="1" />
      {hitAngles.map((frac, i) => {
        const angle = frac * Math.PI * 2 - Math.PI / 2;
        const x = cx + Math.cos(angle) * r;
        const y = cy + Math.sin(angle) * r;
        return <circle key={i} cx={x} cy={y} r={2.5} fill={accent} />;
      })}
      {/* Trigger line */}
      <line
        x1={cx}
        y1={cy - r + 5}
        x2={cx}
        y2={cy - r - 3}
        stroke={accent}
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

// ── Storage Settings Tab ──────────────────────────────────────────────────────

function StorageSettings() {
  const [enabled, setEnabled] = useState(getAutosaveEnabled);
  const [interval, setInterval_] = useState(getAutosaveInterval);
  const [initialAutosave, setInitialAutosave_] = useState(getInitialAutosave);

  const handleToggle = (checked: boolean) => {
    setEnabled(checked);
    setAutosaveEnabled(checked);
  };

  const handleInterval = (ms: number) => {
    setInterval_(ms);
    setAutosaveInterval(ms);
  };

  const handleInitialAutosave = (checked: boolean) => {
    setInitialAutosave_(checked);
    setInitialAutosave(checked);
  };

  return (
    <div className="p-6 space-y-6">
      <div>
        <h3 className="text-sm font-semibold text-text-primary mb-4">Autosave</h3>
        <div className="space-y-4">
          <label className="flex items-center gap-2.5 cursor-pointer">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => handleToggle(e.target.checked)}
              className="accent-accent w-3.5 h-3.5"
            />
            <span className="text-xs text-text-secondary">Enable autosave</span>
          </label>

          <label className="flex items-center gap-2.5 cursor-pointer">
            <input
              type="checkbox"
              checked={initialAutosave}
              onChange={(e) => handleInitialAutosave(e.target.checked)}
              disabled={!enabled}
              className="accent-accent w-3.5 h-3.5"
            />
            <span className={`text-xs ${enabled ? 'text-text-secondary' : 'text-text-secondary/40'}`}>
              Autosave before first manual save
            </span>
          </label>

          <div className="space-y-1.5">
            <label className="text-[11px] font-medium text-text-secondary/60 uppercase tracking-wider">
              Autosave interval
            </label>
            <select
              value={interval}
              onChange={(e) => handleInterval(Number(e.target.value))}
              disabled={!enabled}
              className="w-full px-3 py-2 text-xs bg-bg-tertiary text-text-primary border border-border rounded outline-none focus:border-accent disabled:opacity-40 transition-opacity"
            >
              <option value={5000}>5s</option>
              <option value={30000}>30s</option>
              <option value={60000}>1 min</option>
              <option value={300000}>5 min</option>
              <option value={900000}>15 min</option>
              <option value={1800000}>30 min</option>
              <option value={3600000}>60 min</option>
              <option value={0}>Never</option>
            </select>
          </div>

          <p className="text-[11px] text-text-secondary/40 leading-relaxed">
            Each autosave creates a version snapshot you can restore from My Sets. Enable "before first manual save" to also autosave new unsaved projects.
          </p>
        </div>
      </div>

      <div className="pt-4 border-t border-border/30">
        <h3 className="text-sm font-semibold text-text-primary mb-3">Version History</h3>
        <p className="text-[11px] text-text-secondary/40 leading-relaxed">
          Manual saves create named versions. Autosave keeps a single rolling snapshot between manual saves. Up to 50 versions per set.
        </p>
      </div>
    </div>
  );
}
