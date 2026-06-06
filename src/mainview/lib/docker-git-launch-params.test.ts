import { describe, expect, it } from 'bun:test'

import {
  dockerGitLaunchFromParams,
  dockerGitLaunchSearchParamsFromLocation,
} from './docker-git-launch-params'

function launchParams(search: string, hash: string): URLSearchParams {
  const params = dockerGitLaunchSearchParamsFromLocation(search, hash)
  if (params === null) {
    throw new Error(`Expected launch params for search=${search} hash=${hash}`)
  }
  return params
}

describe('dockerGitLaunchSearchParamsFromLocation', () => {
  it('reads docker-git launch params from normal search params', () => {
    const params = launchParams(
      '?backendUrl=http%3A%2F%2Flocalhost%3A3334&projectKey=abc',
      '',
    )

    expect(dockerGitLaunchFromParams(params)).toEqual({
      backendUrl: 'http://localhost:3334',
      projectKey: 'abc',
      sessionId: null,
    })
  })

  it('reads docker-git launch params from hash-router search params', () => {
    const params = launchParams(
      '',
      '#/settings?backendUrl=http%3A%2F%2Flocalhost%3A3334',
    )

    expect(params.get('backendUrl')).toBe('http://localhost:3334')
  })

  it('does not let unrelated page search params hide hash launch params', () => {
    const params = launchParams(
      '?utm_source=message',
      '#/?backendUrl=http%3A%2F%2Flocalhost%3A3334',
    )

    expect(params.get('backendUrl')).toBe('http://localhost:3334')
    expect(params.has('utm_source')).toBe(false)
  })

  it('merges docker-git launch params from search and hash', () => {
    const params = launchParams(
      '?backendUrl=http%3A%2F%2F127.0.0.1%3A3334',
      '#/?projectKey=project%2Fone&sessionId=terminal-1',
    )

    expect(dockerGitLaunchFromParams(params)).toEqual({
      backendUrl: 'http://127.0.0.1:3334',
      projectKey: 'project/one',
      sessionId: 'terminal-1',
    })
  })

  it('returns null when no docker-git launch params exist', () => {
    expect(
      dockerGitLaunchSearchParamsFromLocation('?utm_source=message', '#/settings'),
    ).toBeNull()
  })
})
