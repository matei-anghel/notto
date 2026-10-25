/**
 * macOS Microphone Watcher Helper
 * 
 * Native Swift binary that uses CoreAudio to detect microphone usage by OTHER applications.
 * Tracks the number of active audio clients and detects when only our app remains.
 * Outputs "MIC_ACTIVE" or "MIC_INACTIVE" on stdout when external mic usage state changes.
 * 
 * Usage: mac-mic-watcher [parent_pid]
 *   parent_pid: Parent process ID - watcher exits if parent dies
 * 
 * Build:
 *   swiftc -O -o mac-mic-watcher MacMicWatcher.swift
 */

import Foundation
import CoreAudio
import Darwin

class MicWatcher {
    var lastStatus = "MIC_INACTIVE"
    var parentPid: pid_t = 0
    var timer: Timer?
    var parentCheckTimer: Timer?
    
    init(parentPid: pid_t = 0) {
        self.parentPid = parentPid
    }
    
    func start() {
        // Initial check
        checkMicStatus()
        
        // Poll every 1 second for mic status
        timer = Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { [weak self] _ in
            self?.checkMicStatus()
        }
        
        // Check if parent process is still alive every 5 seconds
        if parentPid > 0 {
            parentCheckTimer = Timer.scheduledTimer(withTimeInterval: 5.0, repeats: true) { [weak self] _ in
                guard let self = self else { return }
                if kill(self.parentPid, 0) != 0 {
                    // Parent died, exit
                    exit(0)
                }
            }
        }
        
        // Keep the run loop alive
        RunLoop.main.run()
    }
    
    func checkMicStatus() {
        var propertySize: UInt32 = 0
        var propertyAddress = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDefaultInputDevice,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        
        // Get default input device
        var deviceID: AudioDeviceID = 0
        propertySize = UInt32(MemoryLayout<AudioDeviceID>.size)
        
        let status = AudioObjectGetPropertyData(
            AudioObjectID(kAudioObjectSystemObject),
            &propertyAddress,
            0,
            nil,
            &propertySize,
            &deviceID
        )
        
        guard status == noErr && deviceID != 0 else {
            updateState("MIC_INACTIVE")
            return
        }
        
        // Check if device is running somewhere (any app using it)
        propertyAddress.mSelector = kAudioDevicePropertyDeviceIsRunningSomewhere
        var isRunning: UInt32 = 0
        propertySize = UInt32(MemoryLayout<UInt32>.size)
        
        let runningStatus = AudioObjectGetPropertyData(
            deviceID,
            &propertyAddress,
            0,
            nil,
            &propertySize,
            &isRunning
        )
        
        guard runningStatus == noErr else {
            updateState("MIC_INACTIVE")
            return
        }
        
        // If nothing is running, definitely inactive
        if isRunning == 0 {
            updateState("MIC_INACTIVE")
            return
        }
        
        // Mic is running - check how many processes are using it via IOKit
        // Use ioreg to get count of active user clients
        let numClients = getNumActiveUserClients()
        
        // Logic:
        // - If numClients >= 1: At least one app is using the mic. Main-process suppression
        //   logic decides whether Notto itself should ignore that transition.
        // - If numClients == 0: inactive.
        // - If numClients == -1: unsupported hardware path, emit unknown so Electron can
        //   fall back to pmset-based per-process parsing in the same cycle.

        let statusLabel: String
        if numClients >= 1 {
            statusLabel = "MIC_ACTIVE"
        } else if numClients == 0 {
            statusLabel = "MIC_INACTIVE"
        } else {
            statusLabel = "MIC_UNKNOWN"
        }

        updateState(statusLabel)
    }
    
    func getNumActiveUserClients() -> Int {
        // Run ioreg command to get IOAudioEngineNumActiveUserClients
        // This works on Intel Macs with AppleHDA
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/usr/sbin/ioreg")
        task.arguments = ["-c", "AppleHDAEngineInput", "-d", "3"]
        
        let pipe = Pipe()
        task.standardOutput = pipe
        task.standardError = FileHandle.nullDevice
        
        do {
            try task.run()
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            task.waitUntilExit()
            
            if let output = String(data: data, encoding: .utf8) {
                // Look for IOAudioEngineNumActiveUserClients = X
                let pattern = "IOAudioEngineNumActiveUserClients.*=.*?(\\d+)"
                if let regex = try? NSRegularExpression(pattern: pattern),
                   let match = regex.firstMatch(in: output, range: NSRange(output.startIndex..., in: output)),
                   let range = Range(match.range(at: 1), in: output) {
                    return Int(output[range]) ?? 0
                }
            }
        } catch {
            // ioreg failed or no AppleHDA (Apple Silicon uses different drivers)
        }
        
        // Apple Silicon fallback: try to count from audio tap sessions
        // Since we can't easily get per-process info, return -1 to indicate unknown
        // The caller will fall back to using isRunningSomewhere alone
        return -1
    }
    
    func updateState(_ statusLabel: String) {
        if statusLabel != lastStatus {
            print(statusLabel)
            fflush(stdout)
            lastStatus = statusLabel
        }
    }
}

// Parse command line arguments
var parentPid: pid_t = 0
if CommandLine.arguments.count > 1 {
    if let pid = Int32(CommandLine.arguments[1]) {
        parentPid = pid
    }
}

// Start the watcher
let watcher = MicWatcher(parentPid: parentPid)
watcher.start()
