import { nodeHTTPRequestHandler } from "@trpc/server/adapters/node-http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createAppRouter } from "../main/trpc/router";
import { setPackagedResourcesDir, setPackagedViewsDir } from "../main/paths";
import type { BunSideRpc } from "../main/rpc-handlers";
import { initAppUpdater, stopAppUpdater } from "../main/app-updater";
import { startSkillWatcher } from "../main/watcher";
import { createWebPlatform } from "./platform-web";

type PushEnvelope = {
  readonly name: string;
  readonly payload?: unknown;
};

type PushListener = (event: PushEnvelope) => void;

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 17888;
const DEFAULT_DEV_ORIGIN = "http://127.0.0.1:5180";

const env = process.env;
const host = env.SKILLER_HOST?.trim() || DEFAULT_HOST;
const port = parsePort(env.SKILLER_PORT ?? env.PORT, DEFAULT_PORT);
const staticDir = resolve(env.SKILLER_STATIC_DIR?.trim() || "out/renderer");

setPackagedResourcesDir(process.cwd());
setPackagedViewsDir(staticDir);

let stopWatcher: (() => void) | null = null;
const pushListeners = new Set<PushListener>();

const rpc: BunSideRpc = {
  send: (name, payload) => {
    const event = { name, payload };
    for (const listener of pushListeners) {
      listener(event);
    }
  },
};

const router = createAppRouter({
  ensureSkillWatcherStarted: () => {
    if (stopWatcher !== null) return;
    stopWatcher = startSkillWatcher(() => {
      rpc.send("skills_changed");
    });
  },
  platform: createWebPlatform(),
  rpc,
});

initAppUpdater((status) => {
  rpc.send("app_update_status_changed", status);
});

export function createSkillerServer(): Server {
  return createServer((request, response) => {
    void handleSkillerRequest(request, response);
  });
}

export function startSkillerServer(): Server {
  const server = createSkillerServer();
  server.listen(port, host, () => {
    const address = server.address() as AddressInfo | null;
    const boundPort = address?.port ?? port;
    console.log(`Skiller web listening on http://${host}:${boundPort}`);
  });

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      stopAppUpdater();
      stopWatcher?.();
      server.close(() => {
        process.exit(0);
      });
    });
  }

  return server;
}

if (isCliEntrypoint()) {
  startSkillerServer();
}

function isCliEntrypoint(): boolean {
  const entrypoint = process.argv[1];
  return entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href;
}

export async function handleSkillerRequest(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  await handleRequest(request, response).catch((error: unknown) => {
    writeText(response, 500, error instanceof Error ? error.message : String(error));
  });
}

function parsePort(raw: string | undefined, fallback: number): number {
  const parsed = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 && parsed < 65536 ? parsed : fallback;
}

async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

  if (url.pathname === "/health") {
    writeJson(response, 200, {
      ok: true,
      staticDir,
      trpcPath: "/trpc",
    });
    return;
  }

  if (url.pathname === "/events") {
    handleEvents(request, response);
    return;
  }

  if (url.pathname === "/launch") {
    await serveLaunch(url, response);
    return;
  }

  if (url.pathname === "/trpc" || url.pathname.startsWith("/trpc/")) {
    await handleTrpc(request, response, url);
    return;
  }

  serveStatic(url.pathname, response, "");
}

function handleEvents(request: IncomingMessage, response: ServerResponse): void {
  const corsOrigin = resolveCorsOrigin(request.headers.origin);
  if (corsOrigin !== null) {
    response.setHeader("Access-Control-Allow-Origin", corsOrigin);
    response.setHeader("Vary", "Origin");
  }
  response.writeHead(200, {
    "cache-control": "no-cache, no-transform",
    "connection": "keep-alive",
    "content-type": "text/event-stream; charset=utf-8",
  });
  response.write(`data: ${JSON.stringify({ name: "connected" })}\n\n`);

  const listener: PushListener = (event) => {
    response.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  pushListeners.add(listener);
  const ping = setInterval(() => {
    response.write(": ping\n\n");
  }, 25_000);

  request.on("close", () => {
    clearInterval(ping);
    pushListeners.delete(listener);
  });
}

async function handleTrpc(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
): Promise<void> {
  const corsOrigin = resolveCorsOrigin(request.headers.origin);
  if (corsOrigin !== null) {
    response.setHeader("Access-Control-Allow-Origin", corsOrigin);
    response.setHeader("Vary", "Origin");
  }
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  response.setHeader(
    "Access-Control-Allow-Headers",
    "content-type, trpc-accept, x-trpc-source, authorization",
  );
  if (request.method === "OPTIONS") {
    response.statusCode = 204;
    response.end();
    return;
  }

  const path = url.pathname.slice("/trpc".length).replace(/^\//u, "");
  await nodeHTTPRequestHandler({
    createContext: () => ({}),
    path,
    req: request,
    res: response,
    router,
  });
}

function resolveCorsOrigin(rawOrigin: string | undefined): string | null {
  if (rawOrigin === undefined) return null;
  const allowed = allowedOriginSet();
  if (allowed.has(rawOrigin)) return rawOrigin;
  try {
    const origin = new URL(rawOrigin);
    if (isLocalHostName(origin.hostname) && origin.port === "5180") {
      return rawOrigin;
    }
  } catch {
    return null;
  }
  return null;
}

function allowedOriginSet(): Set<string> {
  const configured = env.SKILLER_ALLOWED_ORIGINS ?? DEFAULT_DEV_ORIGIN;
  return new Set(
    configured
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part.length > 0),
  );
}

async function serveLaunch(url: URL, response: ServerResponse): Promise<void> {
  const context = loadDockerGitLaunchContext(url);
  const bootstrap = [
    "<script>",
    `window.__DOCKER_GIT_API_URL__=${scriptJson(context.backendUrl)};`,
    `window.__DOCKER_GIT_SKILLER_SCOPE__=${scriptJson(context.browserScope)};`,
    `window.__SKILLER_LAUNCH__=${scriptJson(context.launch)};`,
    "</script>",
  ].join("");
  serveStatic("/", response, bootstrap);
}

function loadDockerGitLaunchContext(url: URL): {
  readonly backendUrl: string | null;
  readonly browserScope: null;
  readonly launch: {
    readonly backendUrl: string | null;
    readonly projectKey: string | null;
    readonly sessionId: string | null;
  };
} {
  const backendUrl = resolveDockerGitBackendUrl(url.searchParams.get("backendUrl"));
  const projectKey = nonEmpty(url.searchParams.get("projectKey"));
  const sessionId = nonEmpty(url.searchParams.get("sessionId"));
  const launch = { backendUrl, projectKey, sessionId };

  return { backendUrl, browserScope: null, launch };
}

function nonEmpty(value: string | null): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length === 0 ? null : trimmed;
}

function resolveDockerGitBackendUrl(raw: string | null): string | null {
  const candidate = nonEmpty(raw) ?? nonEmpty(env.DOCKER_GIT_API_URL ?? null);
  if (candidate === null) return null;
  const parsed = new URL(candidate);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("docker-git backend URL must use http or https");
  }
  parsed.hash = "";
  parsed.search = "";
  return trimTrailingSlashes(parsed.toString());
}

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/u, "");
}

function isLocalHostName(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
}

function serveStatic(pathname: string, response: ServerResponse, bootstrap: string): void {
  const filePath = resolveStaticPath(pathname);
  if (filePath === null) {
    writeText(response, 404, "Skiller web build was not found. Run `bun run build` first.");
    return;
  }
  const content = readFileSync(filePath);
  const headers = {
    "cache-control": "no-store",
    "content-type": contentTypeForPath(filePath),
  };
  response.writeHead(200, headers);
  if (filePath.endsWith(".html") && bootstrap.length > 0) {
    response.end(injectBootstrap(content.toString("utf8"), bootstrap));
    return;
  }
  response.end(content);
}

function resolveStaticPath(pathname: string): string | null {
  const indexPath = join(staticDir, "index.html");
  if (!existsSync(indexPath)) return null;
  const decodedPath = decodeURIComponent(pathname === "/" ? "/index.html" : pathname);
  const target = resolve(staticDir, `.${decodedPath}`);
  if (target !== staticDir && !target.startsWith(`${staticDir}/`)) {
    return null;
  }
  if (existsSync(target) && statSync(target).isFile()) return target;
  if (existsSync(target) && statSync(target).isDirectory()) {
    const nestedIndex = join(target, "index.html");
    if (existsSync(nestedIndex)) return nestedIndex;
  }
  return indexPath;
}

function contentTypeForPath(path: string): string {
  const extension = extname(path);
  switch (extension) {
    case ".css":
      return "text/css; charset=utf-8";
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "application/javascript; charset=utf-8";
    case ".png":
      return "image/png";
    case ".svg":
      return "image/svg+xml";
    case ".webp":
      return "image/webp";
    default:
      return "application/octet-stream";
  }
}

function injectBootstrap(html: string, bootstrap: string): string {
  return html.includes("<head>")
    ? html.replace("<head>", `<head>${bootstrap}`)
    : `${bootstrap}${html}`;
}

function scriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</gu, "\\u003c");
}

function writeJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(value));
}

function writeText(response: ServerResponse, status: number, value: string): void {
  if (response.headersSent) {
    response.end(value);
    return;
  }
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "text/plain; charset=utf-8",
  });
  response.end(value);
}
