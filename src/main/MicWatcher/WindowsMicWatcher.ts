/**
 * Windows Microphone Watcher
 *
 * Uses a packaged .NET helper that polls WASAPI capture sessions and emits
 * MIC_ACTIVE / MIC_INACTIVE over stdout. This avoids runtime code generation
 * and lets the native/system access layer ship as an explicit helper binary.
 */

import { spawn, ChildProcess } from 'node:child_process';
import { emitMicWatcherStatus, type IMicWatcher, type MicWatcherEvents } from './index';
import { describeMicWatcherHelperResolution } from './helperPaths';
import { IGNORED_MIC_APPS, SYSTEM_PROCESSES_TO_IGNORE } from './meetingApps';

const MAX_RESTART_ATTEMPTS = 5;
const RESTART_BASE_DELAY_MS = 2000;

export class WindowsMicWatcher implements IMicWatcher {
  private proc: ChildProcess | null = null;
  private disposed = false;
  private restartAttempts = 0;
  private restartTimer: NodeJS.Timeout | null = null;
  private events: MicWatcherEvents;
  private ignoredApps: string[];

  constructor(events: MicWatcherEvents, ignoredApps: string[] = []) {
    this.events = events;
    this.ignoredApps = ignoredApps;
  }

  updateCustomApps(apps: string[]): void {
    this.ignoredApps = apps;
  }

  updateIgnoredApps(apps: string[]): void {
    this.updateCustomApps(apps);
  }

  start(): void {
    if (process.platform !== 'win32' || this.proc) return;
    this.disposed = false;

    const helperInfo = describeMicWatcherHelperResolution('win-mic-watcher.exe');
    const helperPath = helperInfo.resolvedPath;
    if (!helperPath) {
      emitMicWatcherStatus(this.events, {
        state: 'error',
        active: false,
        source: 'windows-wasapi-helper',
        confidence: 0,
        details: `win-mic-watcher.exe not found. Looked in: ${helperInfo.candidates.join(', ')}`
      });
      this.events.onError(new Error(`Windows mic watcher helper not found. Looked in: ${helperInfo.candidates.join(', ')}`));
      return;
    }

    try {
      const ignoredAppsArg = [...IGNORED_MIC_APPS, ...this.ignoredApps]
        .map((name) => name.toLowerCase())
        .join(';');
      const systemProcessesArg = SYSTEM_PROCESSES_TO_IGNORE.join(';');

      this.proc = spawn(helperPath, [ignoredAppsArg, systemProcessesArg], {
        stdio: ['ignore', 'pipe', 'pipe']
      });

      let buf = '';
      this.proc.stdout?.on('data', (d) => {
        buf += d.toString();
        let idx;
        while ((idx = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          this.onLine(line);
        }
      });

      this.proc.stderr?.on('data', (d) => {
        const s = d.toString().trim();
        if (s) {
          this.events.onError(new Error(`Windows mic helper stderr: ${s}`));
        }
      });

      this.proc.on('close', (code) => {
        this.proc = null;
        if (this.disposed) return;
        this.events.onError(new Error(`Windows mic helper exited with code ${code}`));
        this.scheduleRestart();
      });
    } catch (e: any) {
      this.events.onError(new Error(`Windows mic helper failed to start: ${e?.message ?? 'Error'}`));
    }
  }

  /** Restart a crashed helper (antivirus kill, audio driver reset) with backoff, up to a limit. */
  private scheduleRestart(): void {
    if (this.restartAttempts >= MAX_RESTART_ATTEMPTS) return;
    const delayMs = RESTART_BASE_DELAY_MS * 2 ** this.restartAttempts;
    this.restartAttempts += 1;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (!this.disposed) this.start();
    }, delayMs);
  }

  private onLine(line: string): void {
    // Any output means the helper is healthy again.
    this.restartAttempts = 0;
    if (/MIC_ACTIVE/i.test(line)) {
      emitMicWatcherStatus(this.events, {
        state: 'active',
        active: true,
        source: 'windows-wasapi-helper',
        confidence: 0.9
      });
    } else if (/MIC_INACTIVE/i.test(line)) {
      emitMicWatcherStatus(this.events, {
        state: 'inactive',
        active: false,
        source: 'windows-wasapi-helper',
        confidence: 0.9
      });
    } else if (/MIC_UNKNOWN/i.test(line)) {
      emitMicWatcherStatus(this.events, {
        state: 'unknown',
        active: false,
        source: 'windows-wasapi-helper',
        confidence: 0.35
      });
    }
  }

  stop(): void {
    this.disposed = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    try { this.proc?.kill('SIGTERM'); } catch { }
    this.proc = null;
  }

  isRunning(): boolean {
    return this.proc !== null && !this.disposed;
  }
}
