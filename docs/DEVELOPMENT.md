# Development Guide

Developer setup, build, and debugging instructions for Skiller Web.

## Prerequisites

- Bun 1.3+
- Node-compatible runtime for the built server
- Git available on PATH for repository-backed skill installs

## Local Setup

```bash
bun install
```

## Run Modes

```bash
# API server on 127.0.0.1:17888 and Vite UI on 127.0.0.1:5180
bun run dev

# Server only
bun run dev:server

# Vite UI only, proxying /trpc, /events, and /health to SKILLER_PORT
bun run dev:client
```

## Checks

```bash
bun run typecheck
bun test src/shared/skill-footprint.test.ts
```

TypeScript ownership:

- `tsconfig.json` checks the renderer and shared browser-safe types.
- `tsconfig.server.json` checks `src/server/**`, `src/main/**`, and `src/shared/**`.

## Build And Serve

```bash
bun run build
bun run start
```

Build outputs:

- `out/renderer` — static Vite UI.
- `out/server/index.js` — Node-targeted server bundle.

`bun run preview` serves the current `out/renderer` through the built-style web
server without rebuilding.

## Runtime Variables

| Variable | Purpose |
| --- | --- |
| `SKILLER_HOST` | Bind host, default `127.0.0.1` |
| `SKILLER_PORT` | Bind port, default `17888` |
| `SKILLER_STATIC_DIR` | Renderer build directory, default `out/renderer` |
| `SKILLER_ALLOWED_ORIGINS` | Extra CORS origins for API/SSE access |
| `DOCKER_GIT_API_URL` | Default docker-git backend URL for `/launch` |
| `SKILLER_ALLOWED_DOCKER_GIT_ORIGINS` | Non-local docker-git backend origins allowed by `/launch` |

Keep the default localhost binding unless the service is protected by external
auth. Skiller can install skills and write project files.

## docker-git Launch Flow

Open:

```text
/launch?backendUrl=<docker-git-api-url>&projectKey=<key>&sessionId=<optional>
```

The server validates the docker-git backend origin, fetches the Skiller context,
injects the browser scope into the page, and registers the project path when the
backend supplies one. The renderer can also accept inline `scope` or `scopeJson`
params for browser-only launch tests.

## Architecture Notes

- `src/server/index.ts` owns HTTP routing, static serving, `/launch`, `/events`,
  and `/trpc`.
- `src/server/platform-web.ts` implements desktop host calls as web-safe no-ops.
- `src/mainview/lib/native.ts` resolves tRPC base URLs, handles SSE push, and
  provides the docker-git scoped folder picker.
- `src/main/**` remains the reusable skill-management core.
