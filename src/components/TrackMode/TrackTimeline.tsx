import React, { useState, useRef, useEffect } from 'react';
import { useStore } from '../../state/store';
import type { InstrumentScene } from '../../types/scene';
import { MiniOrb } from '../shared/MiniOrb';

const BLOCK_H = 150; // pixels, 250% of original ~60px

interface SceneBlockProps {
  step: { id: string; sceneId: string; bars: number };
  scene: InstrumentScene;
  isSelected: boolean;
  isPlaying: boolean;
  occurrenceIndex: number;
  totalOccurrences: number;
  barPx: number;
  onSelect: () => void;
  onDelete: () => void;
  onResize: (newBars: number) => void;
  onDragStart: (e: React.DragEvent) => void;
}

function SceneBlock({
  step,
  scene,
  isSelected,
  isPlaying,
  occurrenceIndex,
  totalOccurrences,
  barPx,
  onSelect,
  onDelete,
  onResize,
  onDragStart,
}: SceneBlockProps) {
  const [isResizing, setIsResizing] = useState(false);
  const [resizeStart, setResizeStart] = useState(0);
  const [originalBars, setOriginalBars] = useState(0);

  const handleResizeMouseDown = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    setIsResizing(true);
    setResizeStart(e.clientX);
    setOriginalBars(step.bars);
  };

  React.useEffect(() => {
    if (!isResizing) return;

    const handleMouseMove = (e: MouseEvent) => {
      const delta = e.clientX - resizeStart;
      const barDelta = Math.round(delta / barPx);
      const newBars = Math.max(1, Math.min(64, originalBars + barDelta));
      onResize(newBars);
    };

    const handleMouseUp = () => {
      setIsResizing(false);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isResizing, resizeStart, originalBars, onResize, barPx]);

  return (
    <div
      draggable
      onDragStart={(e) => {
        if (!isResizing) {
          onDragStart(e);
        } else {
          e.preventDefault();
        }
      }}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Delete') {
          onDelete();
        }
      }}
      tabIndex={0}
      className={`relative flex flex-col cursor-move select-none transition-all rounded border overflow-visible shadow-none
        ${isPlaying ? 'ring-2 ring-yellow-400' : ''}`}
      style={{
        width: `${step.bars * barPx}px`,
        minHeight: BLOCK_H,
        backgroundColor: scene.color + '99',
        borderColor: isSelected ? 'rgba(255, 255, 255, 0.6)' : 'rgba(255, 255, 255, 0.2)',
        borderWidth: isSelected ? '2px' : '1px',
        boxShadow: 'none !important',
        filter: 'none',
      }}
    >
      {/* Header row */}
      <div className="flex items-center gap-2 px-3 py-2 flex-shrink-0">
        <div className="flex flex-col flex-1 min-w-0">
          {/* Scene name */}
          <span className="text-sm font-semibold truncate">{scene.name}</span>
        </div>

        {/* Bar count badge */}
        <span className="text-xs font-mono bg-black/30 px-1.5 py-0.5 rounded whitespace-nowrap flex-shrink-0">
          {step.bars} bar{step.bars !== 1 ? 's' : ''}
        </span>

        {/* Delete button */}
        {isSelected && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
            className="p-0.5 hover:bg-black/30 rounded transition-colors flex-shrink-0"
            title="Delete (Delete key)"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor">
              <path d="M1 3h12v1H1V3zm2-2h8v1H3V1zm0 4v7c0 .55.45 1 1 1h6c.55 0 1-.45 1-1V5H3z" />
            </svg>
          </button>
        )}
      </div>

      {/* Mini orbs grid */}
      <div className="flex flex-wrap gap-1 overflow-hidden flex-1 px-2 pb-2 pt-1 items-start content-start">
        {scene.instrumentIds.map(instId => (
          <MiniOrb key={instId} instrumentId={instId} isSelected={isSelected} />
        ))}
      </div>

      {/* Resize handle */}
      <div
        onMouseDown={handleResizeMouseDown}
        onDragStart={(e) => e.preventDefault()}
        draggable={false}
        className="absolute right-0 top-0 bottom-0 w-2 cursor-col-resize hover:w-3 bg-white/40 hover:bg-white/80 transition-all pointer-events-auto z-10"
        style={{
          marginRight: '-4px',
          paddingRight: '4px',
        }}
        title="Drag to resize (1-64 bars)"
      />

      {/* Multi-scene occurrence indicators */}
      {totalOccurrences > 1 && (
        <div className="absolute -bottom-2 left-0 right-0 flex flex-col gap-0.5 items-center justify-center px-1 pointer-events-none">
          {Array.from({ length: totalOccurrences }).map((_, idx) => (
            <div
              key={idx}
              className={`w-1 rounded-full transition-all ${
                idx === occurrenceIndex ? 'h-2 bg-white' : 'h-1 bg-white/40'
              }`}
              title={`Occurrence ${idx + 1} of ${totalOccurrences}`}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function TrackTimeline() {
  const scenes = useStore((s) => s.scenes);
  const arrangement = useStore((s) => s.arrangement);
  const trackPosition = useStore((s) => s.trackPosition);
  const trackStepProgress = useStore((s) => s.trackStepProgress);
  const addArrangementStep = useStore((s) => s.addArrangementStep);
  const removeArrangementStep = useStore((s) => s.removeArrangementStep);
  const reorderArrangementSteps = useStore((s) => s.reorderArrangementSteps);
  const setArrangementStepBars = useStore((s) => s.setArrangementStepBars);
  const duplicateArrangementStep = useStore((s) => s.duplicateArrangementStep);
  const selectScene = useStore((s) => s.selectScene);

  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);
  const [clipboard, setClipboard] = useState<{ id: string; sceneId: string; bars: number } | null>(null);
  const [showSceneDropdown, setShowSceneDropdown] = useState(false);
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const [barPx, setBarPx] = useState(60); // 20–200 range
  const barPxRef = useRef(60);

  useEffect(() => {
    barPxRef.current = barPx;
  }, [barPx]);

  const zoom = (delta: number) => {
    setBarPx(prev => Math.round(Math.max(20, Math.min(200, prev + delta)) / 10) * 10);
  };

  const handleAddScene = (sceneId: string) => {
    addArrangementStep(sceneId, 4);
    setShowSceneDropdown(false);
  };

  const handleDelete = (stepId: string) => {
    removeArrangementStep(stepId);
    if (selectedStepId === stepId) {
      setSelectedStepId(null);
    }
  };

  const handleCopy = () => {
    if (!selectedStepId) return;
    const step = arrangement.find((s) => s.id === selectedStepId);
    if (step) {
      setClipboard(step);
    }
  };

  const handlePaste = () => {
    if (!clipboard) return;
    duplicateArrangementStep(clipboard.id);
  };

  // Keyboard shortcuts (copy/paste/delete + zoom)
  React.useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Skip when the piano roll is focused — it handles its own shortcuts
      if ((document.activeElement as HTMLElement)?.closest?.('[data-piano-roll]')) return;

      // Zoom shortcuts
      if ((e.ctrlKey || e.metaKey) && (e.key === '=' || e.key === '+')) {
        e.preventDefault();
        zoom(+10);
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key === '-') {
        e.preventDefault();
        zoom(-10);
        return;
      }

      // Copy/paste/delete (need selected step)
      if (!selectedStepId) return;

      if ((e.ctrlKey || e.metaKey) && e.key === 'c') {
        e.preventDefault();
        handleCopy();
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'v') {
        e.preventDefault();
        handlePaste();
      }
      if (e.key === 'Delete') {
        e.preventDefault();
        handleDelete(selectedStepId);
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [selectedStepId, clipboard, arrangement]);

  // Close dropdowns on click outside
  React.useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setShowSceneDropdown(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Wheel handler: Ctrl+Scroll = zoom, plain scroll = horizontal scroll
  useEffect(() => {
    const el = scrollAreaRef.current;
    if (!el) return;

    const handler = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const delta = e.deltaY > 0 ? -10 : +10;
        setBarPx(prev => Math.round(Math.max(20, Math.min(200, prev + delta)) / 10) * 10);
      } else {
        e.preventDefault();
        el.scrollLeft += e.deltaY;
      }
    };

    el.addEventListener('wheel', handler, { passive: false });
    return () => el.removeEventListener('wheel', handler);
  }, []);

  const handleDragStart = (index: number, e: React.DragEvent) => {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(index));
  };

  const handleDragOver = (index: number, e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragOverIndex(index);
  };

  const handleDrop = (toIndex: number, e: React.DragEvent) => {
    e.preventDefault();
    const fromIndexStr = e.dataTransfer.getData('text/plain');
    const fromIndex = parseInt(fromIndexStr, 10);

    if (!isNaN(fromIndex) && fromIndex !== toIndex) {
      reorderArrangementSteps(fromIndex, toIndex);
    }

    setDragOverIndex(null);
  };

  const handleDragLeave = () => {
    setDragOverIndex(null);
  };

  // Playhead dragging
  const [isDraggingPlayhead, setIsDraggingPlayhead] = useState(false);

  const handlePlayheadMouseDown = (e: React.MouseEvent) => {
    setIsDraggingPlayhead(true);
    e.preventDefault();
  };

  React.useEffect(() => {
    if (!isDraggingPlayhead) return;

    const handleMouseMove = (e: MouseEvent) => {
      const scrollArea = scrollAreaRef.current;
      if (!scrollArea) return;

      const rect = scrollArea.getBoundingClientRect();
      const relativeX = e.clientX - rect.left + scrollArea.scrollLeft;

      // Find which scene and progress within that scene
      let accumulatedX = 0;
      for (let i = 0; i < arrangement.length; i++) {
        const sceneWidth = arrangement[i].bars * barPx;
        if (relativeX < accumulatedX + sceneWidth) {
          // Found the scene
          const positionInScene = relativeX - accumulatedX;
          const progress = Math.max(0, Math.min(1, positionInScene / sceneWidth));

          // Update playhead position
          useStore.getState().setTrackPosition(i);
          useStore.getState().setTrackStepProgress(progress);

          // Auto-scroll to keep playhead visible
          const playheadScreenX = accumulatedX + progress * sceneWidth - scrollArea.scrollLeft;
          if (playheadScreenX < 50) {
            scrollArea.scrollLeft = Math.max(0, accumulatedX + progress * sceneWidth - 50);
          } else if (playheadScreenX > rect.width - 50) {
            scrollArea.scrollLeft = accumulatedX + progress * sceneWidth - (rect.width - 50);
          }
          return;
        }
        accumulatedX += sceneWidth;
      }
    };

    const handleMouseUp = () => {
      setIsDraggingPlayhead(false);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDraggingPlayhead, arrangement, barPx]);

  // Calculate playhead position with smooth progress within current step
  const playheadX =
    trackPosition >= 0 && arrangement.length > 0
      ? arrangement.slice(0, trackPosition).reduce((sum, step) => sum + step.bars * barPx, 0) +
        (arrangement[trackPosition]?.bars ?? 0) * barPx * trackStepProgress
      : 0;

  // Show all scenes - they can be added multiple times to the arrangement
  const availableScenes = scenes;

  return (
    <div className="flex flex-col bg-background border-t border-border">
      {/* Toolbar */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-border bg-background/50">
        {/* Add Scene Button */}
        <div className="relative" ref={dropdownRef}>
          <button
            onClick={() => setShowSceneDropdown(!showSceneDropdown)}
            className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium bg-primary text-primary-foreground rounded hover:bg-primary/90 transition-colors"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <path d="M8 2v12M2 8h12" stroke="currentColor" strokeWidth="2" fill="none" />
            </svg>
            Add Scene
            <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor">
              <path d="M3.5 5.5l3.5 4 3.5-4" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>

          {showSceneDropdown && (
            <div className="absolute top-full left-0 mt-1 bg-popover border border-border rounded shadow-lg z-50 min-w-max">
              {availableScenes.length > 0 ? (
                availableScenes.map((scene) => (
                  <button
                    key={scene.id}
                    onClick={() => handleAddScene(scene.id)}
                    className="w-full text-left px-3 py-2 text-sm transition-colors flex items-center gap-2 hover:opacity-80"
                    style={{ backgroundColor: scene.color + '1a' }}
                  >
                    <div
                      className="w-2 h-2 rounded-full"
                      style={{
                        backgroundColor: scene.color,
                      }}
                    />
                    {scene.name}
                  </button>
                ))
              ) : (
                <div className="px-3 py-2 text-xs text-muted-foreground whitespace-nowrap">
                  Create scenes in Instrument Rack first
                </div>
              )}
            </div>
          )}
        </div>

        {/* Scene palette chips */}
        <div className="flex items-center gap-1 flex-1 overflow-x-auto">
          {scenes.map((scene) => (
            <button
              key={scene.id}
              onClick={() => handleAddScene(scene.id)}
              className="px-2 py-1 rounded text-xs font-medium whitespace-nowrap transition-colors hover:opacity-100 cursor-pointer active:scale-95"
              style={{
                backgroundColor: scene.color + '4d',
                color: 'white',
                opacity: 0.75,
              }}
              title={`Click to add "${scene.name}" to arrangement`}
            >
              {scene.name}
            </button>
          ))}
        </div>

        {/* Zoom controls */}
        <div className="flex items-center gap-1 ml-auto flex-shrink-0">
          <button
            onClick={() => zoom(-10)}
            className="px-2 py-1 text-xs rounded hover:bg-white/10 transition-colors font-semibold"
            title="Zoom out (Ctrl+-)"
          >
            −
          </button>
          <span className="text-xs font-mono w-8 text-center text-muted-foreground">{barPx}</span>
          <button
            onClick={() => zoom(+10)}
            className="px-2 py-1 text-xs rounded hover:bg-white/10 transition-colors font-semibold"
            title="Zoom in (Ctrl++)"
          >
            +
          </button>
        </div>
      </div>

      {/* Timeline scroll area */}
      <div
        ref={scrollAreaRef}
        className="overflow-x-auto overflow-y-hidden bg-background/50 relative flex-shrink-0"
        style={{ height: BLOCK_H + 20 }}
      >
        {/* Playhead scrubber handle */}
        {trackPosition >= 0 && arrangement.length > 0 && (
          <div
            onMouseDown={handlePlayheadMouseDown}
            className="absolute top-0 cursor-col-resize z-30 pointer-events-auto"
            style={{
              left: `${playheadX - 6}px`,
              transition: isDraggingPlayhead ? 'none' : 'left 41.66ms linear',
            }}
            title="Drag to seek"
          >
            {/* Downward arrow */}
            <div className="w-0 h-0 border-l-3 border-r-3 border-t-4 border-l-transparent border-r-transparent border-t-white mx-auto"
              style={{ marginLeft: '3px' }}
            />
            {/* Scrubber line */}
            <div
              className="w-px bg-white opacity-50"
              style={{
                height: `${BLOCK_H + 20}px`,
                marginLeft: '5.5px',
              }}
            />
          </div>
        )}

        {/* Arrangement blocks container */}
        <div className={`flex gap-2 p-2 ${arrangement.length > 0 ? 'min-w-min' : 'h-full'}`}>
          {arrangement.length > 0 ? (
            arrangement.map((step, idx) => {
              const scene = scenes.find((s) => s.id === step.sceneId);
              if (!scene) return null;

              // Count occurrences of this scene in the arrangement
              const occurrenceIndex = arrangement.slice(0, idx).filter((s) => s.sceneId === step.sceneId).length;
              const totalOccurrences = arrangement.filter((s) => s.sceneId === step.sceneId).length;

              return (
                <div
                  key={step.id}
                  onDragOver={(e) => handleDragOver(idx, e)}
                  onDrop={(e) => handleDrop(idx, e)}
                  onDragLeave={handleDragLeave}
                  className={`transition-all ${dragOverIndex === idx ? 'opacity-50' : 'opacity-100'}`}
                >
                  <SceneBlock
                    step={step}
                    scene={scene}
                    isSelected={selectedStepId === step.id}
                    isPlaying={trackPosition === idx}
                    occurrenceIndex={occurrenceIndex}
                    totalOccurrences={totalOccurrences}
                    barPx={barPx}
                    onSelect={() => {
                      setSelectedStepId(step.id);
                      selectScene(step.sceneId);
                    }}
                    onDelete={() => handleDelete(step.id)}
                    onResize={(newBars) => setArrangementStepBars(step.id, newBars)}
                    onDragStart={(e) => handleDragStart(idx, e)}
                  />
                </div>
              );
            })
          ) : (
            <div className="flex items-center justify-center w-full h-full text-text-secondary/30 text-sm">
              {scenes.length === 0
                ? 'No scenes \u2014 select instruments and press Ctrl+G to create a scene'
                : 'No arrangement steps. Click "Add Scene" to get started.'}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
