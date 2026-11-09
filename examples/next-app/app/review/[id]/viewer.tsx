'use client';
import { SessionViewer, type SessionViewerProps } from 'narrated-replay/viewer';

export function Viewer(props: SessionViewerProps) {
  // `window.__nrViewer` is only there so the Playwright test can drive the player.
  return <SessionViewer {...props} onReady={(api) => { (window as unknown as { __nrViewer?: unknown }).__nrViewer = api; }} />;
}
