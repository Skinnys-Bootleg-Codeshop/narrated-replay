import { createElement, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createRecorder, type Recorder, type RecorderOptions, type RecorderState } from '../recorder/index.js';
import { httpUploader } from '../recorder/uploader.js';

export type NarratedReplayOptions = Omit<RecorderOptions, 'uploader'> &
  ({ uploader: RecorderOptions['uploader']; endpoint?: undefined } | { endpoint: string; uploader?: undefined; headers?: Record<string, string> });

export function useNarratedReplay(options: NarratedReplayOptions) {
  const optsRef = useRef(options);
  optsRef.current = options;
  const recRef = useRef<Recorder | null>(null);
  const [state, setState] = useState<RecorderState>('idle');
  const [error, setError] = useState<Error | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const startedAt = useRef(0);

  const build = useCallback(() => {
    const o = optsRef.current;
    const { endpoint, headers, uploader, ...rest } = o as NarratedReplayOptions & { headers?: Record<string, string> };
    const rec = createRecorder({ ...rest, uploader: uploader ?? httpUploader({ endpoint: endpoint!, headers }) });
    rec.on('state', (s) => setState(s as RecorderState));
    rec.on('error', (e) => setError(e instanceof Error ? e : new Error(String(e))));
    return rec;
  }, []);

  useEffect(() => {
    if (state !== 'recording') return;
    const iv = setInterval(() => setElapsedMs(Date.now() - startedAt.current), 500);
    return () => clearInterval(iv);
  }, [state]);

  // Must be called from a user gesture (click handler): it asks for the microphone.
  const start = useCallback(async () => {
    setError(null);
    recRef.current = build();
    startedAt.current = Date.now();
    setElapsedMs(0);
    try {
      await recRef.current.start();
    } catch {
      /* surfaced through error state */
    }
  }, [build]);

  const stop = useCallback(async () => {
    try {
      return await recRef.current?.stop();
    } catch {
      return undefined;
    }
  }, []);

  useEffect(() => () => {
    if (recRef.current?.state === 'recording') void recRef.current.stop().catch(() => undefined);
  }, []);

  return { state, start, stop, error, elapsedMs };
}

export const CONSENT_KEY = 'narrated-replay:consent';

export interface TalkButtonLabels {
  talk?: string;
  stop?: string;
  consentTitle?: string;
  accept?: string;
  decline?: string;
  recording?: string;
}

export interface TalkButtonProps {
  options: NarratedReplayOptions;
  consentText?: ReactNode;
  labels?: TalkButtonLabels;
}

const DEFAULT_CONSENT =
  'If you continue, your microphone and what you do on this page will be recorded while you talk. ' +
  'Typed text is recorded in shape only (digits and letters are masked) and passwords are hidden, but anything you say out loud is recorded as spoken. ' +
  'The recording is used to improve this product. Stop at any time with the Stop button.';

function fmt(ms: number) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function TalkButton({ options, consentText, labels }: TalkButtonProps) {
  const l = { talk: 'Talk', stop: 'Stop', consentTitle: 'Record your feedback?', accept: 'Start recording', decline: 'Cancel', recording: 'Recording', ...labels };
  const { state, start, stop, error, elapsedMs } = useNarratedReplay(options);
  const [asking, setAsking] = useState(false);
  const stored = useMemo(() => () => {
    try { return localStorage.getItem(CONSENT_KEY) === 'accepted'; } catch { return false; }
  }, []);

  const onTalk = () => {
    if (stored()) void start();
    else setAsking(true);
  };
  const onAccept = () => {
    try { localStorage.setItem(CONSENT_KEY, 'accepted'); } catch { /* private mode */ }
    setAsking(false);
    void start();
  };

  if (state === 'recording' || state === 'stopping') {
    return createElement(
      'div',
      { className: 'nr-talk nr-recording', role: 'status', 'data-testid': 'nr-recording' },
      createElement('span', { className: 'nr-dot', 'aria-hidden': true }),
      createElement('span', { className: 'nr-timer' }, `${l.recording} ${fmt(elapsedMs)}`),
      createElement('button', { type: 'button', className: 'nr-btn', onClick: () => void stop(), disabled: state === 'stopping', 'data-testid': 'nr-stop' }, l.stop),
    );
  }
  return createElement(
    'div',
    { className: 'nr-talk' },
    createElement('button', { type: 'button', className: 'nr-btn', onClick: onTalk, 'data-testid': 'nr-talk' }, l.talk),
    error ? createElement('span', { className: 'nr-error', role: 'alert' }, error.message) : null,
    asking
      ? createElement(
          'div',
          { className: 'nr-overlay' },
          createElement(
            'div',
            { className: 'nr-dialog', role: 'dialog', 'aria-modal': true, 'aria-labelledby': 'nr-consent-title', 'data-testid': 'nr-consent' },
            createElement('h2', { id: 'nr-consent-title' }, l.consentTitle),
            createElement('p', null, consentText ?? DEFAULT_CONSENT),
            createElement(
              'div',
              { className: 'nr-actions' },
              createElement('button', { type: 'button', className: 'nr-btn', onClick: () => setAsking(false), 'data-testid': 'nr-decline' }, l.decline),
              createElement('button', { type: 'button', className: 'nr-btn nr-primary', onClick: onAccept, 'data-testid': 'nr-accept' }, l.accept),
            ),
          ),
        )
      : null,
  );
}
