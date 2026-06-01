import { Router } from 'express'
import {
  demuxLogFrames,
  fetchTailLogs,
  HttpError,
  listProjectContainers,
  openLogStream,
  restartContainer,
  startContainer,
  stopContainer,
} from '../docker'
import { logger } from '../logger'

export const containersRouter = Router()

containersRouter.get('/', async (_req, res) => {
  try {
    const list = await listProjectContainers()
    res.json(list)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.error('containers list failed', { err: message })
    res.status(500).json({ error: message })
  }
})

async function handleAction(
  name: string,
  action: (n: string) => Promise<void>,
  res: import('express').Response,
) {
  try {
    await action(name)
    res.json({ ok: true })
  } catch (err) {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message })
      return
    }
    const message = err instanceof Error ? err.message : String(err)
    logger.error('container action failed', { name, err: message })
    res.status(500).json({ error: message })
  }
}

containersRouter.post('/:name/start', (req, res) =>
  handleAction(req.params.name, startContainer, res),
)

containersRouter.post('/:name/stop', (req, res) =>
  handleAction(req.params.name, stopContainer, res),
)

containersRouter.post('/:name/restart', (req, res) =>
  handleAction(req.params.name, restartContainer, res),
)

// Plain tail. `tail` query (default 1000, max 50000) caps how far back
// we go — Docker reads the whole log file off disk so a huge tail is
// slow.
containersRouter.get('/:name/logs', async (req, res) => {
  const tail = Math.min(50_000, Math.max(1, Number(req.query.tail) || 1000))
  try {
    const text = await fetchTailLogs(req.params.name, tail)
    res.type('text/plain; charset=utf-8').send(text)
  } catch (err) {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message })
      return
    }
    const message = err instanceof Error ? err.message : String(err)
    logger.error('logs fetch failed', { name: req.params.name, err: message })
    res.status(500).json({ error: message })
  }
})

// Streaming follow as SSE. We chose SSE over chunked text/plain so the
// browser's EventSource handles auto-reconnect + keep-alive natively
// and so we can route stdout vs stderr to different event types (the
// UI colors them differently). EventSource can't carry an Authorization
// header, so the JWT comes in as `?token=…` (authMiddleware handles
// both).
//
// `tail` seeds the stream with the last N lines so users see recent
// history immediately. Capped low (server-side max 5000) because larger
// tails make Docker spend several seconds reading log files off disk
// before the follow even starts.
containersRouter.get('/:name/logs/stream', async (req, res) => {
  const tail = Math.min(5000, Math.max(1, Number(req.query.tail) || 500))

  type LogStream = NodeJS.ReadableStream & { destroy?: () => void }
  let stream: LogStream | null = null
  let cleanedUp = false

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders()

  // Keep proxies (nginx defaults to 60s read timeout) from closing the
  // connection during quiet periods. Comment-only lines per SSE spec.
  const keepalive = setInterval(() => {
    if (!res.writableEnded) res.write(': ping\n\n')
  }, 15_000)

  const send = (event: 'log' | 'error' | 'end', data: string) => {
    if (res.writableEnded) return
    // JSON.stringify handles embedded newlines + escaping so the SSE
    // multi-line `data:` machinery stays simple on the client side.
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  }

  const cleanup = () => {
    if (cleanedUp) return
    cleanedUp = true
    clearInterval(keepalive)
    try {
      stream?.destroy?.()
    } catch {
      /* ignore */
    }
    if (!res.writableEnded) res.end()
  }

  // Register cleanup before any await so a client disconnect during
  // openLogStream() still tears down the (eventually-attached) stream.
  req.on('close', cleanup)
  res.on('close', cleanup)
  res.on('error', cleanup)

  try {
    stream = (await openLogStream(req.params.name, tail)) as LogStream
  } catch (err) {
    if (err instanceof HttpError) {
      send('error', err.message)
      cleanup()
      return
    }
    const message = err instanceof Error ? err.message : String(err)
    logger.error('log stream open failed', {
      name: req.params.name,
      err: message,
    })
    send('error', `Failed to attach: ${message}`)
    cleanup()
    return
  }

  if (cleanedUp || !stream) {
    cleanup()
    return
  }

  // Chunk-list accumulator. Buffer.concat per chunk is O(n²) under
  // heavy load (50k-line container boot can blow through a megabyte
  // in one tick). The chunk list defers concatenation until we know
  // exactly how many bytes to slice for one frame.
  const chunks: Buffer[] = []
  let total = 0

  const peek = (offset: number, len: number): Buffer => {
    const out = Buffer.allocUnsafe(len)
    let written = 0
    let skip = offset
    for (const c of chunks) {
      if (written >= len) break
      if (skip >= c.length) {
        skip -= c.length
        continue
      }
      const start = skip
      skip = 0
      const take = Math.min(c.length - start, len - written)
      c.copy(out, written, start, start + take)
      written += take
    }
    return out
  }

  const consume = (n: number) => {
    let remaining = n
    while (remaining > 0 && chunks.length > 0) {
      const c = chunks[0]
      if (c.length <= remaining) {
        remaining -= c.length
        total -= c.length
        chunks.shift()
      } else {
        chunks[0] = c.subarray(remaining)
        total -= remaining
        remaining = 0
      }
    }
  }

  stream.on('data', (chunk: Buffer) => {
    chunks.push(chunk)
    total += chunk.length
    while (total >= 8) {
      const header = peek(0, 8)
      const streamType = header[0] // 1 = stdout, 2 = stderr
      const size = header.readUInt32BE(4)
      if (total < 8 + size) break
      const payload = peek(8, size).toString('utf8').trimEnd()
      consume(8 + size)
      if (payload) send(streamType === 2 ? 'error' : 'log', payload)
    }
  })

  stream.on('end', () => {
    send('end', '')
    cleanup()
  })

  stream.on('error', (e: Error) => {
    send('error', `Stream error: ${e.message}`)
    cleanup()
  })
})

// Kept available for any future consumer that needs raw frame demux
// outside this file (e.g. a multi-container log fanout endpoint).
void demuxLogFrames
