# Contributing to Notto

Thanks for helping out. A few guidelines keep things smooth.

## Development setup

```bash
npm install
npm start
```

`npm start` bundles with esbuild into `dist/` and launches Electron. To try AI features, add a provider in **Settings → AI Providers**. A local Ollama or LM Studio server works without any key.

## Before opening a pull request

```bash
npm run typecheck
npm test
```

- Keep changes focused: one fix or feature per pull request.
- Match the surrounding style. The code base uses TypeScript, two-space indentation, and no semicolons in most files.
- Add or update tests in `tests/` for behavior changes in `src/main` and `src/shared`.
- Never commit API keys, `.env` files or certificates. Keys belong in the app's settings, which store them encrypted outside the repository.

## Architecture notes

- Renderers have no Node.js access. Everything goes through `src/preload.ts`, and the main process checks `isTrustedRendererEvent` on every IPC call.
- All AI traffic goes through `src/main/ai/aiClient.ts`. To add a provider, add an entry to `src/shared/aiProviders.ts`. OpenAI-compatible APIs need nothing else.
- Platform-specific code (Windows `win32-api`, macOS permissions, Linux `xdotool`) must be guarded by `process.platform` checks.

## Reporting security issues

Please report vulnerabilities privately through GitHub security advisories rather than public issues.
