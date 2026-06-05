import { useEffect, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useStore } from '../../state/store';
import { storage } from '../../storage/LocalStorageProvider';
import { importSetFromFile, deserializeSet } from '../../storage/serializer';
import { setLastSetId } from '../../storage/sessionAutosave';
import { gunzipAsync, fromBase64Url, strFromU8 } from '../../storage/compressionUtils';
import { encodeSetToUrl, buildShareUrl } from '../../storage/urlShare';
import { copyToClipboard } from '../../utils/clipboard';
import { track } from '../../utils/analytics';
import { resizeImageToThumbnail } from '../../storage/thumbnailCapture';
import type { SetMeta, OrbitrackSet, SetVersionEntry } from '../../types/storage';

interface OpenSetDialogProps {
  onClose: () => void;
}

export function OpenSetDialog({ onClose }: OpenSetDialogProps) {
  const [sets, setSets] = useState<(SetMeta & { versionCount: number })[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [versions, setVersions] = useState<SetVersionEntry[]>([]);
  const [loadingVersions, setLoadingVersions] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  useEffect(() => {
    storage.listSets().then((list) => {
      const items = list
        .filter((s) => s.id !== '__autosave__')
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map((s) => ({
          ...s,
          versionCount: (s as SetMeta).versionCount ?? 0,
        }));
      setSets(items);
      setLoading(false);
    });
  }, []);

  const handleOpen = async (id: string) => {
    const set = await storage.getSet(id);
    if (set) {
      useStore.getState().loadSet(set);
      setLastSetId(id);
      track('set-open', { source: 'library' });
      onClose();
    }
  };

  const handleDelete = async (id: string) => {
    await storage.deleteSet(id);
    setSets((prev) => prev.filter((s) => s.id !== id));
    if (expandedId === id) {
      setExpandedId(null);
      setVersions([]);
    }
  };

  const handleImportFile = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.orb,.json';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const set = await importSetFromFile(file);
        useStore.getState().loadSet(set);
        setLastSetId(set.meta.id);
        track('set-import', { source: 'library' });
        onClose();
      } catch (e) {
        console.error('[OpenSetDialog] Import failed:', e);
      }
    };
    input.click();
  };

  const handleExpand = useCallback(async (id: string) => {
    if (expandedId === id) {
      setExpandedId(null);
      setVersions([]);
      return;
    }
    setExpandedId(id);
    setLoadingVersions(true);
    const set = await storage.getSet(id) as OrbitrackSet | undefined;
    setVersions(set?.versions ?? []);
    setLoadingVersions(false);
  }, [expandedId]);

  const handleLoadVersion = useCallback(async (entry: SetVersionEntry) => {
    try {
      const compressed = fromBase64Url(entry.snapshot);
      const decompressed = await gunzipAsync(compressed);
      const json = strFromU8(decompressed);
      const set = deserializeSet(JSON.parse(json));
      useStore.getState().loadSet(set);
      setLastSetId(set.meta.id);
      track('set-version-load', { source: entry.source });
      onClose();
    } catch (e) {
      console.error('[OpenSetDialog] version load failed:', e);
    }
  }, [onClose]);

  const handleCopyLink = useCallback(async (id: string, entry?: SetVersionEntry) => {
    try {
      const store = useStore.getState();
      const serState = store.getSerializableState();
      const setData = await storage.getSet(id) as OrbitrackSet | undefined;
      const name = setData?.meta?.name ?? 'Shared';
      const thumb = setData?.meta?.thumbnail ?? store.currentSetThumbnail ?? undefined;
      const result = await encodeSetToUrl(serState, name, thumb);
      const url = buildShareUrl(result.encoded);
      await copyToClipboard(url);
      track('share-link-copy', { source: 'library', version: !!entry });

      const copyKey = entry ? entry.versionId : id;
      setCopiedId(copyKey);
      setTimeout(() => setCopiedId(null), 2500);
    } catch (e) {
      console.error('[OpenSetDialog] copy link failed:', e);
    }
  }, []);

  const handleChangeThumbnail = useCallback((id: string) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const dataUrl = await resizeImageToThumbnail(file);
        // Update in IDB
        const set = await storage.getSet(id) as OrbitrackSet | undefined;
        if (set) {
          set.meta.thumbnail = dataUrl;
          await storage.saveSet(set);
          // Update local state + store
          setSets((prev) => prev.map((s) => s.id === id ? { ...s, thumbnail: dataUrl } : s));
          if (useStore.getState().currentSetId === id) {
            useStore.getState().setCurrentSetThumbnail(dataUrl);
          }
        }
      } catch (e) {
        console.error('[OpenSetDialog] thumbnail change failed:', e);
      }
    };
    input.click();
  }, []);

  const formatDate = (ts: number) => {
    const d = new Date(ts);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  };

  const formatTime = (ts: number) => {
    const d = new Date(ts);
    return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  };

  return createPortal(
    <div className="fixed inset-0 z-[10001] flex items-center justify-center backdrop-blur-sm bg-black/40" onClick={onClose}>
      <div
        className="bg-bg-secondary border border-border rounded-lg shadow-2xl flex flex-col"
        style={{ width: 600, maxHeight: 600 }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-6 pt-6 pb-3">
          <div className="text-sm font-semibold text-text-primary">My Sets</div>
        </div>

        {/* Set list */}
        <div className="flex-1 overflow-y-auto px-4 pb-3" style={{ minHeight: 120 }}>
          {loading && (
            <div className="text-[13px] text-text-secondary/40 text-center py-10">Loading...</div>
          )}
          {!loading && sets.length === 0 && (
            <div className="text-[13px] text-text-secondary/40 text-center py-10">No saved sets</div>
          )}
          {sets.map((s) => (
            <div key={s.id} className="mb-1">
              {/* Main set row */}
              <div
                className="flex items-center gap-3 px-3 py-3 rounded hover:bg-white/5 group cursor-pointer transition-colors"
                onClick={() => handleOpen(s.id)}
              >
                {/* Thumbnail — click to change */}
                <button
                  className="w-[64px] h-[64px] rounded overflow-hidden flex-shrink-0 bg-bg-tertiary border border-border/30 hover:border-accent/40 transition-colors group/thumb"
                  title="Change cover image"
                  onClick={(e) => { e.stopPropagation(); handleChangeThumbnail(s.id); }}
                >
                  {s.thumbnail ? (
                    <img src={s.thumbnail} alt="" className="w-full h-full object-cover" />
                  ) : (
                    <div className="w-full h-full flex flex-col items-center justify-center text-text-secondary/20 group-hover/thumb:text-text-secondary/40 transition-colors">
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                        <rect x="3" y="3" width="18" height="18" rx="2" />
                        <circle cx="8.5" cy="8.5" r="1.5" />
                        <path d="M21 15l-5-5L5 21" />
                      </svg>
                    </div>
                  )}
                </button>

                {/* Info */}
                <div className="flex-1 min-w-0">
                  <div className="text-[13px] text-text-primary truncate font-medium">{s.name}</div>
                  <div className="text-[11px] text-text-secondary/40 mt-0.5">
                    {formatDate(s.updatedAt)}
                    {s.versionCount > 0 && (
                      <span className="ml-2">{s.versionCount} version{s.versionCount !== 1 ? 's' : ''}</span>
                    )}
                  </div>
                  {s.versionCount > 0 && (
                    <button
                      onClick={(e) => { e.stopPropagation(); handleExpand(s.id); }}
                      className="text-[10px] text-text-secondary/50 hover:text-text-secondary mt-1 transition-colors"
                    >
                      {expandedId === s.id ? '▼ Hide versions' : '▶ Show versions'}
                    </button>
                  )}
                </div>

                {/* Actions */}
                <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button
                    onClick={(e) => { e.stopPropagation(); handleCopyLink(s.id); }}
                    className="text-[10px] text-accent/60 hover:text-accent px-2 py-1 rounded transition-colors"
                    title="Copy share link"
                  >
                    {copiedId === s.id ? 'Copied!' : 'Copy Link'}
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); handleDelete(s.id); }}
                    className="text-[12px] text-red-400/60 hover:text-red-400 px-2 py-1 transition-colors"
                    title="Delete set"
                  >
                    ✕
                  </button>
                </div>
              </div>

              {/* Expanded version list */}
              {expandedId === s.id && (
                <div className="ml-[76px] mb-2">
                  {loadingVersions && (
                    <div className="text-[11px] text-text-secondary/30 py-2">Loading versions...</div>
                  )}
                  {!loadingVersions && versions.length === 0 && (
                    <div className="text-[11px] text-text-secondary/30 py-2">No version history</div>
                  )}
                  {!loadingVersions && versions.map((v, i) => (
                    <div
                      key={v.versionId}
                      className="flex items-center gap-2 py-1.5 px-2 rounded hover:bg-white/[0.03] text-[11px] group/ver"
                    >
                      {/* Version thumbnail */}
                      <div className="w-[32px] h-[32px] rounded overflow-hidden flex-shrink-0 bg-bg-tertiary border border-border/20">
                        {v.thumbnail ? (
                          <img src={v.thumbnail} alt="" className="w-full h-full object-cover" />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center text-text-secondary/15 text-[10px]">
                            v{versions.length - i}
                          </div>
                        )}
                      </div>

                      {/* Version info */}
                      <div className="flex-1 min-w-0">
                        <span className="text-text-secondary/60">
                          {formatDate(v.timestamp)} {formatTime(v.timestamp)}
                        </span>
                        <span className={`ml-2 text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded ${
                          v.source === 'manual'
                            ? 'bg-accent/10 text-accent/60'
                            : 'bg-white/5 text-text-secondary/30'
                        }`}>
                          {v.source}
                        </span>
                      </div>

                      {/* Version actions */}
                      <div className="flex items-center gap-1 opacity-0 group-hover/ver:opacity-100 transition-opacity">
                        <button
                          onClick={() => handleLoadVersion(v)}
                          className="text-[10px] text-text-primary/60 hover:text-text-primary px-2 py-0.5 rounded border border-border/30 hover:border-border/60 transition-colors"
                        >
                          Load
                        </button>
                        <button
                          onClick={() => handleCopyLink(s.id, v)}
                          className="text-[10px] text-accent/50 hover:text-accent px-2 py-0.5 transition-colors"
                        >
                          {copiedId === v.versionId ? 'Copied!' : 'Copy'}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-border flex justify-between items-center">
          <button
            onClick={handleImportFile}
            className="text-[12px] text-accent/70 hover:text-accent transition-colors"
          >
            Import from file...
          </button>
          <button
            onClick={onClose}
            className="text-[12px] px-5 py-2 text-text-secondary/60 hover:text-text-secondary rounded border border-border transition-colors"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
