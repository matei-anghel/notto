# Screenshot Placeholders for Download Page

This directory should contain screenshots of security warnings for the download page.

## Required Screenshots

### Windows
- `win-step1.png` - Windows SmartScreen "Windows protected your PC" blue popup
- `win-step2.png` - After clicking "More info", showing the "Run anyway" button

### macOS  
- `mac-step1.jpg` - warning
- `mac-step2.jpg` - in system settings scroll down -> go to privacy and security -> scroll down
- `mac-step3.jpg` - click Open Anyway and confirm
- `mac-step4.png` - input password

## How to Capture These

1. Build the app using the new release pipeline
2. Download the installer on each platform
3. Trigger the security warnings and take screenshots
4. Save them here with the exact filenames listed above

The download page will gracefully handle missing images with placeholder text.
