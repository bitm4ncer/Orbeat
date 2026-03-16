import { useEffect, useRef } from 'react';
import { getMasterAnalyser } from '../../audio/routingEngine';
import { useAnimationLoop } from '../../hooks/useAnimationLoop';

const CANVAS_H = 30;

export function WaveformView({ isRecording = false }: { isRecording?: boolean }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null);
  const widthRef = useRef(240);
  const recordingRef = useRef(isRecording);
  recordingRef.current = isRecording;

  // History buffer + write index stored in refs
  const historyRef = useRef<Float32Array | null>(null);
  const writeIdxRef = useRef(0);
  const dataBufferRef = useRef<Float32Array | null>(null);

  // ResizeObserver for responsive width
  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const syncSize = () => {
      const W = Math.round(container.clientWidth) || 240;
      if (W === widthRef.current && historyRef.current) return;
      widthRef.current = W;
      canvas.width = W;
      canvas.height = CANVAS_H;
      historyRef.current = new Float32Array(W);
      writeIdxRef.current = 0;
    };
    syncSize();

    ctxRef.current = canvas.getContext('2d');

    const ro = new ResizeObserver(() => syncSize());
    ro.observe(container);
    return () => ro.disconnect();
  }, []);

  useAnimationLoop(
    () => {
      const analyser = getMasterAnalyser();
      const ctx = ctxRef.current;
      const W = widthRef.current;
      const history = historyRef.current;
      if (!ctx || !history) return;

      // Sample current peak level
      let peak = 0;
      if (analyser) {
        if (!dataBufferRef.current || dataBufferRef.current.length !== analyser.fftSize) {
          dataBufferRef.current = new Float32Array(analyser.fftSize);
        }
        analyser.getFloatTimeDomainData(dataBufferRef.current as Float32Array<ArrayBuffer>);
        for (let i = 0; i < dataBufferRef.current.length; i++) {
          const abs = Math.abs(dataBufferRef.current[i]);
          if (abs > peak) peak = abs;
        }
      }

      // Push into circular buffer
      history[writeIdxRef.current] = Math.min(peak, 1);
      writeIdxRef.current = (writeIdxRef.current + 1) % W;

      // Draw — scrolls right to left, newest on the right
      ctx.clearRect(0, 0, W, CANVAS_H);

      // Subtle center line
      ctx.fillStyle = 'rgba(255,255,255,0.03)';
      ctx.fillRect(0, CANVAS_H / 2, W, 1);

      const halfH = CANVAS_H / 2;

      for (let x = 0; x < W; x++) {
        const idx = (writeIdxRef.current + x) % W;
        const level = history[idx];
        if (level < 0.002) continue;

        const barH = level * halfH * 0.92;
        const y = halfH - barH;

        const age = x / W;
        const alpha = 0.08 + age * 0.25;
        const rgb = recordingRef.current ? '220, 60, 60' : '148, 163, 184';
        ctx.fillStyle = `rgba(${rgb}, ${alpha})`;
        ctx.fillRect(x, y, 1, barH * 2);
      }
    },
    { targetFps: 30, visibilityRef: containerRef },
  );

  return (
    <div ref={containerRef} className="w-full flex-1 min-w-0">
      <canvas
        ref={canvasRef}
        height={CANVAS_H}
        className="w-full block"
        style={{ imageRendering: 'auto' }}
      />
    </div>
  );
}
