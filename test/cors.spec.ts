import { describe, it } from 'mocha'
import { expect } from 'chai'
import cors from 'cors'
import express from 'express'
import type { AddressInfo } from 'net'
import { parseCorsOrigin } from '../src/cors'

const LOCAL = 'http://localhost:7500'
const LAN = 'http://192.168.1.50:7500'

async function allowOriginFor(raw: string, origin: string) {
  const app = express()
  app.use(cors({ origin: parseCorsOrigin(raw), credentials: false }))
  app.get('/health', (_req, res) => {
    res.send('ok')
  })
  const server = app.listen(0)
  try {
    const { port } = server.address() as AddressInfo
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      headers: { Origin: origin },
    })
    return res.headers.get('access-control-allow-origin')
  } finally {
    server.close()
  }
}

describe('parseCorsOrigin (spec 002)', () => {
  it('§4.1 splits comma, space and mixed lists into every origin', () => {
    for (const raw of [
      `${LOCAL},${LAN}`,
      `${LOCAL} ${LAN}`,
      `${LOCAL}, ${LAN}`,
      ` ${LOCAL} ,,  ${LAN},\n`,
    ]) {
      expect(parseCorsOrigin(raw), raw).to.deep.equal([LOCAL, LAN])
    }
  })

  it('§4.2 keeps a single origin a plain string', () => {
    expect(parseCorsOrigin(LOCAL)).to.equal(LOCAL)
    expect(parseCorsOrigin(`${LOCAL},`)).to.equal(LOCAL)
  })

  it('§4.3 returns undefined when unset or blank', () => {
    expect(parseCorsOrigin(undefined)).to.equal(undefined)
    expect(parseCorsOrigin('')).to.equal(undefined)
    expect(parseCorsOrigin(' , ')).to.equal(undefined)
  })

  it('§1.1 a space-separated list echoes each request origin, not the whole list', async () => {
    const raw = `${LOCAL} ${LAN}`
    expect(await allowOriginFor(raw, LOCAL)).to.equal(LOCAL)
    expect(await allowOriginFor(raw, LAN)).to.equal(LAN)
    expect(await allowOriginFor(raw, 'http://evil.example')).to.equal(null)
  })

  it('§4.2 a single origin answers exactly as before', async () => {
    expect(await allowOriginFor(LOCAL, LOCAL)).to.equal(LOCAL)
    expect(await allowOriginFor(LOCAL, LAN)).to.equal(LOCAL)
  })
})
