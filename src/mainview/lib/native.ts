import { isTrpcQueryProcedure } from '@/shared/trpc-query-procedures'
import type { AppRPCSchema } from '@/shared/rpc-schema'
import { captureTelemetry } from '@/mainview/lib/telemetry'

/**
 * Renderer-side glue to the Skiller service.
 *
 * The web build talks to same-origin tRPC and receives push messages over SSE.
 * The old Electron preload shape is still tolerated so shared UI code can run
 * during incremental migration.
 */

declare global {
  interface Window {
    /** Set by docker-git when Skiller is opened for a selected project. */
    __DOCKER_GIT_SKILLER_SCOPE__?: DockerGitSkillerScope | null
    /** Set by /launch for diagnostics and future docker-git API calls. */
    __DOCKER_GIT_API_URL__?: string | null
    __SKILLER_LAUNCH__?: {
      backendUrl: string | null
      projectKey: string | null
      sessionId: string | null
    }
    /** Set by the main process (either host) when tRPC binds a port. */
    __SKILLER_TRPC_BASE_URL__?: string
    /** Electron preload-exposed bridge. Absent under Electrobun or plain Vite. */
    api?: {
      platform: NodeJS.Platform
      invoke: (channel: string, ...args: unknown[]) => Promise<unknown>
      on: (
        channel: string,
        listener: (...args: unknown[]) => void,
      ) => () => void
    }
  }
}

type DockerGitPathRoot = {
  containerPath: string
  hostPath: string
  id: 'project' | 'home' | 'codexSkills'
  label: string
}

type DockerGitSkillerScope = {
  containerName: string
  currentProject: DockerGitPathRoot
  projectKey: string
  roots: DockerGitPathRoot[]
  sessionId: string | null
}

type BunRequests = AppRPCSchema['bun']['requests']
export type BunPushMessage = keyof AppRPCSchema['bun']['messages']

const DEFAULT_TRPC_URL = 'http://127.0.0.1:17888'
const ELECTRON_PUSH_CHANNEL = 'skiller:push'

/** WKWebView can time out localhost requests around 60s; keep signal long-lived. */
const TRPC_FETCH_MAX_MS = 600_000

function mergeLongLivedSignal(
  parent: AbortSignal | undefined,
  maxMs: number,
): AbortSignal | undefined {
  if (typeof AbortSignal === 'undefined' || typeof AbortSignal.timeout !== 'function') {
    return parent
  }
  const long = AbortSignal.timeout(maxMs)
  if (!parent) return long
  const anyFn = (
    AbortSignal as unknown as { any?: (signals: AbortSignal[]) => AbortSignal }
  ).any
  if (typeof anyFn === 'function') {
    return anyFn([parent, long])
  }
  return parent
}

function trpcFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const signal = mergeLongLivedSignal(init?.signal ?? undefined, TRPC_FETCH_MAX_MS)
  return fetch(input, { ...init, signal })
}

function isBundledSkillerView(): boolean {
  if (typeof window === 'undefined') return false
  return (
    window.location.protocol === 'views:' ||
    window.location.href.startsWith('views://')
  )
}

function isElectronHost(): boolean {
  return typeof window !== 'undefined' && typeof window.api !== 'undefined'
}

/** Vite: `?trpcPort=`. Optional `#trpcPort=` in hash if the host adds it. */
function parseTrpcPortOverride(): number | null {
  if (typeof window === 'undefined') return null
  const parse = (raw: string | null): number | null => {
    if (raw == null || raw === '') return null
    const n = Number.parseInt(raw, 10)
    if (Number.isFinite(n) && n > 0 && n < 65536) return n
    return null
  }
  const fromSearch = parse(new URLSearchParams(window.location.search).get('trpcPort'))
  if (fromSearch !== null) return fromSearch
  const { hash } = window.location
  if (hash.length > 1) {
    return parse(new URLSearchParams(hash.slice(1)).get('trpcPort'))
  }
  return null
}

/** ------------------------------------------------------------------
 * Push transport: normalizes Electrobun duplex RPC and Electron IPC
 * into a single EventTarget that exposes `addListener(name, handler)`.
 * ------------------------------------------------------------------ */

type PushListener = (payload: unknown) => void

const g = globalThis as typeof globalThis & {
  __skillerPushHub?: Map<string, Set<PushListener>>
  __skillerPushBooted?: boolean
  __skillerLaunchBooted?: boolean
}

function getHub(): Map<string, Set<PushListener>> {
  if (!g.__skillerPushHub) g.__skillerPushHub = new Map()
  return g.__skillerPushHub
}

function dispatchPush(name: string, payload: unknown): void {
  const hub = getHub()
  const set = hub.get(name)
  if (!set) return
  for (const fn of set) {
    try {
      fn(payload)
    } catch (err) {
      console.warn(`[push:${name}] listener threw:`, err)
    }
  }
}

function addPushListener(name: string, fn: PushListener): () => void {
  const hub = getHub()
  let set = hub.get(name)
  if (!set) {
    set = new Set()
    hub.set(name, set)
  }
  set.add(fn)
  return () => set?.delete(fn)
}

async function bootPushTransport(): Promise<void> {
  if (g.__skillerPushBooted) return
  g.__skillerPushBooted = true

  if (!isElectronHost()) {
    if (typeof EventSource === 'undefined') {
      console.debug('[native] EventSource unavailable — push transport disabled')
      return
    }
    const source = new EventSource(`${trpcBaseUrl()}/events`)
    source.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data) as { name?: string; payload?: unknown }
        if (!msg || typeof msg.name !== 'string') return
        dispatchPush(msg.name, msg.payload)
      } catch (err) {
        console.warn('[native] invalid SSE payload:', err)
      }
    }
    source.onerror = () => {
      console.debug('[native] SSE push transport disconnected')
    }
    return
  }

  window.api!.on(ELECTRON_PUSH_CHANNEL, (...args: unknown[]) => {
    const msg = args[0] as { name?: string; payload?: unknown } | undefined
    if (!msg || typeof msg.name !== 'string') return
    if (msg.name === 'trpc_endpoint') {
      const baseUrl = (msg.payload as { baseUrl?: string } | undefined)?.baseUrl
      if (typeof baseUrl === 'string' && baseUrl.length > 0) {
        window.__SKILLER_TRPC_BASE_URL__ = baseUrl
      }
    }
    dispatchPush(msg.name, msg.payload)
  })
}

// Fire-and-forget — any `listen()` call races with this; missed events during
// boot are extremely unlikely in practice because main waits for renderer to
// signal ready before sending, but we queue nothing explicitly.
void bootPushTransport()
void bootDockerGitLaunchContext()

/** ------------------------------------------------------------------
 * tRPC base URL resolution + request helper.
 * ------------------------------------------------------------------ */

function trpcBaseUrl(): string {
  const override = parseTrpcPortOverride()
  if (override !== null) {
    return `http://127.0.0.1:${override}`
  }
  if (typeof window !== 'undefined' && window.__SKILLER_TRPC_BASE_URL__) {
    return window.__SKILLER_TRPC_BASE_URL__
  }
  if (isBundledSkillerView()) {
    return DEFAULT_TRPC_URL
  }
  const configured = (import.meta as ImportMeta & { env?: { VITE_TRPC_URL?: string } }).env
    ?.VITE_TRPC_URL
  if (configured && configured.length > 0) return configured
  if (typeof window !== 'undefined' && window.location.origin !== 'null') {
    return window.location.origin
  }
  return DEFAULT_TRPC_URL
}

function launchSearchParams(): URLSearchParams | null {
  if (typeof window === 'undefined') return null
  const params = new URLSearchParams(window.location.search)
  if (params.size > 0) return params
  const queryIndex = window.location.hash.indexOf('?')
  if (queryIndex < 0) return null
  return new URLSearchParams(window.location.hash.slice(queryIndex + 1))
}

function decodeBase64UrlJson(raw: string): unknown {
  const normalized = raw.replace(/-/gu, '+').replace(/_/gu, '/')
  const bin = window.atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '='))
  const bytes = Uint8Array.from(bin, (char) => char.charCodeAt(0))
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown
}

function isDockerGitPathRoot(value: unknown): value is DockerGitPathRoot {
  if (!value || typeof value !== 'object') return false
  const root = value as Partial<DockerGitPathRoot>
  return (
    typeof root.containerPath === 'string' &&
    typeof root.hostPath === 'string' &&
    typeof root.id === 'string' &&
    typeof root.label === 'string'
  )
}

function isDockerGitSkillerScope(value: unknown): value is DockerGitSkillerScope {
  if (!value || typeof value !== 'object') return false
  const scope = value as Partial<DockerGitSkillerScope>
  return (
    typeof scope.containerName === 'string' &&
    isDockerGitPathRoot(scope.currentProject) &&
    typeof scope.projectKey === 'string' &&
    Array.isArray(scope.roots) &&
    scope.roots.every(isDockerGitPathRoot) &&
    (scope.sessionId === null || typeof scope.sessionId === 'string')
  )
}

function storeDockerGitScope(scope: DockerGitSkillerScope): void {
  if (typeof window === 'undefined') return
  window.__DOCKER_GIT_SKILLER_SCOPE__ = scope
  try {
    window.sessionStorage.setItem('skiller.docker_git_scope', JSON.stringify(scope))
  } catch {
    /* ignore storage failures */
  }
}

function restoreDockerGitScope(): void {
  if (typeof window === 'undefined' || window.__DOCKER_GIT_SKILLER_SCOPE__) return
  try {
    const raw = window.sessionStorage.getItem('skiller.docker_git_scope')
    if (!raw) return
    const parsed = JSON.parse(raw) as unknown
    if (isDockerGitSkillerScope(parsed)) {
      window.__DOCKER_GIT_SKILLER_SCOPE__ = parsed
    }
  } catch {
    /* ignore invalid saved scope */
  }
}

async function fetchDockerGitScope(
  backendUrl: string,
  projectKey: string,
  sessionId: string | null,
): Promise<DockerGitSkillerScope> {
  const base = backendUrl.replace(/\/+$/u, '')
  const path = sessionId
    ? `/projects/by-key/${encodeURIComponent(projectKey)}/terminal-sessions/${encodeURIComponent(sessionId)}/skiller/context`
    : `/projects/by-key/${encodeURIComponent(projectKey)}/skiller/context`
  const url = new URL(`${base}${path}`)
  const res = await fetch(url, { credentials: 'include' })
  if (!res.ok) throw new Error(`docker-git context failed: HTTP ${res.status}`)
  const payload = (await res.json()) as unknown
  if (isDockerGitSkillerScope(payload)) return payload
  if (
    payload &&
    typeof payload === 'object' &&
    'browserScope' in payload &&
    isDockerGitSkillerScope((payload as { browserScope?: unknown }).browserScope)
  ) {
    return (payload as { browserScope: DockerGitSkillerScope }).browserScope
  }
  throw new Error('docker-git context payload is invalid')
}

async function bootDockerGitLaunchContext(): Promise<void> {
  if (g.__skillerLaunchBooted) return
  g.__skillerLaunchBooted = true
  restoreDockerGitScope()

  const params = launchSearchParams()
  if (!params) return

  const backendUrl = params.get('backendUrl')
  const projectKey = params.get('projectKey')
  const sessionId = params.get('sessionId')
  window.__DOCKER_GIT_API_URL__ = backendUrl
  window.__SKILLER_LAUNCH__ = { backendUrl, projectKey, sessionId }

  const inlineScope = params.get('scope')
  if (inlineScope) {
    try {
      const decoded = decodeBase64UrlJson(inlineScope)
      if (isDockerGitSkillerScope(decoded)) {
        storeDockerGitScope(decoded)
        return
      }
    } catch (err) {
      console.warn('[native] failed to decode docker-git launch scope:', err)
    }
  }

  const scopeJson = params.get('scopeJson')
  if (scopeJson) {
    try {
      const decoded = JSON.parse(scopeJson) as unknown
      if (isDockerGitSkillerScope(decoded)) {
        storeDockerGitScope(decoded)
        return
      }
    } catch (err) {
      console.warn('[native] failed to parse docker-git launch scopeJson:', err)
    }
  }

  if (!backendUrl || !projectKey) return
  try {
    const scope = await fetchDockerGitScope(backendUrl, projectKey, sessionId)
    storeDockerGitScope(scope)
  } catch (err) {
    console.warn('[native] failed to bootstrap docker-git launch context:', err)
  }
}

type TrpcSingleResponse<T> =
  | { result: { data?: T } }
  | { error: { message?: string; code?: number; data?: unknown } }

async function callTrpcProcedure<T>(
  name: string,
  input: unknown,
  isQuery: boolean,
): Promise<T> {
  const base = trpcBaseUrl()
  let url = `${base}/trpc/${name}`
  const init: RequestInit = {
    method: isQuery ? 'GET' : 'POST',
  }
  if (isQuery) {
    if (input !== undefined) {
      url += `?input=${encodeURIComponent(JSON.stringify(input))}`
    }
  } else {
    // tRPC v11 requires Content-Type: application/json on every mutation,
    // even ones with no input (it rejects the body-less POST with 415
    // UNSUPPORTED_MEDIA_TYPE before reaching the procedure).
    init.headers = { 'Content-Type': 'application/json' }
    init.body = input === undefined ? '{}' : JSON.stringify(input)
  }
  const res = await trpcFetch(url, init)
  const payload = (await res.json()) as TrpcSingleResponse<T>
  if (!res.ok || ('error' in payload && payload.error)) {
    const detail =
      payload && typeof payload === 'object' && 'error' in payload && payload.error
        ? JSON.stringify(payload.error)
        : `HTTP ${res.status}`
    throw new Error(`tRPC ${name} failed: ${detail}`)
  }
  const data = 'result' in payload ? payload.result.data : undefined
  return data as T
}

export async function invoke<K extends keyof BunRequests>(
  cmd: K,
  ...args: undefined extends BunRequests[K]['params']
    ? [params?: BunRequests[K]['params']]
    : [params: BunRequests[K]['params']]
): Promise<BunRequests[K]['response']> {
  const name = cmd as string
  const input = args[0]
  const isQuery = isTrpcQueryProcedure(name)
  const startedAt = performance.now()
  try {
    const response = await callTrpcProcedure<BunRequests[K]['response']>(
      name,
      input,
      isQuery,
    )
    if (!isQuery) {
      captureTelemetry('rpc_mutation_called', {
        command: name,
        duration_ms: Math.round(performance.now() - startedAt),
      })
    }
    return response
  } catch (error) {
    const message =
      error instanceof Error ? error.message.slice(0, 240) : 'unknown'
    captureTelemetry('rpc_call_failed', {
      command: name,
      is_query: isQuery,
      duration_ms: Math.round(performance.now() - startedAt),
      message,
    })
    throw error
  }
}

export async function listen<T>(
  message: BunPushMessage,
  handler: (event: { payload: T }) => void,
): Promise<() => void> {
  return addPushListener(message, (payload) => handler({ payload: payload as T }))
}

export function openUrl(url: string): void {
  if (!isElectronHost() && typeof window !== 'undefined') {
    window.open(url, '_blank', 'noopener,noreferrer')
    return
  }
  void invoke('open_external', { url })
}

export function revealItemInDir(path: string): void {
  if (!isElectronHost()) return
  void invoke('reveal_path_in_folder', { path })
}

function dockerGitSkillerScope(): DockerGitSkillerScope | null {
  if (typeof window === 'undefined') return null
  return window.__DOCKER_GIT_SKILLER_SCOPE__ ?? null
}

function normalizeSlashPath(raw: string): string | null {
  const trimmed = raw.trim().replace(/\\/gu, '/')
  if (trimmed.length === 0) return null
  const absolute = trimmed.startsWith('/') ? trimmed : `/${trimmed}`
  const parts: string[] = []
  for (const part of absolute.split('/')) {
    if (part.length === 0 || part === '.') continue
    if (part === '..') {
      parts.pop()
      continue
    }
    parts.push(part)
  }
  return `/${parts.join('/')}`
}

function isPathInside(basePath: string, targetPath: string): boolean {
  return targetPath === basePath || targetPath.startsWith(`${basePath}/`)
}

function rootDepth(root: DockerGitPathRoot, key: 'containerPath' | 'hostPath'): number {
  return root[key].split('/').filter((part) => part.length > 0).length
}

function sortedRoots(
  scope: DockerGitSkillerScope,
  key: 'containerPath' | 'hostPath',
): DockerGitPathRoot[] {
  return [...scope.roots].sort((left, right) => rootDepth(right, key) - rootDepth(left, key))
}

function normalizePickerInput(raw: string, scope: DockerGitSkillerScope): string | null {
  const trimmed = raw.trim()
  if (trimmed === '~') return scope.roots.find((root) => root.id === 'home')?.containerPath ?? null
  if (trimmed.startsWith('~/')) {
    const home = scope.roots.find((root) => root.id === 'home')?.containerPath
    return home ? normalizeSlashPath(`${home}/${trimmed.slice(2)}`) : null
  }
  if (trimmed.startsWith('/')) return normalizeSlashPath(trimmed)
  return normalizeSlashPath(`${scope.currentProject.containerPath}/${trimmed}`)
}

function mapContainerPathToHost(
  scope: DockerGitSkillerScope,
  rawPath: string,
): { error: string; hostPath: null } | { error: null; hostPath: string } {
  const containerPath = normalizePickerInput(rawPath, scope)
  if (containerPath === null) {
    return { error: 'Enter a folder path.', hostPath: null }
  }
  const root = sortedRoots(scope, 'containerPath')
    .find((candidate) => isPathInside(candidate.containerPath, containerPath))
  if (!root) {
    return {
      error: `Choose a path inside ${scope.currentProject.containerPath}.`,
      hostPath: null,
    }
  }
  const relative = containerPath.slice(root.containerPath.length).replace(/^\/+/u, '')
  return {
    error: null,
    hostPath: relative.length === 0 ? root.hostPath : `${root.hostPath}/${relative}`,
  }
}

export function displayFolderPath(path: string): string {
  const scope = dockerGitSkillerScope()
  if (scope === null) return path
  const normalizedPath = path.replace(/\\/gu, '/')
  const root = sortedRoots(scope, 'hostPath')
    .find((candidate) => isPathInside(candidate.hostPath, normalizedPath))
  if (!root) return path
  const relative = normalizedPath.slice(root.hostPath.length).replace(/^\/+/u, '')
  return relative.length === 0 ? root.containerPath : `${root.containerPath}/${relative}`
}

function pickerButton(label: string, path: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = [
    'flex w-full items-center justify-between gap-3 rounded-md px-3 py-2 text-left',
    'hover:bg-black/[0.04] dark:hover:bg-white/[0.06]',
  ].join(' ')
  button.innerHTML = [
    '<span class="text-sm font-medium"></span>',
    '<span class="min-w-0 flex-1 truncate text-right text-[10px] font-mono text-muted-foreground/70"></span>',
  ].join('')
  const [nameEl, pathEl] = [...button.children] as HTMLElement[]
  nameEl.textContent = label
  pathEl.textContent = path
  button.addEventListener('click', onClick)
  return button
}

function openDockerGitFolderPicker(
  scope: DockerGitSkillerScope,
  title: string | undefined,
): Promise<string | null> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div')
    overlay.className = 'fixed inset-0 z-[1000] flex items-center justify-center bg-black/30 dark:bg-black/50'
    const panel = document.createElement('div')
    panel.className = 'w-full max-w-xl rounded-xl border border-border bg-popover p-5 shadow-2xl'
    panel.addEventListener('click', (event) => event.stopPropagation())

    const heading = document.createElement('div')
    heading.className = 'mb-4 flex items-start justify-between gap-3'
    const titleBlock = document.createElement('div')
    const titleEl = document.createElement('h2')
    titleEl.className = 'text-sm font-[590] text-foreground'
    titleEl.textContent = title ?? 'Select project folder'
    const scopeEl = document.createElement('p')
    scopeEl.className = 'mt-1 text-[11px] text-muted-foreground'
    scopeEl.textContent = `${scope.containerName} - ${scope.currentProject.containerPath}`
    titleBlock.append(titleEl, scopeEl)
    const closeButton = document.createElement('button')
    closeButton.type = 'button'
    closeButton.className = 'text-muted-foreground hover:text-foreground'
    closeButton.textContent = 'x'
    heading.append(titleBlock, closeButton)

    const rootsEl = document.createElement('div')
    rootsEl.className = 'mb-4 space-y-1 rounded-lg border border-border/60 p-1'
    const input = document.createElement('input')
    input.type = 'text'
    input.value = scope.currentProject.containerPath
    input.className = [
      'w-full rounded-md border border-input bg-transparent px-3 py-2 font-mono text-sm',
      'placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring',
    ].join(' ')
    for (const root of scope.roots) {
      rootsEl.append(pickerButton(root.label, root.containerPath, () => {
        input.value = root.containerPath
        input.focus()
        input.select()
      }))
    }

    const error = document.createElement('p')
    error.className = 'mt-2 min-h-4 text-xs text-destructive'
    const footer = document.createElement('div')
    footer.className = 'mt-4 flex justify-end gap-2'
    const cancel = document.createElement('button')
    cancel.type = 'button'
    cancel.className = 'rounded-md border border-border px-3 py-2 text-sm hover:bg-black/[0.04] dark:hover:bg-white/[0.06]'
    cancel.textContent = 'Cancel'
    const choose = document.createElement('button')
    choose.type = 'button'
    choose.className = 'rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground hover:opacity-90'
    choose.textContent = 'Choose folder'
    footer.append(cancel, choose)
    panel.append(heading, rootsEl, input, error, footer)
    overlay.append(panel)

    const cleanup = (value: string | null) => {
      document.removeEventListener('keydown', onKeyDown)
      overlay.remove()
      resolve(value)
    }
    const submit = () => {
      const result = mapContainerPathToHost(scope, input.value)
      if (result.error !== null) {
        error.textContent = result.error
        return
      }
      cleanup(result.hostPath)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') cleanup(null)
      if (event.key === 'Enter') submit()
    }

    overlay.addEventListener('click', () => cleanup(null))
    closeButton.addEventListener('click', () => cleanup(null))
    cancel.addEventListener('click', () => cleanup(null))
    choose.addEventListener('click', submit)
    input.addEventListener('input', () => {
      error.textContent = ''
    })
    document.addEventListener('keydown', onKeyDown)
    document.body.append(overlay)
    input.focus()
    input.select()
  })
}

function promptForFolder(title: string | undefined): string | null {
  if (typeof window === 'undefined') return null
  const value = window.prompt(title ?? 'Folder path')
  const normalized = value === null ? null : value.trim()
  return normalized && normalized.length > 0 ? normalized : null
}

export async function pickFolder(options?: {
  title?: string
}): Promise<string | null> {
  const scope = dockerGitSkillerScope()
  if (scope !== null) {
    return openDockerGitFolderPicker(scope, options?.title)
  }
  if (!isElectronHost()) {
    return promptForFolder(options?.title)
  }
  return invoke('pick_folder', options?.title ? { title: options.title } : undefined)
}
