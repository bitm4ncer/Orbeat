/**
 * Thin, safe wrapper around the Umami analytics script.
 *
 * The script is loaded from index.html and exposes `window.umami`. It may be
 * absent — blocked by an ad blocker, offline, or simply not loaded yet — so
 * every call is guarded and never throws. Pageviews are tracked automatically
 * by the script; this module is only for custom events.
 *
 * Keep event payloads free of personal data (no project names, no file
 * contents). Counts and boolean flags are fine.
 */

type EventData = Record<string, string | number | boolean | undefined>;

declare global {
  interface Window {
    umami?: {
      track: (event?: string, data?: Record<string, unknown>) => void;
      identify?: (data: Record<string, unknown>) => void;
    };
  }
}

/**
 * Track a custom event. No-ops if Umami isn't available.
 *
 * @param event  Event name, kebab-case by convention (e.g. "set-export").
 * @param data   Optional flat map of extra properties.
 */
export function track(event: string, data?: EventData): void {
  try {
    window.umami?.track(event, data);
  } catch {
    // Analytics must never break the app — swallow everything.
  }
}
