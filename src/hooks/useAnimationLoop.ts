import { useEffect, useRef } from 'react';

export interface FrameInfo {
  /** Monotonic frame count since the loop started */
  frame: number;
  /** Seconds elapsed since last callback invocation */
  dt: number;
  /** Timestamp from requestAnimationFrame (performance.now based) */
  timestamp: number;
}

export type FrameCallback = (info: FrameInfo) => void;

export interface UseAnimationLoopOptions {
  /** Target frames per second. Default: 60 */
  targetFps?: number;
  /** Element ref for IntersectionObserver — pauses drawing when off-screen */
  visibilityRef?: React.RefObject<HTMLElement | null>;
  /** Whether the loop is enabled. Default: true */
  enabled?: boolean;
}

/**
 * Shared requestAnimationFrame hook with FPS throttling and visibility pausing.
 *
 * - Callback is stored in a ref so changes never restart the loop.
 * - FPS throttling uses a 1ms tolerance to prevent float-jitter frame drops.
 * - When targetFps >= display rate (~60), no throttling is applied at all.
 * - IntersectionObserver skips the callback when the element is fully off-screen.
 * - The RAF loop itself keeps running (cheap boolean check) for instant resume.
 */
export function useAnimationLoop(
  callback: FrameCallback,
  options: UseAnimationLoopOptions = {},
) {
  const { targetFps = 60, visibilityRef, enabled = true } = options;

  const cbRef = useRef(callback);
  cbRef.current = callback;

  const targetFpsRef = useRef(targetFps);
  targetFpsRef.current = targetFps;

  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  useEffect(() => {
    let rafId = 0;
    let frame = 0;
    let lastTime = 0;
    let visible = true;

    // ── IntersectionObserver for visibility pausing ──
    let observer: IntersectionObserver | null = null;
    const el = visibilityRef?.current;
    if (el) {
      observer = new IntersectionObserver(
        ([entry]) => { visible = entry.intersectionRatio > 0; },
        { threshold: 0 },
      );
      observer.observe(el);
    }

    // ── RAF loop ──
    const loop = (timestamp: number) => {
      rafId = requestAnimationFrame(loop);

      if (!enabledRef.current || !visible) return;

      const fps = targetFpsRef.current;

      // No throttling when target >= 60 — let every rAF frame through
      if (fps < 60) {
        const interval = 1000 / fps;
        const elapsed = timestamp - lastTime;
        // 1ms tolerance prevents float-jitter frame skips
        if (elapsed < interval - 1) return;
      }

      const dt = lastTime > 0 ? (timestamp - lastTime) / 1000 : 0;
      lastTime = timestamp;
      frame++;

      cbRef.current({ frame, dt, timestamp });
    };

    rafId = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(rafId);
      observer?.disconnect();
    };
  }, []); // stable — all mutable values read from refs
}
