import { useEffect, useMemo, useRef, useState } from 'react'
import {
  CheckCircle2,
  Loader2,
  PlugZap,
  RefreshCw,
  Server,
} from 'lucide-react'
import { Button } from '@/mainview/components/ui/button'
import {
  connectDockerGitProject,
  loadDockerGitProjects,
  normalizeDockerGitBackendUrl,
  type DockerGitProjectSummary,
} from '@/mainview/lib/docker-git-connect'
import { dockerGitLaunch } from '@/mainview/lib/native'

type DockerGitConnectGateProps = {
  onConnected: () => void
}

type Phase = 'idle' | 'loading-projects' | 'connecting'

function projectSecondaryLine(project: DockerGitProjectSummary): string {
  const parts = [
    project.containerName,
    project.statusLabel ?? project.status,
    project.repoRef,
  ].filter((part): part is string => typeof part === 'string' && part.length > 0)
  return parts.join(' · ')
}

function defaultBackendUrl(): string {
  const launch = dockerGitLaunch()
  return launch?.backendUrl ?? 'http://localhost:3334'
}

export default function DockerGitConnectGate({
  onConnected,
}: DockerGitConnectGateProps) {
  const launch = useMemo(() => dockerGitLaunch(), [])
  const [backendUrl, setBackendUrl] = useState(defaultBackendUrl)
  const [connectedBackendUrl, setConnectedBackendUrl] = useState<string | null>(
    null,
  )
  const [projects, setProjects] = useState<DockerGitProjectSummary[]>([])
  const [phase, setPhase] = useState<Phase>('idle')
  const [error, setError] = useState<string | null>(null)
  const autoConnectAttempted = useRef(false)

  const loadProjects = async (rawUrl = backendUrl): Promise<void> => {
    setPhase('loading-projects')
    setError(null)
    try {
      const result = await loadDockerGitProjects(rawUrl)
      setBackendUrl(result.backendUrl)
      setConnectedBackendUrl(result.backendUrl)
      setProjects(result.projects)
    } catch (err) {
      setProjects([])
      setConnectedBackendUrl(null)
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setPhase('idle')
    }
  }

  const connectProject = async (
    projectKey: string,
    rawUrl = connectedBackendUrl ?? backendUrl,
  ): Promise<void> => {
    setPhase('connecting')
    setError(null)
    try {
      const normalizedUrl = normalizeDockerGitBackendUrl(rawUrl)
      await connectDockerGitProject({
        backendUrl: normalizedUrl,
        projectKey,
        sessionId: launch?.sessionId ?? null,
      })
      onConnected()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setPhase('idle')
    }
  }

  useEffect(() => {
    if (autoConnectAttempted.current) return
    if (!launch?.backendUrl) return
    autoConnectAttempted.current = true
    if (launch.projectKey) {
      void connectProject(launch.projectKey, launch.backendUrl)
      return
    }
    void loadProjects(launch.backendUrl)
  }, [launch])

  const busy = phase !== 'idle'

  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="mx-auto flex min-h-screen w-full max-w-[920px] flex-col justify-center px-6 py-10">
        <div className="mb-8 flex items-center gap-3">
          <div className="grid size-10 place-items-center rounded-xl border border-primary/20 bg-primary/10 text-primary">
            <PlugZap className="size-5" />
          </div>
          <div className="min-w-0">
            <h1 className="text-xl font-semibold leading-7">
              Docker-git backend
            </h1>
            <p className="text-sm text-muted-foreground">
              Connect Skiller Web to a running docker-git service.
            </p>
          </div>
        </div>

        <section className="rounded-2xl border border-border bg-card/70 p-4 shadow-sm">
          <form
            className="flex flex-col gap-3 sm:flex-row"
            onSubmit={(event) => {
              event.preventDefault()
              void loadProjects()
            }}
          >
            <label className="min-w-0 flex-1">
              <span className="mb-1.5 block text-xs font-medium text-muted-foreground">
                Backend URL
              </span>
              <div className="flex items-center gap-2 rounded-xl border border-input bg-background px-3">
                <Server className="size-4 shrink-0 text-muted-foreground" />
                <input
                  value={backendUrl}
                  onChange={(event) => setBackendUrl(event.target.value)}
                  disabled={busy}
                  className="h-10 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
                  placeholder="http://localhost:3334"
                  spellCheck={false}
                />
              </div>
            </label>
            <Button
              className="mt-auto h-10 shrink-0"
              type="submit"
              disabled={busy}
            >
              {phase === 'loading-projects' ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <RefreshCw className="size-4" />
              )}
              Load
            </Button>
          </form>

          {error && (
            <div className="mt-3 rounded-xl border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          )}
        </section>

        {projects.length > 0 && (
          <section className="mt-5 space-y-2">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-sm font-medium text-muted-foreground">
                Projects
              </h2>
              {connectedBackendUrl && (
                <span className="truncate text-xs text-muted-foreground">
                  {connectedBackendUrl}
                </span>
              )}
            </div>
            <div className="grid gap-2">
              {projects.map((project) => {
                const secondary = projectSecondaryLine(project)
                return (
                  <button
                    key={project.projectKey}
                    type="button"
                    disabled={busy}
                    onClick={() => void connectProject(project.projectKey)}
                    className="group flex min-h-[72px] items-center gap-3 rounded-2xl border border-border bg-card/70 px-4 py-3 text-left transition hover:border-primary/30 hover:bg-accent/40 disabled:cursor-not-allowed disabled:opacity-70"
                  >
                    <div className="grid size-10 shrink-0 place-items-center rounded-xl border border-border bg-background text-muted-foreground group-hover:text-primary">
                      {phase === 'connecting' ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : (
                        <Server className="size-4" />
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">
                        {project.displayName}
                      </div>
                      {secondary && (
                        <div className="mt-0.5 truncate text-xs text-muted-foreground">
                          {secondary}
                        </div>
                      )}
                    </div>
                    <CheckCircle2 className="size-4 shrink-0 text-muted-foreground group-hover:text-primary" />
                  </button>
                )
              })}
            </div>
          </section>
        )}
      </div>
    </main>
  )
}
