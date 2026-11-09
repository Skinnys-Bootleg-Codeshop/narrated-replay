import { createElement, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FeedbackItem, SessionMeta } from '../shared/types.js';

export interface ViewerApi {
  /** Seek replay and audio to a time in the audio timeline (ms since audio start). */
  seekToAudioMs(ms: number): void;
  /** Seek replay to a replay time (ms since the first rrweb event); audio follows. */
  seekToReplayMs(ms: number): void;
  audio: HTMLAudioElement | null;
  /** The rrweb-player instance (goto, play, pause, getReplayer). */
  player: unknown;
  /** Replay ms at which audio time 0 happens. */
  offsetMs: number;
}

export interface SessionViewerProps {
  meta: SessionMeta;
  events: unknown[];
  audioUrl?: string | null;
  items?: FeedbackItem[];
  width?: number;
  height?: number;
  /** Called once the player is mounted; handy for tests and custom controls. */
  onReady?(api: ViewerApi): void;
}

const DRIFT_MS = 250;

export function SessionViewer({ meta, events, audioUrl, items = [], width = 800, height = 450, onReady }: SessionViewerProps) {
  const target = useRef<HTMLDivElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const playerRef = useRef<any>(null);
  const playingRef = useRef(false);
  const [active, setActive] = useState<string | null>(null);
  const first = (events[0] as { timestamp?: number } | undefined)?.timestamp ?? meta.rrwebStart;
  // Replay time (ms since first event) at which audio time 0 occurs.
  const offsetMs = (meta.audioStart ?? first) - first;
  const sorted = useMemo(() => [...items].sort((a, b) => a.startMs - b.startMs), [items]);

  const seekToReplayMs = useCallback(
    (ms: number) => {
      const p = playerRef.current;
      // The replay is the single source of truth for play/pause; audio follows it.
      p?.goto(Math.max(0, ms), playingRef.current);
      if (audioRef.current) audioRef.current.currentTime = Math.max(0, (ms - offsetMs) / 1000);
    },
    [offsetMs],
  );
  const seekToAudioMs = useCallback((ms: number) => seekToReplayMs(ms + offsetMs), [seekToReplayMs, offsetMs]);

  useEffect(() => {
    let disposed = false;
    let player: any;
    (async () => {
      const mod: any = await import('rrweb-player');
      if (disposed || !target.current) return;
      const Player = mod.default ?? mod.Player;
      player = new Player({ target: target.current, props: { events, width, height, autoPlay: false, skipInactive: false } });
      playerRef.current = player;
      const audio = audioRef.current;
      const speedOf = () => Number(player.getReplayer?.()?.config?.speed) || 1;
      const syncAudio = (replayMs: number) => {
        if (!audio) return;
        const speed = speedOf();
        if (audio.playbackRate !== speed) audio.playbackRate = speed;
        const want = (replayMs - offsetMs) / 1000;
        if (want < 0) {
          // Before the audio starts.
          if (!audio.paused) audio.pause();
          return;
        }
        if (Math.abs(audio.currentTime - want) * 1000 > DRIFT_MS) audio.currentTime = want;
        // Crossing the audio offset while the replay is playing starts the audio.
        if (playingRef.current && audio.paused) void audio.play().catch(() => undefined);
      };
      player.addEventListener('ui-update-current-time', (e: { payload: number }) => syncAudio(e.payload));
      player.addEventListener('ui-update-player-state', (e: { payload: string }) => {
        playingRef.current = e.payload === 'playing';
        if (!audio) return;
        if (e.payload === 'playing') {
          syncAudio(player.getReplayer().getCurrentTime());
        } else if (!audio.paused) audio.pause();
      });
      onReady?.({ seekToAudioMs, seekToReplayMs, audio, player, offsetMs });
    })();
    return () => {
      disposed = true;
      try { player?.$destroy?.(); } catch { /* ignore */ }
      playerRef.current = null;
      if (target.current) target.current.innerHTML = '';
    };
    // events/meta identity changes mean a different session
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events, meta.sessionId]);

  const fmt = (ms: number) => {
    const s = Math.floor(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };

  return createElement(
    'div',
    { className: 'nr-viewer' },
    createElement('div', { ref: target, className: 'nr-player', 'data-testid': 'nr-player' }),
    audioUrl ? createElement('audio', { ref: audioRef, src: audioUrl, preload: 'auto', className: 'nr-audio', 'data-testid': 'nr-audio' }) : null,
    createElement(
      'ol',
      { className: 'nr-items', 'data-testid': 'nr-items' },
      ...sorted.map((it) =>
        createElement(
          'li',
          { key: it.id, className: it.id === active ? 'nr-item nr-active' : 'nr-item' },
          createElement(
            'button',
            {
              type: 'button',
              className: 'nr-item-btn',
              'data-testid': 'nr-item',
              onClick: () => {
                setActive(it.id);
                seekToAudioMs(it.startMs);
              },
            },
            createElement('span', { className: 'nr-time' }, fmt(it.startMs)),
            ' ',
            createElement('span', { className: `nr-cat nr-cat-${it.category}` }, it.category),
            it.needsHumanReview ? createElement('span', { className: 'nr-review' }, ' needs human review') : null,
            createElement('div', { className: 'nr-summary' }, it.summary),
            createElement('blockquote', { className: 'nr-quote' }, it.quote),
          ),
        ),
      ),
    ),
  );
}
