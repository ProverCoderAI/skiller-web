export type DockerGitLaunchParams = {
  backendUrl: string | null
  projectKey: string | null
  sessionId: string | null
}

const launchParamKeys = [
  'backendUrl',
  'projectKey',
  'sessionId',
  'scope',
  'scopeJson',
] as const

function hashQueryParams(hash: string): URLSearchParams | null {
  const queryIndex = hash.indexOf('?')
  if (queryIndex < 0) return null
  return new URLSearchParams(hash.slice(queryIndex + 1))
}

function copyLaunchParams(
  target: URLSearchParams,
  source: URLSearchParams,
): void {
  for (const key of launchParamKeys) {
    const value = source.get(key)
    if (value !== null && !target.has(key)) {
      target.set(key, value)
    }
  }
}

export function dockerGitLaunchSearchParamsFromLocation(
  search: string,
  hash: string,
): URLSearchParams | null {
  const merged = new URLSearchParams()
  copyLaunchParams(merged, new URLSearchParams(search))
  const hashParams = hashQueryParams(hash)
  if (hashParams !== null) {
    copyLaunchParams(merged, hashParams)
  }
  return merged.size === 0 ? null : merged
}

export function dockerGitLaunchFromParams(
  params: URLSearchParams,
): DockerGitLaunchParams {
  return {
    backendUrl: params.get('backendUrl'),
    projectKey: params.get('projectKey'),
    sessionId: params.get('sessionId'),
  }
}
