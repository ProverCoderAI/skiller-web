import {
  isDockerGitSkillerScope,
  saveDockerGitConnection,
  type DockerGitConnection,
  type DockerGitSkillerScope,
} from '@/mainview/lib/native'

export type DockerGitProjectSummary = {
  clonedOnHostname?: string
  containerName?: string
  displayName: string
  id: string
  projectKey: string
  repoRef?: string
  repoUrl?: string
  sshSessions?: unknown
  startedAtIso?: string
  status?: string
  statusLabel?: string
}

type DockerGitConnectInput = {
  backendUrl: string
  projectKey: string
  sessionId: string | null
}

function normalizeUrlForDisplay(url: URL): string {
  url.hash = ''
  url.search = ''
  const normalizedPath = url.pathname.replace(/\/+$/u, '')
  url.pathname = normalizedPath === '/' ? '' : normalizedPath
  return url.toString().replace(/\/+$/u, '')
}

export function normalizeDockerGitBackendUrl(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed.length === 0) {
    throw new Error('Backend URL is required.')
  }
  const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//iu.test(trimmed)
    ? trimmed
    : `http://${trimmed}`
  const url = new URL(withProtocol)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Backend URL must use http or https.')
  }
  return normalizeUrlForDisplay(url)
}

function skillerConnectUrl(backendUrl: string): string {
  return `${backendUrl.replace(/\/+$/u, '')}/skiller/connect`
}

function isProjectSummary(value: unknown): value is DockerGitProjectSummary {
  if (!value || typeof value !== 'object') return false
  const project = value as Partial<DockerGitProjectSummary>
  return (
    typeof project.displayName === 'string' &&
    typeof project.id === 'string' &&
    typeof project.projectKey === 'string'
  )
}

function projectsFromPayload(payload: unknown): DockerGitProjectSummary[] {
  if (!payload || typeof payload !== 'object') {
    throw new Error('docker-git projects payload is invalid.')
  }
  const projects = (payload as { projects?: unknown }).projects
  if (!Array.isArray(projects) || !projects.every(isProjectSummary)) {
    throw new Error('docker-git projects payload is invalid.')
  }
  return projects
}

function connectionFromPayload(
  backendUrl: string,
  payload: unknown,
): DockerGitConnection {
  if (!payload || typeof payload !== 'object') {
    throw new Error('docker-git connection payload is invalid.')
  }
  const value = payload as {
    browserScope?: unknown
    eventsBaseUrl?: unknown
    projectKey?: unknown
    sessionId?: unknown
    trpcBaseUrl?: unknown
  }
  const browserScope: DockerGitSkillerScope | null =
    value.browserScope === null || value.browserScope === undefined
      ? null
      : isDockerGitSkillerScope(value.browserScope)
        ? value.browserScope
        : (() => {
            throw new Error('docker-git connection payload is invalid.')
          })()
  if (
    typeof value.projectKey !== 'string' ||
    (value.sessionId !== null &&
      value.sessionId !== undefined &&
      typeof value.sessionId !== 'string') ||
    typeof value.trpcBaseUrl !== 'string' ||
    (value.eventsBaseUrl !== null &&
      value.eventsBaseUrl !== undefined &&
      typeof value.eventsBaseUrl !== 'string')
  ) {
    throw new Error('docker-git connection payload is invalid.')
  }
  return {
    backendUrl,
    browserScope,
    eventsBaseUrl:
      typeof value.eventsBaseUrl === 'string' ? value.eventsBaseUrl : null,
    projectKey: value.projectKey,
    sessionId: value.sessionId ?? null,
    trpcBaseUrl: value.trpcBaseUrl,
  }
}

async function readJson(response: Response): Promise<unknown> {
  const payload = (await response.json().catch(() => null)) as unknown
  if (!response.ok) {
    const message =
      payload &&
      typeof payload === 'object' &&
      'error' in payload &&
      typeof (payload as { error?: { message?: unknown } }).error?.message ===
        'string'
        ? (payload as { error: { message: string } }).error.message
        : `HTTP ${response.status}`
    throw new Error(message)
  }
  return payload
}

export async function loadDockerGitProjects(
  rawBackendUrl: string,
): Promise<{
  backendUrl: string
  projects: DockerGitProjectSummary[]
}> {
  const backendUrl = normalizeDockerGitBackendUrl(rawBackendUrl)
  const response = await fetch(skillerConnectUrl(backendUrl), {
    credentials: 'include',
    headers: { accept: 'application/json' },
  })
  const payload = await readJson(response)
  return { backendUrl, projects: projectsFromPayload(payload) }
}

export async function connectDockerGitProject(
  input: DockerGitConnectInput,
): Promise<DockerGitConnection> {
  const backendUrl = normalizeDockerGitBackendUrl(input.backendUrl)
  const response = await fetch(skillerConnectUrl(backendUrl), {
    body: JSON.stringify({
      projectKey: input.projectKey,
      sessionId: input.sessionId ?? undefined,
    }),
    credentials: 'include',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
    },
    method: 'POST',
  })
  const payload = await readJson(response)
  const connection = connectionFromPayload(backendUrl, payload)
  saveDockerGitConnection(connection)
  return connection
}
