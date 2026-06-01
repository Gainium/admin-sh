// Minimal structured logger. Stdout JSON lines so docker logs is greppable
// without dragging in pino + transports for a tiny service.

type Level = 'debug' | 'info' | 'warn' | 'error'

function emit(level: Level, msg: string, extra?: Record<string, unknown>) {
  const line = JSON.stringify({
    t: new Date().toISOString(),
    level,
    msg,
    ...extra,
  })
  if (level === 'error' || level === 'warn') {
    console.error(line)
  } else {
    console.log(line)
  }
}

export const logger = {
  debug: (msg: string, extra?: Record<string, unknown>) =>
    emit('debug', msg, extra),
  info: (msg: string, extra?: Record<string, unknown>) =>
    emit('info', msg, extra),
  warn: (msg: string, extra?: Record<string, unknown>) =>
    emit('warn', msg, extra),
  error: (msg: string, extra?: Record<string, unknown>) =>
    emit('error', msg, extra),
}
