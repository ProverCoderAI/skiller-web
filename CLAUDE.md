# Skiller Web — agent guidance

Skiller Web is a local web service for installing, syncing, and editing AI
agent skills across many agents. It serves a React UI and a tRPC API from the
same process.

## Stack

| Layer | Tech |
| --- | --- |
| Server | Node/Bun HTTP server in `src/server/index.ts` |
| UI | React 19, Vite 7, Tailwind CSS 4, `react-router-dom` |
| API | tRPC over HTTP at `/trpc/*`; push events over SSE at `/events` |
| Core | `src/main/**` skill scanning, install, repos, projects, settings |
| Shared | `src/shared/**` RPC schema and platform abstractions |

## Commands

```bash
bun install
bun run dev
bun run typecheck
bun test src/shared/skill-footprint.test.ts
bun run build
bun run start
```

`bun run dev` starts the API server on `127.0.0.1:17888` and Vite on
`127.0.0.1:5180`. `bun run build` emits `out/renderer` and `out/server`.

## Runtime

| Variable | Purpose |
| --- | --- |
| `SKILLER_HOST` | Bind host, default `127.0.0.1` |
| `SKILLER_PORT` | Bind port, default `17888` |
| `SKILLER_STATIC_DIR` | Renderer build dir, default `out/renderer` |
| `SKILLER_ALLOWED_ORIGINS` | Extra CORS origins for Vite/API access |
| `DOCKER_GIT_API_URL` | Default docker-git backend URL for `/launch` |
| `SKILLER_ALLOWED_DOCKER_GIT_ORIGINS` | Non-local docker-git origins allowed for `/launch` |

The docker-git entrypoint is
`/launch?backendUrl=<docker-git-api-url>&projectKey=<key>&sessionId=<optional>`.
The server injects docker-git browser scope when the backend context endpoint is
available; the renderer also accepts inline `scope`/`scopeJson` launch params.

## Conventions

- Keep filesystem and network effects in `src/server/**` or `src/main/**`; the
  React UI talks through `src/mainview/lib/native.ts`.
- Keep `AppPlatform` host methods web-safe. Desktop-only behavior should be a
  no-op or browser-native action in `src/server/platform-web.ts`.
- Use `@/` imports for renderer/shared paths.
- After RPC changes, update `src/main/rpc-handlers.ts`,
  `src/main/trpc/router.ts`, `src/shared/rpc-schema.ts`, and renderer callers
  together.
- Do not reintroduce Electron packaging or preload entrypoints in this fork.
