/**
 * macOS Microphone Watcher
 * 
 * Ignored-app approach: detects any microphone usage, filters out known false positives.
 * This catches all meeting apps (current and future) without needing an allowlist.
 * 
 * Uses CoreAudio assertions (via pmset) to detect mic usage on Apple Silicon.
 * Falls back to IOAudioEngineNumActiveUserClients on Intel.
 */

import { app } from 'electron';
import { spawn, ChildProcess, execFile } from 'node:child_process';
import * as fs from 'node:fs';
import { promisify } from 'node:util';
import { emitMicWatcherStatus, type IMicWatcher, type MicWatcherEvents, type MicWatcherState } from './index';
import { describeMicWatcherHelperResolution, resolveMicWatcherHelper } from './helperPaths';
import { evaluateHelperClientCount, hasExternalMicUsageFromPmset } from './macosDetection';

const execFileAsync = promisify(execFile);

export class MacMicWatcher implements IMicWatcher {
    private proc: ChildProcess | null = null;
    private intervalId: NodeJS.Timeout | null = null;
    private pollInFlight = false;
    private lastStatusKey: string | null = null;
    private lastErrorKey: string | null = null;
    private disposed = false;
    private helperFallbackInFlight = false;
    private events: MicWatcherEvents;
    private ownPid: number;
    private ignoredApps: string[];

    constructor(events: MicWatcherEvents, ignoredApps: string[] = []) {
        this.events = events;
        this.ownPid = process.pid;
        this.ignoredApps = ignoredApps;
    }

    updateCustomApps(apps: string[]): void {
        this.ignoredApps = apps;
    }

    updateIgnoredApps(apps: string[]): void {
        this.updateCustomApps(apps);
    }

    start(): void {
        if (process.platform !== 'darwin' || this.proc || this.intervalId) return;

        const helperInfo = describeMicWatcherHelperResolution('mac-mic-watcher');
        const helperPath = helperInfo.resolvedPath ?? resolveMicWatcherHelper('mac-mic-watcher');

        if (helperPath) {
            this.startHelper(helperPath);
        } else {
            if (app.isPackaged) {
                this.reportError(
                    'Mac mic helper not found; falling back to polling',
                    helperInfo.candidates.join(', '),
                    'macos-helper'
                );
            }
            // Fall back to polling via system commands
            this.startPolling();
        }
    }

    private startHelper(helperPath: string): void {
        try {
            // Make sure it's executable
            try { fs.chmodSync(helperPath, 0o755); } catch { }

            this.proc = spawn(helperPath, [String(this.ownPid)], {
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
                    this.events.onError(new Error(`Mac mic helper stderr: ${s}`));
                }
            });

            this.proc.on('close', (code) => {
                if (!this.disposed) {
                    // Helper crashed, fall back to polling
                    this.reportError(
                        `Mac mic helper exited with code ${code}, falling back to polling`,
                        undefined,
                        'macos-helper'
                    );
                    this.proc = null;
                    this.startPolling();
                }
            });
        } catch (e: any) {
            this.reportError(`Failed to start mac mic helper: ${e?.message ?? 'Error'}`, undefined, 'macos-helper');
            this.startPolling();
        }
    }

    private startPolling(): void {
        // Delay before starting polling to avoid false positives from TCC permission checks at startup
        setTimeout(() => {
            if (this.disposed) return;

            // Poll every 1000ms to check audio device status
            this.intervalId = setInterval(() => { void this.checkMicUsage(); }, 1000);

            // Do initial check after the delay
            void this.checkMicUsage();
        }, 3000);
    }

    private async checkMicUsage(): Promise<void> {
        if (this.disposed || this.pollInFlight) {
            return;
        }

        this.pollInFlight = true;
        try {
            // First try Intel approach: IOAudioEngineNumActiveUserClients
            let ioregResult: string | null = null;
            try {
                ioregResult = await this.runCommand('/usr/sbin/ioreg', ['-c', 'AppleHDAEngineInput', '-d', '3'], 3000);
            } catch {
                ioregResult = null;
            }

            if (ioregResult !== null) {
                const clientMatch = ioregResult.match(/IOAudioEngineNumActiveUserClients["\s]*=["\s]*(\d+)/);
                const numClients = clientMatch ? parseInt(clientMatch[1], 10) : -1;

                if (numClients !== -1) {
                    this.lastErrorKey = null;
                    const helperState = evaluateHelperClientCount(numClients);
                    if (helperState === 'active') {
                        const details = numClients === 1
                            ? 'Single active input client detected'
                            : 'Multiple active input clients detected';
                        this.emitStatus('active', true, 0.9, details, 'macos-ioreg');
                    } else if (helperState === 'inactive') {
                        this.emitStatus('inactive', false, 0.9, 'No active input clients detected', 'macos-ioreg');
                    } else {
                        this.emitStatus('unknown', false, 0.4, 'Single active input client detected; cannot distinguish Notto from another app', 'macos-ioreg');
                    }
                    return;
                }
            }

            // Apple Silicon: Use pmset assertions to detect mic usage
            const pmsetResult = await this.runCommand('/usr/bin/pmset', ['-g', 'assertions'], 3000);
            const externalActive = await this.checkPmsetForMicUsage(pmsetResult);
            this.lastErrorKey = null;
            this.emitStatus(externalActive ? 'active' : 'inactive', externalActive, 0.65, undefined, 'macos-pmset');
        } catch (e: any) {
            this.reportError(`Mac mic check failed: ${e?.message ?? 'Error'}`, undefined, 'macos-polling');
        } finally {
            this.pollInFlight = false;
        }
    }

    /**
     * Ignored-app approach: detect any microphone usage by external apps.
     * 
     * Looks for coreaudiod assertions that reference BuiltInMicrophoneDevice
     * and checks the "Created for PID" to identify which app is using the mic.
     * Returns true if ANY non-ignored app is using the microphone.
     */
    private async checkPmsetForMicUsage(output: string): Promise<boolean> {
        return await hasExternalMicUsageFromPmset(output, {
            ownPid: this.ownPid,
            ignoredApps: this.ignoredApps,
            getProcessName: (pid) => this.getProcessName(pid)
        });
    }

    private async getProcessName(pid: number): Promise<string | null> {
        try {
            const stdout = await this.runCommand('/bin/ps', ['-p', String(pid), '-o', 'comm='], 1000);
            const procName = stdout.trim();
            return procName ? procName : null;
        } catch {
            return null;
        }
    }

    private async runCommand(command: string, args: string[], timeoutMs: number): Promise<string> {
        const { stdout } = await execFileAsync(command, args, {
            encoding: 'utf8',
            timeout: timeoutMs,
            maxBuffer: 1024 * 1024
        });
        return stdout as string;
    }

    private onLine(line: string): void {
        if (/MIC_ACTIVE/i.test(line)) {
            this.emitStatus('active', true, 0.95, undefined, 'macos-helper');
        } else if (/MIC_INACTIVE/i.test(line)) {
            this.emitStatus('inactive', false, 0.95, undefined, 'macos-helper');
        } else if (/MIC_UNKNOWN/i.test(line)) {
            void this.fallbackFromUnknownHelper();
        }
    }

    private async fallbackFromUnknownHelper(): Promise<void> {
        if (this.disposed || this.helperFallbackInFlight) return;

        this.helperFallbackInFlight = true;
        try {
            const pmsetResult = await this.runCommand('/usr/bin/pmset', ['-g', 'assertions'], 3000);
            const externalActive = await this.checkPmsetForMicUsage(pmsetResult);
            this.emitStatus(externalActive ? 'active' : 'inactive', externalActive, 0.65, 'Resolved helper ambiguity via pmset assertions', 'macos-pmset');
        } catch (e: any) {
            this.emitStatus('unknown', false, 0.35, e?.message ?? 'Unable to resolve helper ambiguity', 'macos-helper');
        } finally {
            this.helperFallbackInFlight = false;
        }
    }

    private emitStatus(state: MicWatcherState, active: boolean, confidence: number, details?: string, source = 'macos'): void {
        const key = `${state}:${details ?? ''}:${source}`;
        if (this.lastStatusKey === key) return;
        this.lastStatusKey = key;
        if (state !== 'error') {
            this.lastErrorKey = null;
        }
        emitMicWatcherStatus(this.events, {
            state,
            active,
            confidence,
            details,
            source
        });
    }

    private reportError(message: string, details?: string, source = 'macos'): void {
        const key = `${source}:${message}:${details ?? ''}`;
        if (this.lastErrorKey === key) return;
        this.lastErrorKey = key;

        emitMicWatcherStatus(this.events, {
            state: 'error',
            active: false,
            source,
            confidence: 0,
            details: details ? `${message} - ${details}` : message
        });
        this.events.onError(new Error(details ? `${message}: ${details}` : message));
    }

    stop(): void {
        this.disposed = true;

        if (this.proc) {
            try { this.proc.kill('SIGTERM'); } catch { }
            this.proc = null;
        }

        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = null;
        }

        this.lastStatusKey = null;
        this.helperFallbackInFlight = false;
    }

    isRunning(): boolean {
        return (this.proc !== null || this.intervalId !== null) && !this.disposed;
    }
}
