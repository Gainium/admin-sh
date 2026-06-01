import Docker from 'dockerode'
import type { ContainerInspectInfo } from 'dockerode'
import { env } from './env'
import { logger } from './logger'

// Compose labels Docker writes on every container created by compose.
const LABEL_PROJECT = 'com.docker.compose.project'
const LABEL_SERVICE = 'com.docker.compose.service'

export interface ServiceContainer {
  id: string
  name: string
  service: string
  image: string
  imageTag: string | null
  state: string // running | exited | …
  status: string // human-readable
  health: 'healthy' | 'unhealthy' | 'starting' | null
  createdAt: number
  ports: {
    ip?: string
    publicPort?: number
    privatePort: number
    type: string
  }[]
}

let docker: Docker | null = null

function getDocker(): Docker {
  if (!docker) {
    docker = new Docker()
  }
  return docker
}

function projectFilter(): Record<string, string[]> {
  return {
    label: [`${LABEL_PROJECT}=${env.composeProject}`],
  }
}

function parseTag(image: string): string | null {
  // image refs: registry/path:tag, registry/path@sha256:…, path:tag, path
  if (image.includes('@')) return null
  const at = image.lastIndexOf(':')
  const slash = image.lastIndexOf('/')
  if (at > slash) return image.slice(at + 1)
  return null
}

export async function listProjectContainers(): Promise<ServiceContainer[]> {
  const raw = await getDocker().listContainers({
    all: true,
    filters: projectFilter(),
  })
  return raw.map((c) => {
    const service = c.Labels?.[LABEL_SERVICE] ?? ''
    const name = c.Names?.[0]?.replace(/^\//, '') ?? c.Id.slice(0, 12)
    return {
      id: c.Id,
      name,
      service,
      image: c.Image,
      imageTag: parseTag(c.Image),
      state: c.State,
      status: c.Status,
      // listContainers doesn't surface health; inspect on demand if we ever need it.
      health: null,
      createdAt: c.Created * 1000,
      ports: (c.Ports ?? []).map((p) => ({
        ip: p.IP,
        publicPort: p.PublicPort,
        privatePort: p.PrivatePort,
        type: p.Type,
      })),
    }
  })
}

async function findContainer(idOrService: string): Promise<ServiceContainer> {
  const all = await listProjectContainers()
  const hit =
    all.find((c) => c.id === idOrService) ||
    all.find((c) => c.service === idOrService) ||
    all.find((c) => c.name === idOrService)
  if (!hit) {
    throw new HttpError(
      404,
      `Container or service "${idOrService}" not found in project ${env.composeProject}`,
    )
  }
  return hit
}

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

export async function startContainer(idOrService: string): Promise<void> {
  const hit = await findContainer(idOrService)
  try {
    await getDocker().getContainer(hit.id).start()
  } catch (err) {
    // dockerode throws 304 on already-started; treat as success.
    const e = err as { statusCode?: number; message?: string }
    if (e.statusCode === 304) return
    throw err
  }
}

export async function stopContainer(idOrService: string): Promise<void> {
  const hit = await findContainer(idOrService)
  try {
    await getDocker().getContainer(hit.id).stop()
  } catch (err) {
    const e = err as { statusCode?: number }
    if (e.statusCode === 304) return // already stopped
    throw err
  }
}

export async function restartContainer(idOrService: string): Promise<void> {
  const hit = await findContainer(idOrService)
  await getDocker().getContainer(hit.id).restart()
}

export async function inspectContainer(
  idOrService: string,
): Promise<ContainerInspectInfo> {
  const hit = await findContainer(idOrService)
  return getDocker().getContainer(hit.id).inspect()
}

export async function pullImage(ref: string): Promise<void> {
  const d = getDocker()
  // dockerode streams pull progress; await its completion.
  const stream = await d.pull(ref)
  await new Promise<void>((resolve, reject) => {
    d.modem.followProgress(
      stream,
      (err) => (err ? reject(err) : resolve()),
      (event: { status?: string; progress?: string }) => {
        if (event?.status) {
          logger.debug('pull progress', {
            ref,
            status: event.status,
            progress: event.progress,
          })
        }
      },
    )
  })
}

/**
 * Recreate the named container with a new image tag, copying the original
 * config so env vars / mounts / network / restart policy / labels carry over.
 * Compose-created containers preserve their labels, so the new one is still
 * picked up by `docker compose` as the same service.
 */
export async function recreateWithImage(
  idOrService: string,
  newImageRef: string,
): Promise<{ oldId: string; newId: string }> {
  const inspect = await inspectContainer(idOrService)
  const d = getDocker()
  const container = d.getContainer(inspect.Id)

  // 1) Stop + remove the old container.
  try {
    await container.stop()
  } catch (err) {
    const e = err as { statusCode?: number }
    if (e.statusCode !== 304) throw err // 304 = not running
  }
  await container.remove({ force: true })

  // 2) Re-create with new image. Carry over env, ports, volumes, network,
  // labels, restart policy. We reuse the original Name so docker compose
  // still recognizes it.
  const created = await d.createContainer({
    name: inspect.Name.replace(/^\//, ''),
    Image: newImageRef,
    Env: inspect.Config.Env ?? [],
    Cmd: inspect.Config.Cmd ?? undefined,
    Entrypoint: inspect.Config.Entrypoint ?? undefined,
    Labels: inspect.Config.Labels ?? {},
    ExposedPorts: inspect.Config.ExposedPorts,
    Volumes: inspect.Config.Volumes,
    WorkingDir: inspect.Config.WorkingDir || undefined,
    User: inspect.Config.User || undefined,
    Hostname: inspect.Config.Hostname || undefined,
    HostConfig: inspect.HostConfig,
    NetworkingConfig: {
      EndpointsConfig: inspect.NetworkSettings?.Networks ?? {},
    },
  })
  await created.start()
  return { oldId: inspect.Id, newId: created.id }
}

export interface LogLine {
  /** 'log' = stdout, 'error' = stderr. Matches the SSE event names so
   *  the frontend can treat static and streamed logs identically. */
  level: 'log' | 'error'
  text: string
}

/**
 * Demux Docker's 8-byte multiplexed log frames into per-line entries
 * tagged with their stream type. Each frame is
 * `[stream_type(1)][_(3)][size(4-byte BE)][payload]`. The payload often
 * contains multiple newline-separated log lines; we split so the UI
 * can render and color each one independently. Non-TTY containers
 * (every service in docker-sh) use this framing; TTY containers don't.
 */
function demuxLogFrames(buf: Buffer): LogLine[] {
  const out: LogLine[] = []
  let i = 0
  while (i + 8 <= buf.length) {
    const streamType = buf[i] // 1 = stdout, 2 = stderr
    const size = buf.readUInt32BE(i + 4)
    if (i + 8 + size > buf.length) break
    const payload = buf.subarray(i + 8, i + 8 + size).toString('utf8')
    const level: 'log' | 'error' = streamType === 2 ? 'error' : 'log'
    for (const raw of payload.split('\n')) {
      const text = raw.trimEnd()
      if (text) out.push({ level, text })
    }
    i += 8 + size
  }
  return out
}

/**
 * Fetch the last `tail` log lines as an array of tagged entries.
 * Combines stdout + stderr in chronological order (Docker's default).
 */
export async function fetchTailLogs(
  idOrService: string,
  tail: number,
): Promise<LogLine[]> {
  const hit = await findContainer(idOrService)
  const container = getDocker().getContainer(hit.id)
  const result = await container.logs({
    stdout: true,
    stderr: true,
    tail,
    timestamps: true,
    follow: false,
  })
  // dockerode returns a Buffer for follow:false. Some versions widen
  // the return type, hence the runtime check.
  const buf = Buffer.isBuffer(result)
    ? result
    : Buffer.from(result as unknown as ArrayBuffer)
  return demuxLogFrames(buf)
}

/**
 * Open a streaming log subscription. The caller is responsible for piping
 * the demuxed text to the client and for calling `destroy()` on abort.
 * Returns a Node stream that emits `data` events (Buffers — same 8-byte
 * framing as fetchTailLogs).
 */
export async function openLogStream(
  idOrService: string,
  tail: number,
): Promise<NodeJS.ReadableStream> {
  const hit = await findContainer(idOrService)
  const container = getDocker().getContainer(hit.id)
  const stream = (await container.logs({
    stdout: true,
    stderr: true,
    tail,
    timestamps: true,
    follow: true,
  })) as unknown as NodeJS.ReadableStream
  return stream
}

export { demuxLogFrames }

/**
 * Spawn a short-lived helper container that runs `docker compose up -d
 * --force-recreate <service>` against the host daemon. Used for self-
 * upgrade: admin-sh can't recreate its own container (its process dies
 * on stop), but it can ask Docker to start a *different* container that
 * does the recreate. The helper has `AutoRemove: true`, mounts the host's
 * docker socket + compose project dir, and self-terminates after the
 * recreate completes.
 *
 * The 3-second sleep gives admin-sh time to flush its HTTP response and
 * close the inbound connection before its own container goes away.
 */
export async function spawnRecreateHelper(opts: {
  service: string
  helperImage: string
  composeProject: string
  composeDirHostPath: string
}): Promise<{ helperId: string }> {
  // Ensure the helper image is available locally — pulled once, cached
  // forever after that.
  await pullImage(opts.helperImage)

  const composeCmd = [
    'docker',
    'compose',
    '-p',
    opts.composeProject,
    '-f',
    `${opts.composeDirHostPath}/docker-compose.yml`,
    'up',
    '-d',
    '--no-deps',
    '--force-recreate',
    opts.service,
  ].join(' ')

  const helper = await getDocker().createContainer({
    Image: opts.helperImage,
    // Use the host's compose project dir as both the bind mount and the
    // working directory so any `.env` / `.versions.env` files resolve.
    WorkingDir: opts.composeDirHostPath,
    Cmd: ['sh', '-c', `sleep 3 && ${composeCmd}`],
    HostConfig: {
      AutoRemove: true,
      Binds: [
        '/var/run/docker.sock:/var/run/docker.sock',
        `${opts.composeDirHostPath}:${opts.composeDirHostPath}`,
      ],
    },
    Env: [`COMPOSE_PROJECT_NAME=${opts.composeProject}`],
    Labels: {
      // Tag the helper so the operator (and future debugging) can grep it
      // out of `docker ps -a`. Not strictly required.
      'com.gainium.helper': 'upgrade',
      'com.gainium.target-service': opts.service,
    },
  })
  await helper.start()
  logger.info('upgrade helper started', {
    helperId: helper.id,
    service: opts.service,
    cmd: composeCmd,
  })
  return { helperId: helper.id }
}

/**
 * Quick liveness probe; used by an unauthenticated /health endpoint
 * extension if we ever need one.
 */
export async function ping(): Promise<boolean> {
  try {
    await getDocker().ping()
    return true
  } catch {
    return false
  }
}
