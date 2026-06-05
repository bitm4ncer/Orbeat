import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useStore } from '../../state/store';
import { storage } from '../../storage/LocalStorageProvider';
import { serializeSet } from '../../storage/serializer';
import { resizeImageToThumbnail } from '../../storage/thumbnailCapture';
import { gzipAsync, toBase64Url, strToU8 } from '../../storage/compressionUtils';
import { setLastSetId } from '../../storage/sessionAutosave';
import { track } from '../../utils/analytics';
import type { OrbitrackSet, SetVersionEntry } from '../../types/storage';

const MAX_VERSIONS = 50;

function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

interface SaveSetDialogProps {
  forceNewName: boolean;
  onClose: () => void;
}

export function SaveSetDialog({ onClose }: SaveSetDialogProps) {
  const currentName = useStore((s) => s.currentSetName);
  const [name, setName] = useState(currentName);
  const [embedSamples, setEmbedSamples] = useState(true);
  const [saving, setSaving] = useState(false);
  const [thumbnailPreview, setThumbnailPreview] = useState<string | null>(null);

  // Load existing thumbnail from store
  useEffect(() => {
    const thumb = useStore.getState().currentSetThumbnail;
    if (thumb) setThumbnailPreview(thumb);
  }, []);

  const handleImagePick = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const dataUrl = await resizeImageToThumbnail(file);
        setThumbnailPreview(dataUrl);
      } catch (e) {
        console.error('[SaveSetDialog] image resize failed:', e);
      }
    };
    input.click();
  };

  const handleSave = async () => {
    if (!name.trim() || saving) return;
    setSaving(true);
    try {
      const state = useStore.getState().getSerializableState();
      const set = await serializeSet(state, {
        name: name.trim(),
        embedSamples,
        includeInstruments: true,
        includeEffects: true,
        includeSynthParams: true,
      });

      // Set thumbnail: user-picked image, or preserve from store
      const thumb = thumbnailPreview ?? useStore.getState().currentSetThumbnail;
      if (thumb) set.meta.thumbnail = thumb;

      // Create version snapshot (strip versions to avoid nesting)
      const { versions: _, ...setWithoutVersions } = set;
      const json = JSON.stringify(setWithoutVersions);
      const compressed = await gzipAsync(strToU8(json));
      const snapshot = toBase64Url(compressed);

      const entry: SetVersionEntry = {
        versionId: uid(),
        timestamp: Date.now(),
        source: 'manual',
        thumbnail: thumbnailPreview ?? undefined,
        snapshot,
      };

      // Load existing set's versions if re-saving
      const existingSetId = useStore.getState().currentSetId;
      let versions: SetVersionEntry[] = [];
      if (existingSetId) {
        const existing = await storage.getSet(existingSetId);
        versions = (existing as OrbitrackSet | undefined)?.versions ?? [];
      }

      // Prepend new version, cap at MAX_VERSIONS
      versions.unshift(entry);
      if (versions.length > MAX_VERSIONS) versions.length = MAX_VERSIONS;

      set.versions = versions;
      set.meta.versionCount = versions.length;

      await storage.saveSet(set);
      useStore.getState().setCurrentSetName(name.trim());
      useStore.setState({ currentSetId: set.meta.id, currentSetThumbnail: set.meta.thumbnail ?? null });
      setLastSetId(set.meta.id);
      track('set-save', { mode: 'dialog', embedSamples, hasThumbnail: !!thumb });
      onClose();
    } catch (e) {
      console.error('[SaveSetDialog] save failed:', e);
      setSaving(false);
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-[10001] flex items-center justify-center backdrop-blur-sm bg-black/40" onClick={onClose}>
      <div
        className="bg-bg-secondary border border-border rounded-lg shadow-2xl"
        style={{ width: 380, padding: 28 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-sm font-semibold text-text-primary mb-5">Save Set</div>

        {/* Thumbnail + Name row */}
        <div className="flex gap-4 mb-4">
          {/* Thumbnail picker */}
          <button
            onClick={handleImagePick}
            className="w-[72px] h-[72px] flex-shrink-0 rounded border border-border/50 bg-bg-tertiary overflow-hidden hover:border-accent/50 transition-colors group"
            title="Set cover image"
          >
            {thumbnailPreview ? (
              <img src={thumbnailPreview} alt="" className="w-full h-full object-cover" />
            ) : (
              <div className="w-full h-full flex flex-col items-center justify-center text-text-secondary/30 group-hover:text-text-secondary/50 transition-colors">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <rect x="3" y="3" width="18" height="18" rx="2" />
                  <circle cx="8.5" cy="8.5" r="1.5" />
                  <path d="M21 15l-5-5L5 21" />
                </svg>
                <span className="text-[9px] mt-1">Cover</span>
              </div>
            )}
          </button>

          {/* Name input */}
          <div className="flex-1">
            <span className="text-[11px] text-text-secondary/60 uppercase tracking-wider">Name</span>
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleSave(); if (e.key === 'Escape') onClose(); }}
              className="mt-1.5 w-full bg-bg-tertiary text-text-primary text-[13px] px-4 py-2.5 rounded border border-border outline-none focus:border-accent"
              placeholder="My Set"
            />
          </div>
        </div>

        <label className="flex items-center gap-2.5 mb-6">
          <input
            type="checkbox"
            checked={embedSamples}
            onChange={(e) => setEmbedSamples(e.target.checked)}
            className="accent-accent w-3.5 h-3.5"
          />
          <span className="text-[12px] text-text-secondary/70">Embed custom samples</span>
        </label>

        <div className="flex justify-end gap-3">
          <button
            onClick={onClose}
            className="text-[12px] px-5 py-2 text-text-secondary/60 hover:text-text-secondary rounded border border-border hover:border-border/80 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={!name.trim() || saving}
            className="text-[12px] px-5 py-2 rounded font-medium bg-accent/20 text-accent border border-accent/40 hover:bg-accent/30 transition-colors disabled:opacity-40"
          >
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
