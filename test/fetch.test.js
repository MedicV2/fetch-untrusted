import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { fetchUntrusted, UnsafeUrlError } from '../src/index.js'
import { close, listen } from './listen.js'

test('fetches a local server when allowPrivate is on', async () => {
  const { server, url } = await listen((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('ok')
  })
  try {
    const res = await fetchUntrusted(url, { allowPrivate: true })
    assert.equal(res.status, 200)
    assert.equal(await res.text(), 'ok')
  } finally {
    await close(server)
  }
})

test('pins the IP and keeps the original Host header', async () => {
  const { server, port } = await listen((req, res) => {
    res.end(req.headers.host)
  })
  try {
    const res = await fetchUntrusted(`http://app.example:${port}/`, {
      allowPrivate: true,
      lookup: async () => [{ address: '127.0.0.1', family: 4 }],
    })
    assert.equal(await res.text(), `app.example:${port}`)
  } finally {
    await close(server)
  }
})

test('does not use a lookup hostname as the pin target', async () => {
  const { server, port } = await listen((_req, res) => {
    res.end('should-not-run')
  })
  try {
    await assert.rejects(
      () => fetchUntrusted(`http://app.example:${port}/`, {
        allowPrivate: true,
        lookup: async () => [{ address: 'localhost' }],
      }),
      (err) => err.code === 'ERR_BLOCKED_IP',
    )
  } finally {
    await close(server)
  }
})

test('caps the response body', async () => {
  const { server, url } = await listen((_req, res) => {
    res.end('abcdefghij')
  })
  try {
    await assert.rejects(
      () => fetchUntrusted(url, { allowPrivate: true, maxBytes: 4 }).then((r) => r.text()),
      (err) => err.code === 'ERR_RESPONSE_TOO_LARGE',
    )
  } finally {
    await close(server)
  }
})

test('rejects oversize Content-Length before reading', async () => {
  const { server, url } = await listen((_req, res) => {
    res.writeHead(200, { 'content-length': '99999' })
    res.end('x')
  })
  try {
    await assert.rejects(
      () => fetchUntrusted(url, { allowPrivate: true, maxBytes: 8 }),
      (err) => err.code === 'ERR_RESPONSE_TOO_LARGE',
    )
  } finally {
    await close(server)
  }
})

test('times out a hung request', async () => {
  const { server, url } = await listen(() => {})
  try {
    await assert.rejects(
      () => fetchUntrusted(url, { allowPrivate: true, timeout: 50 }),
      (err) => err.code === 'ERR_TIMEOUT',
    )
  } finally {
    await close(server)
  }
})

test('times out hung DNS', async () => {
  await assert.rejects(
    () => fetchUntrusted('http://slow.example/', {
      timeout: 50,
      lookup: () => new Promise(() => {}),
    }),
    (err) => err.code === 'ERR_TIMEOUT',
  )
})

test('times out a slow response body', async () => {
  const { server, url } = await listen((_req, res) => {
    res.writeHead(200)
    res.write('x')
  })
  try {
    await assert.rejects(
      () => fetchUntrusted(url, { allowPrivate: true, timeout: 50 }).then((r) => r.text()),
      (err) => err.code === 'ERR_TIMEOUT',
    )
  } finally {
    await close(server)
  }
})

test('user abort is not reported as a timeout', async () => {
  const { server, url } = await listen(() => {})
  const ac = new AbortController()
  const pending = fetchUntrusted(url, { allowPrivate: true, signal: ac.signal, timeout: 5000 })
  ac.abort()
  try {
    await assert.rejects(pending, (err) => err.name === 'AbortError' || err.code === 'ABORT_ERR')
  } finally {
    await close(server)
  }
})

test('does not fetch a blocked literal', async () => {
  await assert.rejects(
    () => fetchUntrusted('http://127.0.0.1:1/'),
    (err) => err instanceof UnsafeUrlError && err.code === 'ERR_BLOCKED_IP',
  )
})

test('sends a string body', async () => {
  const { server, url } = await listen((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      res.end(`${req.method}:${Buffer.concat(chunks)}`)
    })
  })
  try {
    const res = await fetchUntrusted(url, {
      allowPrivate: true,
      method: 'POST',
      body: 'hello',
    })
    assert.equal(await res.text(), 'POST:hello')
  } finally {
    await close(server)
  }
})

test('accepts a web ReadableStream body', async () => {
  const { server, url } = await listen((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => res.end(Buffer.concat(chunks)))
  })
  try {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('web'))
        controller.close()
      },
    })
    const res = await fetchUntrusted(url, { allowPrivate: true, method: 'POST', body })
    assert.equal(await res.text(), 'web')
  } finally {
    await close(server)
  }
})

test('forwards an error from a request body stream', async () => {
  const { server, url } = await listen((_req, res) => res.end('nope'))
  const body = new Readable({
    read() {
      this.destroy(new Error('body-broke'))
    },
  })
  try {
    await assert.rejects(
      () => fetchUntrusted(url, { allowPrivate: true, method: 'POST', body }),
      (err) => err.message === 'body-broke',
    )
  } finally {
    await close(server)
  }
})
