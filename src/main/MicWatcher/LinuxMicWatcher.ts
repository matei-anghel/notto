/**
 * Linux Microphone Watcher
 * 
 * Polls PulseAudio (pactl) or PipeWire (pw-dump) to detect active audio capture streams.
 * Filters out streams from the current process to avoid self-detection.
 */

import { spawn, ChildProcess, execSync } from 'node:child_process';
import { emitMicWatcherStatus, type IMicWatcher, type MicWatcherEvents } from './index';

export class LinuxMicWatcher implements IMicWatcher {
    private intervalId: NodeJS.Timeout | null = null;
    private checkInFlight = false;
    private lastActive: boolean | null = null;
    private lastErrorKey: string | null = null;
    private events: MicWatcherEvents;
    private usePipeWire = false;
    private ownPid: number;
    private parentPid: number;
    private backendAvailable = false;

    constructor(events: MicWatcherEvents) {
        this.events = events;
        this.ownPid = process.pid;
        this.parentPid = this.getParentPid();

        // Detect which audio system is available
        this.detectAudioSystem();
    }

    private detectAudioSystem(): void {
        try {
            // Try pactl first (works with PulseAudio and PipeWire-Pulse)
            execSync('which pactl', { stdio: 'ignore' });
            this.usePipeWire = false;
            this.backendAvailable = true;
        } catch {
            try {
                // Fall back to pw-dump for pure PipeWire
                execSync('which pw-dump', { stdio: 'ignore' });
                this.usePipeWire = true;
                this.backendAvailable = true;
            } catch {
                this.backendAvailable = false;
            }
        }
    }

    start(): void {
        if (process.platform !== 'linux' || this.intervalId) return;

        if (!this.backendAvailable) {
            this.reportError('Linux mic backend not found', 'Neither pactl nor pw-dump is available');
            return;
        }

        // Poll every 1000ms
        this.intervalId = setInterval(() => { void this.check(); }, 1000);

        // Do initial check immediately
        void this.check();
    }

    private async check(): Promise<void> {
        if (this.checkInFlight) {
            return;
        }

        this.checkInFlight = true;
        try {
            const active = this.usePipeWire
                ? await this.checkPipeWire()
                : await this.checkPulseAudio();

            this.lastErrorKey = null;
            if (this.lastActive !== active) {
                this.lastActive = active;
                emitMicWatcherStatus(this.events, {
                    state: active ? 'active' : 'inactive',
                    active,
                    source: this.usePipeWire ? 'linux-pipewire' : 'linux-pulseaudio',
                    confidence: 0.7
                });
            }
        } catch (e: any) {
            this.reportError(`Linux mic check failed: ${e?.message ?? 'Error'}`, undefined, this.usePipeWire ? 'linux-pipewire' : 'linux-pulseaudio');
        } finally {
            this.checkInFlight = false;
        }
    }

    private checkPulseAudio(): Promise<boolean> {
        return new Promise((resolve, reject) => {
            // List active source outputs (recording streams)
            const proc = spawn('pactl', ['list', 'source-outputs', 'short'], {
                stdio: ['ignore', 'pipe', 'pipe']
            });

            let stdout = '';
            let settled = false;
            const finish = (fn: () => void): void => {
                if (settled) return;
                settled = true;
                fn();
            };

            proc.stdout?.on('data', (d) => { stdout += d.toString(); });
            proc.on('error', (error) => finish(() => reject(error)));

            proc.on('close', (code) => {
                if (code !== 0) {
                    finish(() => reject(new Error(`pactl exited with code ${code}`)));
                    return;
                }

                // Parse output: each line is a source-output
                // Format: <index>\t<source>\t<client>\t<format>
                const lines = stdout.trim().split('\n').filter(l => l.trim());

                // Filter out our own process
                // We need to check client PIDs - use pactl list source-outputs for detailed info
                if (lines.length === 0) {
                    finish(() => resolve(false));
                    return;
                }

                // For simple detection, check if any non-empty output exists
                // More sophisticated filtering would require parsing client info
                this.getActiveSourceOutputPids().then(pids => {
                    // Filter out our own PID and parent PID
                    const externalActive = pids.some(pid =>
                        pid !== this.ownPid && pid !== this.parentPid && pid !== 0
                    );
                    finish(() => resolve(externalActive));
                }).catch(() => {
                    // Fall back to simple check - any source output means active
                    finish(() => resolve(lines.length > 0));
                });
            });

            // Timeout safety
            setTimeout(() => {
                try { proc.kill(); } catch { }
                finish(() => reject(new Error('pactl check timed out')));
            }, 3000);
        });
    }

    private getActiveSourceOutputPids(): Promise<number[]> {
        return new Promise((resolve, reject) => {
            const proc = spawn('pactl', ['list', 'source-outputs'], {
                stdio: ['ignore', 'pipe', 'pipe']
            });

            let stdout = '';
            let settled = false;
            const finish = (fn: () => void): void => {
                if (settled) return;
                settled = true;
                fn();
            };

            proc.stdout?.on('data', (d) => { stdout += d.toString(); });
            proc.on('error', (error) => finish(() => reject(error)));

            proc.on('close', (code) => {
                if (code !== 0) {
                    finish(() => reject(new Error(`pactl exited with code ${code}`)));
                    return;
                }

                // Parse for "application.process.id" property
                const pidMatches = stdout.matchAll(/application\.process\.id\s*=\s*"?(\d+)"?/g);
                const pids: number[] = [];
                for (const match of pidMatches) {
                    pids.push(parseInt(match[1], 10));
                }
                finish(() => resolve(pids));
            });

            setTimeout(() => {
                try { proc.kill(); } catch { }
                finish(() => reject(new Error('pactl list source-outputs timed out')));
            }, 3000);
        });
    }

    private checkPipeWire(): Promise<boolean> {
        return new Promise((resolve, reject) => {
            const proc = spawn('pw-dump', [], {
                stdio: ['ignore', 'pipe', 'pipe']
            });

            let stdout = '';
            let settled = false;
            const finish = (fn: () => void): void => {
                if (settled) return;
                settled = true;
                fn();
            };

            proc.stdout?.on('data', (d) => { stdout += d.toString(); });
            proc.on('error', (error) => finish(() => reject(error)));

            proc.on('close', (code) => {
                if (code !== 0) {
                    finish(() => reject(new Error(`pw-dump exited with code ${code}`)));
                    return;
                }

                try {
                    const dump = JSON.parse(stdout);

                    // Look for active capture streams
                    const activeStreams = dump.filter((node: any) => {
                        // Check for audio capture nodes
                        if (node.type !== 'PipeWire:Interface:Node') return false;

                        const mediaClass = node.info?.props?.['media.class'];
                        if (mediaClass !== 'Stream/Input/Audio') return false;

                        // Check if node is active
                        const state = node.info?.state;
                        if (state !== 'running') return false;

                        // Filter out our own process
                        const nodePid = node.info?.props?.['application.process.id'];
                        if (nodePid === this.ownPid || nodePid === this.parentPid) return false;

                        return true;
                    });

                    finish(() => resolve(activeStreams.length > 0));
                } catch {
                    finish(() => resolve(false));
                }
            });

            setTimeout(() => {
                try { proc.kill(); } catch { }
                finish(() => reject(new Error('pw-dump timed out')));
            }, 5000);
        });
    }

    private reportError(message: string, details?: string, source = 'linux'): void {
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

    private getParentPid(): number {
        try {
            const ppid = execSync(`ps -o ppid= -p ${this.ownPid}`, { encoding: 'utf8' });
            return parseInt(ppid.trim(), 10);
        } catch {
            return -1;
        }
    }

    stop(): void {
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = null;
        }
        this.lastActive = null;
    }

    isRunning(): boolean {
        return this.intervalId !== null;
    }
}
