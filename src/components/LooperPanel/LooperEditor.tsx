import { useEffect, useRef, useState, useCallback } from 'react';
import { useStore } from '../../state/store';
import { LooperToolbar } from './LooperToolbar';
import { Knob } from './Knob';
import { DEFAULT_LOOPER_PARAMS } from '../../types/looper';

const HANDLE_ZONE_HEIGHT = 14; // only top 14px is the drag handle for markers

export function LooperEditor() {
  const selectedId = useStore((s) => s.selectedInstrumentId);
  const instruments = useStore((s) => s.instruments);
  const instrument = instruments.find((i) => i.id === selectedId);
  const editor = useStore((s) => selectedId ? s.looperEditors[selectedId] : undefined);
  const instrumentProgress = useStore((s) => selectedId ? s.instrumentProgress[selectedId] ?? 0 : 0);
  const isPlaying = useStore((s) => s.isPlaying);

  const setLooperZoom = useStore((s) => s.setLooperZoom);
  const updateLooperParams = useStore((s) => s.updateLooperParams);
  const setLoopSize = useStore((s) => s.setLoopSize);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef<number>(0);
  const dragRef = useRef<{ type: 'loopIn' | 'loopOut'; startNorm: number } | null>(null);
  const drawRef = useRef<() => void>(() => {});

  const [cursorStyle, setCursorStyle] = useState<string>('crosshair');

  const color = instrument?.color ?? '#7dd3fc';
  const viewStart = editor?.viewStart ?? 0;
  const viewEnd = editor?.viewEnd ?? 1;
  const viewRange = viewEnd - viewStart;

  // Convert canvas x to normalized position [0..1] in the full buffer
  const xToNorm = useCallback((clientX: number): number => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return 0;
    const localX = (clientX - rect.left) / rect.width;
    return viewStart + localX * viewRange;
  }, [viewStart, viewRange]);

  // ── Main draw function ──
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Ensure correct DPR transform before every draw
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const width = canvas.offsetWidth;
    const height = canvas.offsetHeight;
    ctx.clearRect(0, 0, width, height);

    // Background
    ctx.fillStyle = '#0d0d18';
    ctx.fillRect(0, 0, width, height);

    if (!editor?.peaks || !instrument) {
      ctx.fillStyle = 'rgba(255,255,255,0.1)';
      ctx.font = '12px monospace';
      ctx.textAlign = 'center';
      ctx.fillText(
        editor?.audioBuffer ? 'Processing...' : 'No loop loaded — select a loop from the browser',
        width / 2, height / 2,
      );
      return;
    }

    const peaks = editor.peaks;
    const RULER_HEIGHT = 18; // step ruler at top
    const mid = (height + RULER_HEIGHT) / 2;
    const waveTop = RULER_HEIGHT;
    const waveHeight = height - RULER_HEIGHT;
    const halfWave = waveHeight * 0.45; // max amplitude from center
    const loopIn = editor.loopIn ?? 0;
    const loopOut = editor.loopOut ?? 1;
    const hasLoop = loopIn > 0 || loopOut < 1;
    const regionSize = loopOut - loopIn;
    const loopSize = instrument.loopSize;
    const stepsPerBeat = Math.max(1, Math.round(loopSize / 4));
    const isStretched = instrument.looperParams?.stretchToSteps ?? false;
    const barW = Math.max(1, width / peaks.length * (1 / viewRange));

    // ── Step ruler background ──
    ctx.fillStyle = '#0a0a14';
    ctx.fillRect(0, 0, width, RULER_HEIGHT);
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, RULER_HEIGHT); ctx.lineTo(width, RULER_HEIGHT); ctx.stroke();

    // ── Beat grid lines + step ruler labels ──
    const stepsInView = loopSize * viewRange;
    const showAllStepNums = stepsInView <= 64; // show step numbers when not too dense
    const showBeatNums = stepsInView <= 256;

    for (let step = 0; step <= loopSize; step++) {
      const norm = step / loopSize;
      if (norm < viewStart - 0.01 || norm > viewEnd + 0.01) continue;
      const x = ((norm - viewStart) / viewRange) * width;
      const isBar = step % (stepsPerBeat * 4) === 0;
      const isBeat = step % stepsPerBeat === 0;

      // Grid lines in waveform area
      if (isBar && step > 0) {
        ctx.strokeStyle = 'rgba(255,255,255,0.20)';
        ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(x, RULER_HEIGHT); ctx.lineTo(x, height); ctx.stroke();
      } else if (isBeat) {
        ctx.strokeStyle = 'rgba(255,255,255,0.10)';
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(x, RULER_HEIGHT); ctx.lineTo(x, height); ctx.stroke();
      } else {
        ctx.strokeStyle = 'rgba(255,255,255,0.04)';
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(x, RULER_HEIGHT); ctx.lineTo(x, height); ctx.stroke();
      }

      // Ruler tick marks + labels
      if (isBar) {
        const barNum = Math.floor(step / (stepsPerBeat * 4)) + 1;
        ctx.strokeStyle = 'rgba(255,255,255,0.3)';
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, RULER_HEIGHT); ctx.stroke();
        ctx.fillStyle = 'rgba(255,255,255,0.5)';
        ctx.font = '9px monospace';
        ctx.textAlign = 'left';
        ctx.fillText(`${barNum}`, x + 3, 11);
      } else if (isBeat && showBeatNums) {
        ctx.strokeStyle = 'rgba(255,255,255,0.15)';
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(x, RULER_HEIGHT - 6); ctx.lineTo(x, RULER_HEIGHT); ctx.stroke();
        if (showAllStepNums) {
          const beatInBar = Math.floor((step % (stepsPerBeat * 4)) / stepsPerBeat) + 1;
          ctx.fillStyle = 'rgba(255,255,255,0.25)';
          ctx.font = '7px monospace';
          ctx.textAlign = 'center';
          ctx.fillText(`.${beatInBar}`, x, 11);
        }
      } else if (showAllStepNums && stepsInView <= 32) {
        // Small tick for sub-beat steps when zoomed in
        ctx.strokeStyle = 'rgba(255,255,255,0.08)';
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(x, RULER_HEIGHT - 3); ctx.lineTo(x, RULER_HEIGHT); ctx.stroke();
      }
    }

    // ── Stretch mode indicator on ruler ──
    if (isStretched) {
      ctx.fillStyle = 'rgba(34, 211, 238, 0.12)';
      ctx.fillRect(0, 0, width, RULER_HEIGHT);
      ctx.fillStyle = 'rgba(34, 211, 238, 0.5)';
      ctx.font = '8px monospace';
      ctx.textAlign = 'right';
      ctx.fillText('STRETCH', width - 4, 11);
    }

    // ── Steps count badge ──
    ctx.fillStyle = 'rgba(255,255,255,0.2)';
    ctx.font = '8px monospace';
    ctx.textAlign = 'left';
    ctx.fillText(`${loopSize} steps`, 4, 11);

    // ── Loop region dimming (outside loop is darkened) ──
    if (hasLoop) {
      const inX = ((loopIn - viewStart) / viewRange) * width;
      const outX = ((loopOut - viewStart) / viewRange) * width;
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      if (inX > 0) ctx.fillRect(0, waveTop, Math.max(0, inX), waveHeight);
      if (outX < width) ctx.fillRect(Math.min(width, outX), waveTop, width - Math.min(width, outX), waveHeight);
    }

    // ── Waveform scaling ──
    // When stretch is OFF: scale by detectedLoopSize/loopSize and pitch
    // When stretch is ON: sample fills grid but pitch still affects visual length
    const detectedLS = instrument.detectedLoopSize ?? loopSize;
    const pitchRatio = Math.pow(2, (instrument.looperParams?.pitchSemitones ?? 0) / 12);
    const baseScale = isStretched ? 1 : detectedLS / loopSize;
    const sampleScale = baseScale / pitchRatio; // pitch up = shorter, pitch down = longer

    // ── Waveform rendering — simple unwarped at buffer positions ──
    for (let i = 0; i < peaks.length; i++) {
      const bufNorm = i / peaks.length; // position in buffer [0..1]
      const displayNorm = bufNorm * sampleScale; // scaled position in grid
      if (displayNorm < viewStart - 0.01 || displayNorm > viewEnd + 0.01) continue;
      const x = ((displayNorm - viewStart) / viewRange) * width;
      const amp = peaks[i] * halfWave;
      const outsideLoop = hasLoop && (displayNorm < loopIn || displayNorm > loopOut);
      if (outsideLoop) {
        ctx.fillStyle = `${color}22`;
      } else {
        ctx.fillStyle = `${color}88`;
      }
      ctx.fillRect(x, mid - amp, barW * sampleScale, amp * 2 || 1);
    }

    // ── Empty zone dimming (when sample doesn't fill full grid) ──
    if (sampleScale < 1) {
      const emptyStartX = ((sampleScale - viewStart) / viewRange) * width;
      if (emptyStartX < width) {
        ctx.fillStyle = 'rgba(0,0,0,0.25)';
        ctx.fillRect(Math.max(0, emptyStartX), waveTop, width - Math.max(0, emptyStartX), waveHeight);
        // Dashed separator line at sample boundary
        ctx.strokeStyle = 'rgba(255,255,255,0.15)';
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);
        ctx.beginPath(); ctx.moveTo(emptyStartX, waveTop); ctx.lineTo(emptyStartX, height); ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    // ── Center line ──
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, mid); ctx.lineTo(width, mid); ctx.stroke();

    // ── Loop in/out markers ──
    if (hasLoop) {
      const drawLoopMarker = (norm: number, label: string, isIn: boolean) => {
        if (norm < viewStart || norm > viewEnd) return;
        const x = ((norm - viewStart) / viewRange) * width;

        // Vertical line
        ctx.strokeStyle = '#22d3ee';
        ctx.lineWidth = 2;
        ctx.setLineDash([]);
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke();

        // Bracket handle at top
        ctx.fillStyle = '#22d3ee';
        ctx.beginPath();
        if (isIn) {
          ctx.moveTo(x, 0); ctx.lineTo(x + 10, 0); ctx.lineTo(x, HANDLE_ZONE_HEIGHT);
        } else {
          ctx.moveTo(x, 0); ctx.lineTo(x - 10, 0); ctx.lineTo(x, HANDLE_ZONE_HEIGHT);
        }
        ctx.closePath();
        ctx.fill();

        // Label at bottom
        ctx.font = '8px monospace';
        ctx.textAlign = 'center';
        ctx.fillStyle = '#22d3ee';
        ctx.fillText(label, x, height - 3);
      };
      drawLoopMarker(loopIn, 'I', true);
      drawLoopMarker(loopOut, 'O', false);

      // Loop region top/bottom accent lines
      const inX = Math.max(0, ((loopIn - viewStart) / viewRange) * width);
      const outX = Math.min(width, ((loopOut - viewStart) / viewRange) * width);
      if (outX > inX) {
        ctx.fillStyle = 'rgba(34, 211, 238, 0.15)';
        ctx.fillRect(inX, 0, outX - inX, 1);
        ctx.fillRect(inX, height - 1, outX - inX, 1);
      }
    }

    // ── Playhead ──
    if (isPlaying) {
      const playNorm = instrumentProgress;
      if (playNorm >= viewStart && playNorm <= viewEnd) {
        const px = ((playNorm - viewStart) / viewRange) * width;
        // Playhead glow
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
        ctx.lineWidth = 5;
        ctx.beginPath(); ctx.moveTo(px, waveTop); ctx.lineTo(px, height); ctx.stroke();
        // Playhead line
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(px, waveTop); ctx.lineTo(px, height); ctx.stroke();
        // Playhead triangle at top of waveform area
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.moveTo(px - 4, waveTop); ctx.lineTo(px + 4, waveTop); ctx.lineTo(px, waveTop + 6);
        ctx.closePath();
        ctx.fill();
      }
    }

    // ── Info overlay: loop region size ──
    if (hasLoop) {
      const regionSteps = Math.round(regionSize * loopSize);
      const regionBeats = (regionSteps / stepsPerBeat).toFixed(1);
      ctx.fillStyle = 'rgba(34, 211, 238, 0.4)';
      ctx.font = '9px monospace';
      ctx.textAlign = 'left';
      const inX = ((loopIn - viewStart) / viewRange) * width;
      if (inX > 0 && inX < width - 60) {
        ctx.fillText(`${regionBeats} beats`, inX + 4, HANDLE_ZONE_HEIGHT + 10);
      }
    }
  }, [editor, instrument, color, viewStart, viewRange, viewEnd, isPlaying, instrumentProgress]);

  // Keep drawRef in sync
  drawRef.current = draw;

  // ── Resize observer (stable — does NOT depend on draw) ──
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const handleResize = () => {
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(canvas.offsetWidth * dpr);
      canvas.height = Math.round(canvas.offsetHeight * dpr);
      drawRef.current();
    };

    const ro = new ResizeObserver(handleResize);
    ro.observe(canvas);
    handleResize(); // initial setup
    return () => ro.disconnect();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Redraw on state changes (when not playing) ──
  useEffect(() => {
    if (!isPlaying) draw();
  }, [draw, isPlaying]);

  // ── Animation loop during playback ──
  useEffect(() => {
    if (!isPlaying) return;
    const animate = () => {
      draw();
      rafRef.current = requestAnimationFrame(animate);
    };
    rafRef.current = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(rafRef.current);
  }, [isPlaying, draw]);

  // ── Mouse down: loop handle dragging only ──
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (!selectedId || !instrument || !editor) return;
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const clickX = e.clientX - rect.left;
    const clickY = e.clientY - rect.top;
    const norm = xToNorm(e.clientX);
    const inHandleZone = clickY < HANDLE_ZONE_HEIGHT;

    const loopIn = editor.loopIn ?? 0;
    const loopOut = editor.loopOut ?? 1;
    const hasLoop = loopIn > 0 || loopOut < 1;

    // Only drag loop handles from the triangle handle zone (top ~14px)
    if (inHandleZone && hasLoop) {
      const inX = ((loopIn - viewStart) / viewRange) * rect.width;
      const outX = ((loopOut - viewStart) / viewRange) * rect.width;
      if (Math.abs(clickX - inX) < 10) {
        dragRef.current = { type: 'loopIn', startNorm: norm };
        setCursorStyle('grabbing');
        return;
      }
      if (Math.abs(clickX - outX) < 10) {
        dragRef.current = { type: 'loopOut', startNorm: norm };
        setCursorStyle('grabbing');
        return;
      }
    }
  }, [selectedId, instrument, editor, xToNorm, viewStart, viewRange]);

  // ── Canvas mouse move: update cursor based on hover target ──
  const handleCanvasMouseMove = useCallback((e: React.MouseEvent) => {
    // During drag, show grabbing cursor for loop handles
    if (dragRef.current) {
      setCursorStyle('grabbing');
      return;
    }
    if (!editor || !instrument) { setCursorStyle('crosshair'); return; }
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;
    const inHandleZone = mouseY < HANDLE_ZONE_HEIGHT;
    const loopIn = editor.loopIn ?? 0;
    const loopOut = editor.loopOut ?? 1;
    const hasLoop = loopIn > 0 || loopOut < 1;

    if (inHandleZone && hasLoop) {
      const inX = ((loopIn - viewStart) / viewRange) * rect.width;
      const outX = ((loopOut - viewStart) / viewRange) * rect.width;
      if (Math.abs(mouseX - inX) < 10 || Math.abs(mouseX - outX) < 10) {
        setCursorStyle('grab');
        return;
      }
    }
    setCursorStyle('crosshair');
  }, [editor, instrument, viewStart, viewRange]);

  // ── Global mouse move/up ──
  useEffect(() => {
    const setLooperLoop = useStore.getState().setLooperLoop;

    const handleMove = (e: MouseEvent) => {
      if (!dragRef.current || !selectedId) return;
      const norm = xToNorm(e.clientX);

      if (dragRef.current.type === 'loopIn') {
        const editor = useStore.getState().looperEditors[selectedId];
        const loopOut = editor?.loopOut ?? 1;
        setLooperLoop(selectedId, Math.min(norm, loopOut - 0.005), loopOut);
      } else if (dragRef.current.type === 'loopOut') {
        const editor = useStore.getState().looperEditors[selectedId];
        const loopIn = editor?.loopIn ?? 0;
        setLooperLoop(selectedId, loopIn, Math.max(norm, loopIn + 0.005));
      }
    };
    const handleUp = () => {
      setCursorStyle('crosshair');
      dragRef.current = null;
    };
    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
    return () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
    };
  }, [selectedId, xToNorm]);

  // ── Mouse wheel: zoom (native listener to allow preventDefault on non-passive) ──
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!selectedId) return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();

      const mouseNorm = xToNorm(e.clientX);
      const zoomFactor = e.deltaY > 0 ? 1.15 : 0.87;
      const curRange = viewEnd - viewStart;
      const newRange = Math.min(1, Math.max(0.02, curRange * zoomFactor));

      const mouseRatio = (e.clientX - rect.left) / rect.width;
      let newStart = mouseNorm - mouseRatio * newRange;
      let newEnd = newStart + newRange;

      if (newStart < 0) { newEnd -= newStart; newStart = 0; }
      if (newEnd > 1) { newStart -= (newEnd - 1); newEnd = 1; }
      newStart = Math.max(0, newStart);
      newEnd = Math.min(1, newEnd);

      setLooperZoom(selectedId, newStart, newEnd);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [selectedId, xToNorm, viewStart, viewEnd, setLooperZoom]);

  if (!instrument || instrument.type !== 'looper' || !selectedId) return null;

  const lp = { ...DEFAULT_LOOPER_PARAMS, ...instrument?.looperParams };

  return (
    <div className="flex-1 flex flex-col bg-bg min-w-0 h-full outline-none">
      <LooperToolbar
        instrumentId={selectedId}
        color={color}
      />
      <div ref={containerRef} className="flex-1 relative min-h-0">
        <canvas
          ref={canvasRef}
          className="w-full h-full"
          style={{ cursor: cursorStyle }}
          onMouseDown={handleMouseDown}
          onMouseMove={handleCanvasMouseMove}
        />
      </div>
      {/* Knob bar */}
      <div className="flex items-center justify-around px-4 py-2 border-t border-border/50 shrink-0 bg-bg-secondary">
        <Knob label="Loop Steps" value={instrument.loopSize} min={1} max={64} step={1} decimals={0} color={color} size={52}
          onChange={(v) => setLoopSize(selectedId, v)} />
        <Knob label="Vol" value={lp.gain} min={0} max={1} decimals={2} color={color} size={36}
          onChange={(v) => updateLooperParams(selectedId, { gain: v })} />
        <Knob label="Pitch" value={lp.pitchSemitones} min={-24} max={24} step={1} decimals={0} unit="st" color={color} size={36}
          onChange={(v) => updateLooperParams(selectedId, { pitchSemitones: v })} />
        <Knob label="A" value={lp.attack} min={0} max={2} decimals={3} unit="s" color={color} size={36}
          onChange={(v) => updateLooperParams(selectedId, { attack: v })} />
        <Knob label="R" value={lp.release} min={0} max={2} decimals={3} unit="s" color={color} size={36}
          onChange={(v) => updateLooperParams(selectedId, { release: v })} />
        <Knob label="Pan" value={lp.pan} min={-1} max={1} decimals={2} color={color} size={36}
          onChange={(v) => updateLooperParams(selectedId, { pan: v })} />
        <Knob label="Cutoff" value={lp.cutoff} min={20} max={20000} step={10} decimals={0} unit="Hz" color={color} size={36}
          onChange={(v) => updateLooperParams(selectedId, { cutoff: v })} />
        <Knob label="Res" value={lp.resonance} min={0} max={50} decimals={1} color={color} size={36}
          onChange={(v) => updateLooperParams(selectedId, { resonance: v })} />
        <Knob label="Phase" value={lp.startOffset} min={0} max={1} decimals={2} color={color} size={36}
          onChange={(v) => updateLooperParams(selectedId, { startOffset: v })} />
      </div>
    </div>
  );
}
