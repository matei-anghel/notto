#!/bin/bash
# Build script for macOS microphone watcher helper binary
# Run this on a macOS machine before packaging the app

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
HELPER_SRC="$PROJECT_ROOT/resources/helpers/macos/MacMicWatcher.swift"
BIN_DIR="$PROJECT_ROOT/resources/bin"

echo "Building macOS mic watcher helper..."

# Create output directories
mkdir -p "$BIN_DIR/darwin-x64"
mkdir -p "$BIN_DIR/darwin-arm64"

# Build for x64 (Intel)
echo "Building for x64 (Intel)..."
swiftc -O -target x86_64-apple-macos10.15 \
    -o "$BIN_DIR/darwin-x64/mac-mic-watcher" \
    "$HELPER_SRC"

# Build for arm64 (Apple Silicon)
echo "Building for arm64 (Apple Silicon)..."
swiftc -O -target arm64-apple-macos11 \
    -o "$BIN_DIR/darwin-arm64/mac-mic-watcher" \
    "$HELPER_SRC"

# Make binaries executable
chmod +x "$BIN_DIR/darwin-x64/mac-mic-watcher"
chmod +x "$BIN_DIR/darwin-arm64/mac-mic-watcher"

echo "Done! Binaries created:"
echo "  - $BIN_DIR/darwin-x64/mac-mic-watcher"
echo "  - $BIN_DIR/darwin-arm64/mac-mic-watcher"
