import { useEffect } from 'react';
import { toggleTransport } from '../audio/transport';
import { initAudio } from '../audio/engine';
import { loadSamples } from '../audio/sampler';
import { undo, redo } from '../state/undoHistory';
import { useStore } from '../state/store';

const audioInitRef = { initialized: false };

async function ensureAudio() {
  if (audioInitRef.initialized) return;
  await initAudio();
  await loadSamples();
  audioInitRef.initialized = true;
}

export function useKeyboardShortcuts(): void {
  useEffect(() => {
    const handleKeyDown = async (e: KeyboardEvent) => {
      // Don't trigger if user is typing in a text input
      if (
        (e.target instanceof HTMLInputElement && e.target.type !== 'range') ||
        e.target instanceof HTMLTextAreaElement
      ) {
        return;
      }

      const isMod = e.metaKey || e.ctrlKey;

      // Undo: Ctrl+Z / Cmd+Z
      if (isMod && e.key === 'z' && !e.shiftKey) {
        e.preventDefault();
        undo();
        return;
      }

      // Redo: Ctrl+Shift+Z / Cmd+Shift+Z / Ctrl+Y
      if (isMod && ((e.key === 'z' && e.shiftKey) || e.key === 'y')) {
        e.preventDefault();
        redo();
        return;
      }

      // Scene: Ctrl+G / Cmd+G
      if (isMod && e.code === 'KeyG' && !e.shiftKey) {
        e.preventDefault();
        useStore.getState().sceneSelected();
        return;
      }

      // Unscene: Ctrl+Shift+G / Cmd+Shift+G
      if (isMod && e.code === 'KeyG' && e.shiftKey) {
        e.preventDefault();
        useStore.getState().unsceneSelected();
        return;
      }

      // Rename: Enter — start renaming selected instrument or scene
      if (e.code === 'Enter' && !isMod && !e.shiftKey) {
        const s = useStore.getState();
        if (s.renamingId) return; // already renaming — let the input handle Enter
        const targetId = s.selectedSceneId ?? s.selectedInstrumentId;
        if (targetId) {
          e.preventDefault();
          s.setRenamingId(targetId);
          return;
        }
      }

      // Delete selected scene, instrument(s), or effect — Backspace / Delete / X
      // Skip when the piano roll is focused — it handles its own Delete/Backspace for notes
      if ((e.code === 'Backspace' || e.code === 'Delete' || e.code === 'KeyX') && !isMod && !e.shiftKey) {
        if ((document.activeElement as HTMLElement)?.closest?.('[data-piano-roll]')) return;
        const s = useStore.getState();
        if (s.renamingId) return; // don't delete while renaming
        if (s.selectedSceneId) {
          e.preventDefault();
          s.deleteScene(s.selectedSceneId);
          return;
        }
        if (s.selectedInstrumentIds.length > 0) {
          e.preventDefault();
          for (const id of [...s.selectedInstrumentIds]) {
            useStore.getState().removeInstrument(id);
          }
          return;
        }
      }

      // Live Mode: digit keys 1-9 launch scene, 0 or Escape stops
      const state = useStore.getState();
      if (state.liveMode) {
        if (e.key >= '1' && e.key <= '9' && !isMod) {
          const idx = parseInt(e.key, 10) - 1;
          const scene = state.scenes[idx];
          if (scene) {
            e.preventDefault();
            await ensureAudio();
            if (!state.isPlaying) {
              useStore.getState().launchScene(scene.id);
              toggleTransport();
            } else {
              state.launchScene(scene.id);
            }
          }
          return;
        }
        if ((e.key === '0' || e.code === 'Escape') && !isMod) {
          e.preventDefault();
          state.stopLiveScene();
          return;
        }

        // Space in live mode: start first/selected scene or stop all
        if (e.code === 'Space') {
          e.preventDefault();
          await ensureAudio();
          if (state.isPlaying) {
            // Stop transport and clear live state
            toggleTransport();
            state.stopLiveScene();
          } else {
            // Start the selected scene, or the first scene
            const targetScene = state.scenes.find((s) => s.id === state.selectedSceneId)
              ?? state.scenes[0];
            if (targetScene) {
              // Set scene BEFORE starting transport so first tick filters correctly
              useStore.getState().launchScene(targetScene.id);
              toggleTransport();
            } else {
              toggleTransport();
            }
          }
          return;
        }
      }


      if (e.code === 'Space') {
        e.preventDefault();
        await ensureAudio();
        toggleTransport();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);
}
