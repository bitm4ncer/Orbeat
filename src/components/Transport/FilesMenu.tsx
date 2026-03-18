import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useClickOutside } from '../../hooks/useClickOutside';
import { useStore } from '../../state/store';
import { storage } from '../../storage/LocalStorageProvider';
import { serializeSet, exportSetToFile, importSetFromFile } from '../../storage/serializer';
import { gzipAsync, toBase64Url, strToU8 } from '../../storage/compressionUtils';
import { setLastSetId } from '../../storage/sessionAutosave';
import { encodeSetToUrl, buildShareUrl, exportSamplesZip, importSamplesZip } from '../../storage/urlShare';
import { copyToClipboard } from '../../utils/clipboard';
import type { OrbitrackSet, SetVersionEntry } from '../../types/storage';
import { SaveSetDialog } from './SaveSetDialog';
import { OpenSetDialog } from './OpenSetDialog';

const MAX_VERSIONS = 50;

function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

interface FilesMenuProps {
  anchorRef: React.RefObject<HTMLButtonElement | null>;
  onClose: () => void;
}

export function FilesMenu({ anchorRef, onClose }: FilesMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveAs, setSaveAs] = useState(false);
  const [openDialogOpen, setOpenDialogOpen] = useState(false);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const thumbnail = useStore((s) => s.currentSetThumbnail);
  useClickOutside(ref, () => {
    if (!saveOpen && !openDialogOpen && !shareOpen) onClose();
  });

  const rect = anchorRef.current?.getBoundingClientRect();
  const style: React.CSSProperties = rect ? {
    position: 'fixed',
    bottom: window.innerHeight - rect.top + 4,
    left: rect.left,
    zIndex: 10000,
  } : {};

  const handleNew = () => {
    useStore.getState().newSet();
    setLastSetId(null);
    onClose();
  };

  const handleSave = async () => {
    const { currentSetId } = useStore.getState();
    if (currentSetId) {
      // Quick save to existing set with version creation
      const state = useStore.getState().getSerializableState();
      const name = useStore.getState().currentSetName;
      const set = await serializeSet(state, {
        name,
        embedSamples: true,
        includeInstruments: true,
        includeEffects: true,
        includeSynthParams: true,
      });
      set.id = currentSetId;
      set.meta.id = currentSetId;

      // Preserve existing thumbnail from store
      const storeThumb = useStore.getState().currentSetThumbnail;
      if (storeThumb) set.meta.thumbnail = storeThumb;

      // Load existing set for versions
      const existing = await storage.getSet(currentSetId);

      // Create version snapshot
      const { versions: _, ...setWithoutVersions } = set;
      const json = JSON.stringify(setWithoutVersions);
      const compressed = await gzipAsync(strToU8(json));
      const snapshot = toBase64Url(compressed);

      const entry: SetVersionEntry = {
        versionId: uid(),
        timestamp: Date.now(),
        source: 'manual',
        snapshot,
      };

      // Use already-loaded existing set for versions
      const versions: SetVersionEntry[] = (existing as OrbitrackSet | undefined)?.versions ?? [];
      versions.unshift(entry);
      if (versions.length > MAX_VERSIONS) versions.length = MAX_VERSIONS;

      set.versions = versions;
      set.meta.versionCount = versions.length;
      set.meta.updatedAt = Date.now();

      await storage.saveSet(set);
      setLastSetId(currentSetId);
      onClose();
    } else {
      setSaveAs(false);
      setSaveOpen(true);
    }
  };

  const handleSaveAs = () => {
    setSaveAs(true);
    setSaveOpen(true);
  };

  const handleExport = async () => {
    const state = useStore.getState().getSerializableState();
    const name = useStore.getState().currentSetName;
    const set = await serializeSet(state, {
      name,
      embedSamples: true,
      includeInstruments: true,
      includeEffects: true,
      includeSynthParams: true,
    });
    // Preserve thumbnail from store
    const thumb = useStore.getState().currentSetThumbnail;
    if (thumb) set.meta.thumbnail = thumb;
    exportSetToFile(set);
    onClose();
  };

  const handleImport = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.orb,.json';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const set = await importSetFromFile(file);
        useStore.getState().loadSet(set);
        onClose();
      } catch (e) {
        console.error('[FilesMenu] Import failed:', e);
      }
    };
    input.click();
  };

  const handleOpen = () => {
    setOpenDialogOpen(true);
  };

  const handleShare = () => {
    setShareOpen(true);
  };

  const items = [
    { label: 'New Set', action: handleNew },
    'separator',
    { label: 'Save', action: handleSave },
    { label: 'Save As…', action: handleSaveAs },
    'separator',
    { label: 'Export .orb…', action: handleExport },
    { label: 'Import .orb…', action: handleImport },
    'separator',
    { label: 'Share…', action: handleShare },
    'separator',
    { label: 'My Sets', action: handleOpen },
  ] as const;

  return (
    <>
      {createPortal(
        <>
        <div className="fixed inset-0 backdrop-blur-sm bg-black/40 z-[9999]" />
        <div
          ref={ref}
          className="bg-bg-secondary border border-border rounded-lg shadow-2xl overflow-hidden"
          style={{ ...style, width: thumbnail ? 300 : undefined, minWidth: 200 }}
        >
          {/* Cover art above menu */}
          {thumbnail && (
            <button
              className="overflow-hidden cursor-pointer hover:opacity-90 transition-opacity"
              style={{ width: 300, height: 300 }}
              onClick={() => setLightboxOpen(true)}
              title="View cover art"
            >
              <img src={thumbnail} alt="" className="w-full h-full object-cover" />
            </button>
          )}
          <div className="py-2">
            {items.map((item, i) =>
              item === 'separator' ? (
                <div key={i} className="border-t border-border/40 my-1" />
              ) : (
                <button
                  key={item.label}
                  onClick={item.action}
                  className="w-full text-left text-[13px] px-5 py-2 text-text-secondary hover:bg-white/5 hover:text-text-primary transition-colors"
                >
                  {item.label}
                </button>
              ),
            )}
          </div>
        </div>
        </>,
        document.body,
      )}

      {/* Lightbox */}
      {lightboxOpen && thumbnail && createPortal(
        <div
          className="fixed inset-0 z-[10002] flex items-center justify-center backdrop-blur-md bg-black/60 cursor-pointer"
          onClick={() => setLightboxOpen(false)}
        >
          <img
            src={thumbnail}
            alt="Cover Art"
            className="max-w-[80vmin] max-h-[80vmin] rounded-lg shadow-2xl border border-border/30"
          />
        </div>,
        document.body,
      )}

      {saveOpen && (
        <SaveSetDialog
          forceNewName={saveAs}
          onClose={() => { setSaveOpen(false); onClose(); }}
        />
      )}

      {openDialogOpen && (
        <OpenSetDialog
          onClose={() => { setOpenDialogOpen(false); onClose(); }}
        />
      )}

      {shareOpen && (
        <SharePanel onClose={() => { setShareOpen(false); onClose(); }} />
      )}
    </>
  );
}

function SharePanel({ onClose }: { onClose: () => void }) {
  const [copyStatus, setCopyStatus] = useState<'idle' | 'encoding' | 'ready' | 'copied' | 'error'>('idle');
  const [zipStatus, setZipStatus] = useState<'idle' | 'working' | 'done' | 'error'>('idle');
  const [hasCustomSamples, setHasCustomSamples] = useState(false);
  const importRef = useRef<HTMLInputElement>(null);
  const shareUrlRef = useRef<string | null>(null);

  // Pre-encode the share URL on mount so copy can be synchronous
  useEffect(() => {
    let cancelled = false;
    setCopyStatus('encoding');
    (async () => {
      try {
        const store = useStore.getState();
        const state = store.getSerializableState();
        const { encoded, hasCustomSamples: hcs } = await encodeSetToUrl(state, store.currentSetName, store.currentSetThumbnail ?? undefined);
        if (cancelled) return;
        shareUrlRef.current = buildShareUrl(encoded);
        setHasCustomSamples(hcs);
        setCopyStatus('ready');
      } catch (e) {
        console.error('[Share] Encode failed:', e);
        if (!cancelled) setCopyStatus('error');
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const handleCopyLink = async () => {
    if (!shareUrlRef.current || copyStatus === 'encoding') return;
    try {
      await copyToClipboard(shareUrlRef.current);
      setCopyStatus('copied');
      setTimeout(() => setCopyStatus('ready'), 2500);
    } catch (e) {
      console.error('[Share] Copy failed:', e);
      setCopyStatus('error');
      setTimeout(() => setCopyStatus('ready'), 3000);
    }
  };

  const handleDownloadSamples = async () => {
    if (zipStatus === 'working') return;
    setZipStatus('working');
    try {
      const { customSamples } = useStore.getState().getSerializableState();
      const blob = await exportSamplesZip(customSamples);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${useStore.getState().currentSetName}-samples.zip`;
      a.click();
      URL.revokeObjectURL(a.href);
      setZipStatus('done');
      setTimeout(() => setZipStatus('idle'), 2000);
    } catch (e) {
      console.error('[Share] ZIP export failed:', e);
      setZipStatus('error');
      setTimeout(() => setZipStatus('idle'), 3000);
    }
  };

  const handleImportSamples = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const samples = await importSamplesZip(file);
      const store = useStore.getState();
      for (const s of samples) {
        store.addCustomSample(s);
      }
    } catch (err) {
      console.error('[Share] ZIP import failed:', err);
    }
    e.target.value = '';
  };

  const copyLabel =
    copyStatus === 'encoding' ? 'Encoding...' : copyStatus === 'copied' ? 'Copied!' : copyStatus === 'error' ? 'Failed' : 'Copy link';

  return createPortal(
    <div className="fixed inset-0 z-[10001] flex items-center justify-center backdrop-blur-sm bg-black/40" onClick={onClose}>
      <div className="bg-bg-secondary border border-border rounded-lg shadow-2xl py-4 px-5" style={{ width: 280 }} onClick={(e) => e.stopPropagation()}>
        <div className="text-[11px] uppercase tracking-wider text-text-secondary/50 mb-3">Share Track</div>

        <button
          onClick={handleCopyLink}
          disabled={copyStatus === 'encoding'}
          className={`w-full text-[12px] px-4 py-2 rounded font-medium transition-colors mb-2 cursor-pointer
            ${
              copyStatus === 'copied'
                ? 'bg-green-500/20 text-green-400 border border-green-500/40'
                : copyStatus === 'error'
                  ? 'bg-red-500/20 text-red-400 border border-red-500/40'
                  : 'border disabled:opacity-50'
            }`}
          style={
            copyStatus !== 'copied' && copyStatus !== 'error'
              ? { backgroundColor: '#c1eeca', color: '#1a1a1a', borderColor: '#a8dab0' }
              : {}
          }
        >
          {copyLabel}
        </button>

        {hasCustomSamples && copyStatus === 'copied' && (
          <div className="mb-2 px-3 py-2 rounded bg-amber-500/10 border border-amber-500/30 text-[11px] text-amber-400/80">
            Custom samples not in URL — download & share the samples ZIP too.
          </div>
        )}

        <div className="border-t border-border/30 mt-2 pt-2 flex gap-2">
          <button
            onClick={handleDownloadSamples}
            disabled={zipStatus === 'working'}
            className="flex-1 text-[11px] px-3 py-1.5 rounded border border-border text-text-secondary hover:text-text-primary hover:border-white/30 transition-colors disabled:opacity-50"
          >
            {zipStatus === 'working' ? 'Packing...' : zipStatus === 'done' ? 'Downloaded!' : 'Download Samples'}
          </button>
          <button
            onClick={() => importRef.current?.click()}
            className="flex-1 text-[11px] px-3 py-1.5 rounded border border-border text-text-secondary hover:text-text-primary hover:border-white/30 transition-colors"
          >
            Import Samples
          </button>
          <input ref={importRef} type="file" accept=".zip" className="hidden" onChange={handleImportSamples} />
        </div>

        <div className="mt-2 text-[10px] text-text-secondary/40 leading-snug">
          This link stores the current state of the project. Save it or share it. Opening a link restores the saved state of a set — it's not a live link. While the Set Image can be stored in the slug, custom samples must be downloaded.
        </div>
      </div>
    </div>,
    document.body,
  );
}
