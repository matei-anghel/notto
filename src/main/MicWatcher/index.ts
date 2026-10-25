/**
 * Cross-Platform Microphone Watcher
 * 
 * Unified interface for detecting microphone usage across Windows, macOS, and Linux.
 * Each platform has its own implementation that emits state changes via callbacks.
 * 
 * Uses an ignored-apps approach: we detect microphone activity and filter out
 * known false positives.
 */

/**
 * Events emitted by mic watchers
 */
export type MicWatcherState = 'active' | 'inactive' | 'unknown' | 'error'

export interface MicWatcherStatus {
    state: MicWatcherState;
    active: boolean;
    source: string;
    confidence: number;
    details?: string;
}

export interface MicWatcherEvents {
    /** Called when mic state transitions (true = active, false = inactive) */
    onStateChange?: (active: boolean) => void;
    /** Called when mic status changes with platform-specific detail */
    onStatusChange?: (status: MicWatcherStatus) => void;
    /** Called when an error occurs */
    onError: (error: Error) => void;
}

/**
 * Configuration for mic watcher
 */
export interface MicWatcherConfig {
    /** Event callbacks */
    events: MicWatcherEvents;
    /** User-defined mic apps to ignore (in addition to defaults) */
    ignoredMicApps?: string[];
    /** Legacy alias kept for compatibility with existing main-process callers */
    customMeetingApps?: string[];
}

/**
 * Common interface for all platform-specific mic watchers
 */
export interface IMicWatcher {
    /** Start watching for mic state changes */
    start(): void;
    /** Stop watching and cleanup resources */
    stop(): void;
    /** Check if watcher is currently running */
    isRunning(): boolean;
    /** Update the ignored mic-app list at runtime */
    updateIgnoredApps?(apps: string[]): void;
    /** Legacy alias kept for compatibility with existing main-process callers */
    updateCustomApps?(apps: string[]): void;
}

export function emitMicWatcherStatus(events: MicWatcherEvents, status: MicWatcherStatus): void {
    events.onStatusChange?.(status);
    if (status.state === 'active' || status.state === 'inactive') {
        events.onStateChange?.(status.active);
    }
}

// Import platform-specific implementations
import { WindowsMicWatcher } from './WindowsMicWatcher';
import { LinuxMicWatcher } from './LinuxMicWatcher';
import { MacMicWatcher } from './MacMicWatcher';

/**
 * Factory function to create the appropriate mic watcher for the current platform
 * @param config Configuration including events and optional ignored mic apps
 */
export function createMicWatcher(config: MicWatcherConfig): IMicWatcher {
    const platform = process.platform;
    const ignoredApps = config.ignoredMicApps ?? config.customMeetingApps ?? [];

    switch (platform) {
        case 'win32':
            return new WindowsMicWatcher(config.events, ignoredApps);
        case 'darwin':
            return new MacMicWatcher(config.events, ignoredApps);
        case 'linux':
            return new LinuxMicWatcher(config.events);
        default:
            // Return a no-op watcher for unsupported platforms
            return new NoOpMicWatcher(config.events);
    }
}

/**
 * No-op watcher for unsupported platforms
 */
class NoOpMicWatcher implements IMicWatcher {
    constructor(private events: MicWatcherEvents) { }

    start(): void {
        emitMicWatcherStatus(this.events, {
            state: 'error',
            active: false,
            source: process.platform,
            confidence: 0,
            details: 'Unsupported platform'
        });
        this.events.onError(new Error(`Mic watcher not supported on platform: ${process.platform}`));
    }

    stop(): void { }

    isRunning(): boolean {
        return false;
    }
}

export { WindowsMicWatcher, LinuxMicWatcher, MacMicWatcher };
