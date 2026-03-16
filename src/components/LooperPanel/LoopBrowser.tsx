import { useEffect, useRef, useState, useCallback, useId, useMemo } from 'react';
import { useStore } from '../../state/store';
import { fetchLoopTree } from '../../audio/loopApi';
import { previewSample, stopPreview } from '../../audio/sampler';
import { getAllCachedBpms } from '../../audio/bpmCache';
import type { SampleEntry } from '../../audio/sampleApi';
import { extractAudioFromUrl } from '../../audio/videoImport';
import { getCobaltEndpoint, getCobaltApiKey } from '../../storage/cobaltSettings';

export function LoopBrowser() {
  const selectedId = useStore((s) => s.selectedInstrumentId);
  const instruments = useStore((s) => s.instruments);
  const customSamples = useStore((s) => s.customSamples);
  const targetInst = instruments.find((i) => i.id === selectedId);

  const assignLoop = useStore((s) => s.assignLoop);
  const addCustomSample = useStore((s) => s.addCustomSample);
  const [tree, setTree] = useState<SampleEntry[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [focusIdx, setFocusIdx] = useState(-1);
  const [searchQuery, setSearchQuery] = useState('');
  const [previewingUrl, setPreviewingUrl] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const fileInputId = useId();

  // URL import state
  const [showUrlInput, setShowUrlInput] = useState(false);
  const [urlValue, setUrlValue] = useState('');
  const [urlLoading, setUrlLoading] = useState(false);
  const [urlError, setUrlError] = useState<string | null>(null);
  const [urlSuccess, setUrlSuccess] = useState(false);
  const urlAbortRef = useRef<AbortController | null>(null);

  // Build BPM lookup from both localStorage cache and currently loaded instruments
  const bpmMap = useMemo(() => {
    const map: Record<string, number> = { ...getAllCachedBpms() };
    // Also include BPMs from loaded instruments (more up-to-date)
    for (const inst of instruments) {
      if (inst.samplePath && inst.detectedBpm && inst.detectedBpm > 0) {
        map[inst.samplePath] = inst.detectedBpm;
      }
    }
    return map;
  }, [instruments]);

  useEffect(() => {
    fetchLoopTree().then(setTree);
  }, []);

  useEffect(() => () => { stopPreview(); }, []);

  const flatList = useCallback(() => {
    const result: { entry: SampleEntry; depth: number }[] = [];
    const walk = (entries: SampleEntry[], depth: number) => {
      for (const e of entries) {
        result.push({ entry: e, depth });
        if (e.type === 'folder' && expanded.has(e.path) && e.children) {
          walk(e.children, depth + 1);
        }
      }
    };
    walk(tree, 0);

    // Also show imported loops
    const importedLoops = customSamples.filter((c) => c.key.startsWith('__imported_loop__/'));
    if (importedLoops.length > 0) {
      const folder: SampleEntry = {
        name: 'Imported', path: '__imported_loops__', type: 'folder',
        children: importedLoops.map((c) => ({ name: c.name, path: c.key, type: 'file' as const })),
      };
      walk([folder], 0);
    }

    // Show URL-imported samples
    const importedUrls = customSamples.filter((c) => c.key.startsWith('__imported_url__/'));
    if (importedUrls.length > 0) {
      const folder: SampleEntry = {
        name: 'Imported (URL)', path: '__imported_urls__', type: 'folder',
        children: importedUrls.map((c) => ({ name: c.name, path: c.key, type: 'file' as const })),
      };
      walk([folder], 0);
    }

    return result;
  }, [tree, expanded, customSamples]);

  const visible = flatList();

  const searchResults = useMemo(() => {
    if (!searchQuery.trim()) return null;
    const q = searchQuery.trim().toLowerCase();
    const matches: { entry: SampleEntry; depth: number }[] = [];
    const walk = (entries: SampleEntry[]) => {
      for (const e of entries) {
        if (e.type === 'file' && e.name.toLowerCase().includes(q)) matches.push({ entry: e, depth: 0 });
        if (e.type === 'folder' && e.children) walk(e.children);
      }
    };
    walk(tree);
    return matches;
  }, [searchQuery, tree]);

  const displayList = searchResults ?? visible;

  const toggleFolder = (path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path); else next.add(path);
      return next;
    });
  };

  const handlePreview = (key: string) => {
    if (previewingUrl === key) { stopPreview(); setPreviewingUrl(null); }
    else {
      const cs = customSamples.find((c) => c.key === key);
      previewSample(cs ? cs.url : key);
      setPreviewingUrl(key);
    }
  };

  const handleAssign = (entry: SampleEntry) => {
    if (!selectedId || entry.type !== 'file') return;
    const displayName = entry.name.replace(/\.[^.]+$/, '');
    assignLoop(selectedId, entry.path, displayName);
  };

  const handleFileImport = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    for (const file of files) {
      const url = URL.createObjectURL(file);
      const name = file.name.replace(/\.[^.]+$/, '');
      const key = `__imported_loop__/${name}_${Date.now()}`;
      addCustomSample({ key, url, name });
      // Auto-assign if we have a selection
      if (selectedId) {
        assignLoop(selectedId, key, name);
      }
    }
    e.target.value = '';
  };

  const handleUrlImport = async () => {
    const endpoint = getCobaltEndpoint();
    if (!endpoint) { setUrlError('Configure a cobalt endpoint in Settings > Sources'); return; }
    if (!urlValue.trim()) return;

    setUrlLoading(true);
    setUrlError(null);
    urlAbortRef.current = new AbortController();

    try {
      const result = await extractAudioFromUrl(urlValue.trim(), {
        apiEndpoint: endpoint,
        apiKey: getCobaltApiKey() || undefined,
        signal: urlAbortRef.current.signal,
      });

      const url = URL.createObjectURL(result.blob);
      const name = result.filename.replace(/\.[^.]+$/, '') || 'url-import';
      const key = `__imported_url__/${name}_${Date.now()}`;
      addCustomSample({ key, url, name });

      if (selectedId) assignLoop(selectedId, key, name);

      setUrlValue('');
      setUrlSuccess(true);
      setTimeout(() => setUrlSuccess(false), 2500);
    } catch (e: unknown) {
      if ((e as Error).name !== 'AbortError') {
        setUrlError((e as Error).message || 'Import failed');
      }
    } finally {
      setUrlLoading(false);
      urlAbortRef.current = null;
    }
  };

  const handleUrlCancel = () => {
    urlAbortRef.current?.abort();
    setUrlLoading(false);
    setUrlError(null);
  };

  // Cleanup abort on unmount
  useEffect(() => () => { urlAbortRef.current?.abort(); }, []);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setFocusIdx((i) => Math.min(i + 1, displayList.length - 1)); }
    if (e.key === 'ArrowUp') { e.preventDefault(); setFocusIdx((i) => Math.max(i - 1, 0)); }
    if (e.key === 'Enter') {
      e.preventDefault();
      const item = displayList[focusIdx];
      if (item?.entry.type === 'file') handleAssign(item.entry);
      else if (item?.entry.type === 'folder') toggleFolder(item.entry.path);
    }
  };

  if (!targetInst) return null;
  const color = targetInst.color;

  return (
    <div
      ref={containerRef}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      className="bg-bg-secondary border-l border-border flex flex-col shrink-0 h-full min-h-0 outline-none overflow-hidden w-full"
    >
      {/* Target */}
      <div className="flex items-center text-[9px] text-text-secondary px-4 pt-3 pb-1.5 shrink-0">
        <span className="text-text-secondary/60">target: </span>
        <span style={{ color }}>{targetInst.name}</span>
      </div>

      {/* Loop Browser header + Import + URL */}
      <div className="flex items-center justify-between px-4 pt-3 pb-1 shrink-0">
        <span className="text-[10px] text-text-secondary uppercase tracking-wider font-medium">
          Loop Browser
        </span>
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => { setShowUrlInput((v) => !v); setUrlError(null); setUrlSuccess(false); }}
            className={`text-[9px] px-2 py-0.5 rounded border transition-colors cursor-pointer ${
              showUrlInput
                ? 'border-accent/50 text-accent bg-accent/10'
                : 'border-border hover:border-white/20 text-text-secondary hover:text-text-primary'
            }`}
            title="Import audio from URL (TikTok, YouTube, SoundCloud…)"
          >
            URL
          </button>
          <label htmlFor={fileInputId}
            className="text-[9px] px-2 py-0.5 rounded border border-border hover:border-white/20 text-text-secondary hover:text-text-primary cursor-pointer transition-colors"
            title="Import loop files">
            + Import
            <input id={fileInputId} type="file" accept=".wav,.mp3,.ogg,.flac,.aiff" multiple
              className="hidden" onChange={handleFileImport} />
          </label>
        </div>
      </div>

      {/* URL import bar */}
      {showUrlInput && (
        <div className="px-4 py-2 border-b border-border/50 shrink-0 space-y-1.5">
          <div className="flex gap-1.5">
            <input
              type="url"
              placeholder="Paste video/audio URL…"
              value={urlValue}
              onChange={(e) => { setUrlValue(e.target.value); setUrlError(null); }}
              onKeyDown={(e) => { if (e.key === 'Enter' && !urlLoading) handleUrlImport(); }}
              disabled={urlLoading}
              className="flex-1 bg-bg-tertiary border border-border rounded px-2 py-1 text-[11px] text-text-primary placeholder-text-secondary/40 outline-none focus:border-accent/50 transition-colors disabled:opacity-50"
            />
            {urlLoading ? (
              <button
                onClick={handleUrlCancel}
                className="text-[9px] px-2 py-0.5 rounded border border-red-500/30 text-red-400 hover:bg-red-500/10 transition-colors cursor-pointer shrink-0"
              >
                Cancel
              </button>
            ) : (
              <button
                onClick={handleUrlImport}
                disabled={!urlValue.trim()}
                className="text-[9px] px-2 py-0.5 rounded border border-accent/30 text-accent hover:bg-accent/10 transition-colors cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed shrink-0"
              >
                Go
              </button>
            )}
          </div>
          {urlLoading && (
            <p className="text-[9px] text-accent/70 animate-pulse">Extracting audio…</p>
          )}
          {urlError && (
            <div className="space-y-1">
              <p className="text-[9px] text-red-400">{urlError}</p>
              <p className="text-[9px] text-text-secondary/50">
                For best results, run cobalt locally — see Settings &gt; Audio
              </p>
            </div>
          )}
          {urlSuccess && (
            <p className="text-[9px] text-green-400">Imported!</p>
          )}
        </div>
      )}

      {/* Search */}
      <div className="px-4 py-2 border-b border-border/50 shrink-0">
        <input type="text" placeholder="Search loops…" value={searchQuery}
          onChange={(e) => { setSearchQuery(e.target.value); setFocusIdx(-1); }}
          className="w-full bg-bg-tertiary border border-border rounded px-2 py-1 text-[11px] text-text-primary placeholder-text-secondary/40 outline-none focus:border-white/20 transition-colors" />
      </div>

      {/* File tree */}
      <div className="flex-1 overflow-y-auto px-0 min-h-0">
        {displayList.map(({ entry, depth }, idx) => {
          const isFocused = idx === focusIdx;
          const isFolder = entry.type === 'folder';
          const isExpanded = expanded.has(entry.path);
          const isCurrent = targetInst.samplePath === entry.path;

          return (
            <div key={entry.path}
              className={`flex items-center gap-1 rounded cursor-pointer transition-colors ${isFocused ? 'bg-white/10' : 'hover:bg-white/5'}`}
              style={{ paddingLeft: depth * 16 + 6, paddingRight: 6, paddingTop: 4, paddingBottom: 4 }}
              onClick={() => { setFocusIdx(idx); if (isFolder) toggleFolder(entry.path); }}
              onDoubleClick={() => { if (!isFolder) handleAssign(entry); }}>
              {isFolder ? (
                <svg width="8" height="8" viewBox="0 0 8 8" fill="currentColor"
                  className="text-text-secondary/60 shrink-0 transition-transform"
                  style={{ transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)' }}>
                  <path d="M2 1 L6 4 L2 7 Z" />
                </svg>
              ) : <div className="w-2 shrink-0" />}
              <span className={`text-[11px] truncate flex-1 ${isFolder ? 'text-text-secondary' : 'text-text-primary'}`}
                style={isCurrent ? { color } : undefined}>
                {isFolder ? entry.name : entry.name.replace(/\.[^.]+$/, '')}
              </span>
              {!isFolder && bpmMap[entry.path] > 0 && (
                <span className="shrink-0 text-[8px] font-mono text-text-secondary/50 tabular-nums">
                  {Math.round(bpmMap[entry.path])}
                </span>
              )}
              {!isFolder && (
                <>
                  <button onClick={(e) => { e.stopPropagation(); handlePreview(entry.path); }}
                    className={`shrink-0 p-0.5 rounded transition-colors ${previewingUrl === entry.path ? 'text-accent' : 'text-text-secondary/40 hover:text-accent'}`}
                    title="Preview">
                    <svg width="8" height="8" viewBox="0 0 8 8" fill="currentColor">
                      {previewingUrl === entry.path
                        ? <><rect x="1" y="1" width="2" height="6" /><rect x="5" y="1" width="2" height="6" /></>
                        : <path d="M1 0 L8 4 L1 8 Z" />}
                    </svg>
                  </button>
                  <button onClick={(e) => { e.stopPropagation(); handleAssign(entry); }}
                    className="shrink-0 p-0.5 rounded transition-colors text-text-secondary/40 hover:text-accent"
                    title="Assign loop">
                    <svg width="8" height="8" viewBox="0 0 8 8" fill="none" stroke="currentColor" strokeWidth="1.5">
                      <line x1="4" y1="1" x2="4" y2="7" /><line x1="1" y1="4" x2="7" y2="4" />
                    </svg>
                  </button>
                </>
              )}
            </div>
          );
        })}

        {displayList.length === 0 && (
          <div className="text-[10px] text-text-secondary/50 text-center py-8">
            {searchQuery.trim()
              ? <>No loops match &ldquo;{searchQuery}&rdquo;</>
              : <>No loops found.<br /><span className="text-[9px]">Add .wav files to /public/loops/ or use + Import</span></>}
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="px-4 py-2 border-t border-border/50 text-[8px] text-text-secondary/40 text-center shrink-0">
        arrows to browse &middot; enter to assign &middot; double-click to assign
      </div>
    </div>
  );
}
