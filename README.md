# Notto

Notto is a free, open-source desktop assistant for notes, dictation and meetings. It runs on Windows, macOS and Linux, works with the AI provider of your choice, and keeps your data on your device.

- **Dictation anywhere**: hold or toggle a shortcut, speak, and the text is pasted into the app you're using.
- **AI mode**: speak a request ("reply to this email politely") and Notto answers with your screen as context.
- **Chat overlay**: an always-on-top AI chat with screenshots, file attachments (PDF, Word, Excel, text) and your notes as context. It can be hidden from screen sharing.
- **Meeting notes**: record the microphone and system audio, then get a transcript and structured notes with decisions and action items.
- **Chat with your notes**: ask a question and Notto finds the relevant meetings and notes on your device, answers from them and cites its sources.
- **Share meeting notes**: copy as Markdown, save a `.md` file, or start an email with the notes in one click.
- **Quick notes**: a floating notepad that's always one shortcut away.

No account, no subscription, no server. You bring your own API keys and pay your provider directly, or you pay nothing by running models locally.

## AI providers

Configure providers in **Settings → AI Providers**. Notto uses up to three models: one for chat, an optional one for images and screenshots, and one for transcription.

| Provider | Chat | Transcription |
|---|---|---|
| OpenAI | ✓ | ✓ (gpt-4o-transcribe, whisper-1) |
| Anthropic (Claude) | ✓ | |
| Google Gemini | ✓ | |
| OpenRouter | ✓ | |
| Groq | ✓ | ✓ (Whisper) |
| Mistral | ✓ | ✓ (Voxtral) |
| DeepSeek, xAI, Together, Fireworks, Cerebras, Perplexity | ✓ | Together only |
| Deepgram | | ✓, including live streaming dictation |
| Ollama, LM Studio (local) | ✓ | |
| Any OpenAI-compatible server (vLLM, llama.cpp, LocalAI, speaches, …) | ✓ | ✓ |

Any model ID your provider accepts can be used; the settings screen can also load the provider's live model list. For a fully offline setup, use Ollama or LM Studio for chat and a local Whisper server such as [speaches](https://github.com/speaches-ai/speaches) as the custom transcription endpoint.

API keys are stored encrypted with your operating system's credential store (Windows DPAPI, macOS Keychain, libsecret/KWallet on Linux) and never leave the main process except in requests to the provider you chose.

## Install

Download the latest release for your platform from the [releases page](https://github.com/matei-anghel/notto-releases/releases/latest).

- **Windows**: run `Notto-Setup.exe`. The installer is not code-signed, so SmartScreen may ask you to confirm.
- **macOS**: open the `.dmg` and drag Notto to Applications. Grant microphone, screen recording and accessibility permissions when asked; the onboarding screen walks you through them.
- **Linux**: install the `.deb` (it pulls in `xdotool`, used to paste dictation) or run the AppImage. Global shortcuts and automatic paste require an X11 session.

## Build from source

Requirements: Node.js 22.13 or newer. No C++ toolchain is needed; native modules ship prebuilt binaries.

```bash
npm install
npm start          # build and launch in development
npm test           # unit tests
npm run typecheck
npm run dist       # package for the current platform into release/
```

Optional native helpers detect when another app starts using the microphone (to offer meeting notes):

- Windows: `npm run build:win-helper` (needs the .NET 8 SDK)
- macOS: `npm run build:mac-helper` (needs Xcode command line tools)

Without them, the rest of the app works normally.

## Project layout

```
src/main.ts              Electron main process: windows, tray, shortcuts, lifecycle
src/main/ai/             Provider client (OpenAI-compatible, Anthropic, Deepgram), key store, prompts
src/main/*Ipc.ts         IPC handlers grouped by feature (chat, audio, notes, settings, …)
src/shared/              Code shared by main and renderer (provider catalog, IPC channel names, …)
src/renderer.ts          Main window UI;  src/chat.ts  chat overlay;  src/notes-float.ts  quick notes
src/preload.ts           The only bridge between renderers and the main process
resources/helpers/       Native mic-watcher helpers (C# for Windows, Swift for macOS)
tests/                   Node test runner unit tests
web/                     Project website and download page (deployed to GitHub Pages by .github/workflows/pages.yml)
```

## Privacy

Notes, transcripts, chat history and recordings are stored in `~/notto/electron/userData` on your machine. Notto sends data only to the AI providers you configure, when you use a feature that needs them. Update checks contact GitHub Releases.

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Notto is licensed under the [GNU General Public License v3.0](LICENSE).
