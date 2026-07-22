import { useEffect, useMemo, useRef } from 'react';
import type { EditorMode } from '../documentState';
import {
  markRendererCleanShutdown,
  recordRendererHeartbeat,
  type RendererHeartbeatMetrics,
} from '../../services/nativeRecoveryService';
import { isTauriRuntime } from '../runtime';
import { utf8SourceBytes } from '../runtime/documentAnalysisPolicy';
import {
  EMPTY_BACKGROUND_JOB_SNAPSHOT,
  summarizeBackgroundJobs,
  type BackgroundJobSnapshot,
} from '../backgroundJobs';

const HEARTBEAT_INTERVAL_MS = 8_000;

interface UseRendererDiagnosticsOptions {
  sourceText: string;
  filePath: string | null;
  mode: EditorMode;
  warningCount: number;
  errorCount: number;
  visualAtomCount: number;
  backgroundJobs?: BackgroundJobSnapshot;
  onPreviousSessionCrashDetected?: () => void;
  createDocumentMetrics?: (sourceText: string) => RendererDocumentMetrics;
  documentMetrics?: RendererDocumentMetrics;
  heartbeatIntervalMs?: number;
  now?: () => number;
}

export interface RendererDocumentMetrics {
  sourceTextBytes: number;
  lineCount: number;
  imageCount: number;
  mathCount: number;
}

interface RendererDiagnosticsSnapshot {
  filePath: string | null;
  mode: EditorMode;
  warningCount: number;
  errorCount: number;
  visualAtomCount: number;
  documentMetrics: RendererDocumentMetrics;
  backgroundJobs: BackgroundJobSnapshot;
  onPreviousSessionCrashDetected?: () => void;
}

export function useRendererDiagnostics({
  sourceText,
  filePath,
  mode,
  warningCount,
  errorCount,
  visualAtomCount,
  backgroundJobs = EMPTY_BACKGROUND_JOB_SNAPSHOT,
  onPreviousSessionCrashDetected,
  createDocumentMetrics = summarizeSourceTextForDiagnostics,
  documentMetrics: suppliedDocumentMetrics,
  heartbeatIntervalMs = HEARTBEAT_INTERVAL_MS,
  now = Date.now,
}: UseRendererDiagnosticsOptions): void {
  const sessionId = useMemo(() => {
    const random = Math.random().toString(36).slice(2);
    return `${Date.now().toString(36)}-${random}`;
  }, []);
  const computedDocumentMetrics = useMemo(
    () => suppliedDocumentMetrics ?? createDocumentMetrics(sourceText),
    [createDocumentMetrics, sourceText, suppliedDocumentMetrics],
  );
  const documentMetrics = computedDocumentMetrics;
  const latestSnapshot = useMemo<RendererDiagnosticsSnapshot>(() => ({
    filePath,
    mode,
    warningCount,
    errorCount,
    visualAtomCount,
    documentMetrics,
    backgroundJobs,
    onPreviousSessionCrashDetected,
  }), [
    backgroundJobs,
    documentMetrics,
    errorCount,
    filePath,
    mode,
    onPreviousSessionCrashDetected,
    visualAtomCount,
    warningCount,
  ]);
  const latestRef = useRef<RendererDiagnosticsSnapshot>(latestSnapshot);
  const reportedPreviousCrashRef = useRef(false);

  useEffect(() => {
    latestRef.current = latestSnapshot;
  }, [latestSnapshot]);

  useEffect(() => {
    if (!isTauriRuntime()) return undefined;
    let disposed = false;
    const sendHeartbeat = async () => {
      const snapshot = latestRef.current;
      const status = await recordRendererHeartbeat(metricsForSnapshot(sessionId, snapshot, now()));
      if (
        status?.previousSessionSuspectedCrash
        && !reportedPreviousCrashRef.current
        && !disposed
      ) {
        reportedPreviousCrashRef.current = true;
        snapshot.onPreviousSessionCrashDetected?.();
      }
    };
    const markCleanShutdown = () => {
      void markRendererCleanShutdown(sessionId);
    };

    void sendHeartbeat();
    const timer = window.setInterval(() => void sendHeartbeat(), heartbeatIntervalMs);
    window.addEventListener('pagehide', markCleanShutdown);
    window.addEventListener('beforeunload', markCleanShutdown);

    return () => {
      disposed = true;
      window.clearInterval(timer);
      window.removeEventListener('pagehide', markCleanShutdown);
      window.removeEventListener('beforeunload', markCleanShutdown);
      markCleanShutdown();
    };
  }, [heartbeatIntervalMs, now, sessionId]);
}

function metricsForSnapshot(
  sessionId: string,
  snapshot: RendererDiagnosticsSnapshot,
  nowMs: number,
): RendererHeartbeatMetrics {
  const backgroundJobSummary = summarizeBackgroundJobs(snapshot.backgroundJobs, nowMs);
  return {
    sessionId,
    documentPath: snapshot.filePath,
    mode: snapshot.mode,
    sourceTextBytes: snapshot.documentMetrics.sourceTextBytes,
    lineCount: snapshot.documentMetrics.lineCount,
    imageCount: snapshot.documentMetrics.imageCount,
    mathCount: snapshot.documentMetrics.mathCount,
    visualAtomCount: snapshot.visualAtomCount,
    warningCount: snapshot.warningCount,
    errorCount: snapshot.errorCount,
    activeBackgroundJobCount: backgroundJobSummary.activeCount,
    stuckBackgroundJobCount: backgroundJobSummary.stuckCount,
    oldestBackgroundJobMs: backgroundJobSummary.oldestBackgroundJobMs,
    backgroundJobLabels: backgroundJobSummary.activeJobLabels,
    stuckBackgroundJobLabels: backgroundJobSummary.stuckJobLabels,
  };
}

export function summarizeSourceTextForDiagnostics(sourceText: string): RendererDocumentMetrics {
  return {
    sourceTextBytes: byteLength(sourceText),
    lineCount: lineCount(sourceText),
    imageCount: countMatches(sourceText, /!\[[^\]]*]\(/g) + countMatches(sourceText, /<img\b/gi),
    mathCount: countMatches(sourceText, /\$\$?[^$\n]/g),
  };
}

/** @deprecated Use summarizeSourceTextForDiagnostics at generic document boundaries. */
export const summarizeMarkdownForDiagnostics = summarizeSourceTextForDiagnostics;

function byteLength(value: string): number {
  return utf8SourceBytes(value);
}

function lineCount(value: string): number {
  if (!value) return 0;
  let lines = 1;
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) === 10) lines += 1;
    else if (value.charCodeAt(index) === 13) {
      lines += 1;
      if (value.charCodeAt(index + 1) === 10) index += 1;
    }
  }
  return lines;
}

function countMatches(value: string, pattern: RegExp): number {
  const matcher = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
  let count = 0;
  while (matcher.exec(value)) {
    count += 1;
    if (matcher.lastIndex === 0) matcher.lastIndex += 1;
  }
  return count;
}
