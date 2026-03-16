import { useCallback, useRef } from 'react';
import { useStore } from '../state/store';

type Edge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

const MIN_W = 460;
const MIN_H = 340;

export function useFloatResize() {
  const dragRef = useRef<{
    edge: Edge; startX: number; startY: number;
    origX: number; origY: number; origW: number; origH: number;
  } | null>(null);

  const onEdgeMouseDown = useCallback((edge: Edge, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const { synthFloatPos: pos, synthFloatSize: size } = useStore.getState();
    dragRef.current = {
      edge, startX: e.clientX, startY: e.clientY,
      origX: pos.x, origY: pos.y, origW: size.w, origH: size.h,
    };

    const onMove = (ev: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const dx = ev.clientX - d.startX;
      const dy = ev.clientY - d.startY;

      let { origX: x, origY: y, origW: w, origH: h } = d;

      if (d.edge.includes('e')) w = Math.max(MIN_W, w + dx);
      if (d.edge.includes('s')) h = Math.max(MIN_H, h + dy);
      if (d.edge.includes('w')) {
        const newW = Math.max(MIN_W, w - dx);
        x = x + (w - newW);
        w = newW;
      }
      if (d.edge.includes('n')) {
        const newH = Math.max(MIN_H, h - dy);
        y = y + (h - newH);
        h = newH;
      }

      // Clamp to viewport
      w = Math.min(w, window.innerWidth);
      h = Math.min(h, window.innerHeight);
      x = Math.max(0, Math.min(x, window.innerWidth - 200));
      y = Math.max(0, Math.min(y, window.innerHeight - 40));

      const store = useStore.getState();
      store.setSynthFloatPos({ x, y });
      store.setSynthFloatSize({ w, h });
    };

    const onUp = () => {
      dragRef.current = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, []);

  return { onEdgeMouseDown };
}
