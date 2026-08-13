import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { fetchUntrusted, UnsafeUrlError } from '../src/index.js'
import { close, listen } from './listen.js'

test('follows a redirect and re-checks the next hop', async () => {
  const b = await listen((_req, res) => {
    res.end('landed')
  })
  const a = await listen((_req, res) => {
    res.writeHead(302, { location: `http://127.0.0.1:${b.port}/done` })
    res.end()
  })
  try {
    const res = await fetchUntrusted(a.url, { allowPrivate: true })
    assert.equal(await res.text(), 'landed')
    assert.equal(res.status, 200)
  } finally {
    await close(a.server)
    await close(b.server)
  }
})

test('follows a relative Location', async () => {
  const { server, url } = await listen((req, res) => {
    if (req.url === '/') {
      res.writeHead(302, { location: '/done' })
      res.end()
      return
    }
    res.end(`rel:${req.url}`)
  })
  try {
    const res = await fetchUntrusted(url, { allowPrivate: true })
    assert.equal(await res.text(), 'rel:/done')
  } finally {
    await close(server)
  }
})

test('follows 301, 302, 303, 307, and 308', async () => {
  for (const status of [301, 302, 303, 307, 308]) {
    const { server, url } = await listen((req, res) => {
      if (req.url === '/') {
        res.writeHead(status, { location: '/z' })
        res.end()
        return
      }
      res.end(`s${status}`)
    })
    try {
      const res = await fetchUntrusted(url, { allowPrivate: true })
      assert.equal(await res.text(), `s${status}`)
    } finally {
      await close(server)
    }
  }
})

test('POST + 302 continues as GET without a body', async () => {
  const { server, url } = await listen((req, res) => {
    if (req.url === '/') {
      res.writeHead(302, { location: '/next' })
      res.end()
      return
    }
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      res.end(`${req.method}:${Buffer.concat(chunks).length}`)
    })
  })
  try {
    const res = await fetchUntrusted(url, {
      allowPrivate: true,
      method: 'POST',
      body: 'payload',
    })
    assert.equal(await res.text(), 'GET:0')
  } finally {
    await close(server)
  }
})

test('303 from PUT continues as GET', async () => {
  const { server, url } = await listen((req, res) => {
    if (req.url === '/') {
      res.writeHead(303, { location: '/next' })
      res.end()
      return
    }
    res.end(req.method)
  })
  try {
    const res = await fetchUntrusted(url, { allowPrivate: true, method: 'PUT', body: 'x' })
    assert.equal(await res.text(), 'GET')
  } finally {
    await close(server)
  }
})

test('307 keeps POST and the body', async () => {
  const { server, url } = await listen((req, res) => {
    if (req.url === '/') {
      res.writeHead(307, { location: '/next' })
      res.end()
      return
    }
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
      body: 'keep',
    })
    assert.equal(await res.text(), 'POST:keep')
  } finally {
    await close(server)
  }
})

test('307 with a stream body is refused', async () => {
  const { server, url } = await listen((_req, res) => {
    res.writeHead(307, { location: '/next' })
    res.end()
  })
  const body = Readable.from(['chunk'])
  try {
    await assert.rejects(
      () => fetchUntrusted(url, { allowPrivate: true, method: 'POST', body }),
      (err) => err instanceof UnsafeUrlError && err.code === 'ERR_REDIRECT',
    )
  } finally {
    await close(server)
  }
})

test('refuses a redirect to a private address', async () => {
  const { server, url } = await listen((_req, res) => {
    res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' })
    res.end()
  })
  try {
    await assert.rejects(
      () => fetchUntrusted(url, { allowIps: ['127.0.0.1'] }),
      (err) => err instanceof UnsafeUrlError && err.code === 'ERR_BLOCKED_IP',
    )
  } finally {
    await close(server)
  }
})

test('refuses a protocol-relative redirect to a private address', async () => {
  const { server, url } = await listen((_req, res) => {
    res.writeHead(302, { location: '//169.254.169.254/latest/meta-data/' })
    res.end()
  })
  try {
    await assert.rejects(
      () => fetchUntrusted(url, { allowIps: ['127.0.0.1'] }),
      (err) => err.code === 'ERR_BLOCKED_IP',
    )
  } finally {
    await close(server)
  }
})

test('refuses a redirect that adds credentials', async () => {
  const { server, url } = await listen((_req, res) => {
    res.writeHead(302, { location: 'http://user:pass@1.1.1.1/' })
    res.end()
  })
  try {
    await assert.rejects(
      () => fetchUntrusted(url, { allowIps: ['127.0.0.1'] }),
      (err) => err.code === 'ERR_CREDENTIALS',
    )
  } finally {
    await close(server)
  }
})

test('refuses a redirect to a blocked hostname', async () => {
  const { server, url } = await listen((_req, res) => {
    res.writeHead(302, { location: 'http://localhost/' })
    res.end()
  })
  try {
    await assert.rejects(
      () => fetchUntrusted(url, { allowIps: ['127.0.0.1'] }),
      (err) => err.code === 'ERR_BLOCKED_HOST',
    )
  } finally {
    await close(server)
  }
})

test('refuses a redirect to a non-http scheme', async () => {
  const { server, url } = await listen((_req, res) => {
    res.writeHead(302, { location: 'file:///etc/passwd' })
    res.end()
  })
  try {
    await assert.rejects(
      () => fetchUntrusted(url, { allowIps: ['127.0.0.1'] }),
      (err) => err.code === 'ERR_BAD_PROTOCOL',
    )
  } finally {
    await close(server)
  }
})

test('redirect: error throws on 3xx', async () => {
  const { server, url } = await listen((_req, res) => {
    res.writeHead(302, { location: 'http://example.com/' })
    res.end()
  })
  try {
    await assert.rejects(
      () => fetchUntrusted(url, { allowPrivate: true, redirect: 'error' }),
      (err) => err.code === 'ERR_REDIRECT',
    )
  } finally {
    await close(server)
  }
})

test('redirect: manual returns the 3xx response', async () => {
  const { server, url } = await listen((_req, res) => {
    res.writeHead(302, { location: '/next' })
    res.end('stay')
  })
  try {
    const res = await fetchUntrusted(url, { allowPrivate: true, redirect: 'manual' })
    assert.equal(res.status, 302)
    assert.equal(res.headers.get('location'), '/next')
    assert.equal(await res.text(), 'stay')
  } finally {
    await close(server)
  }
})

test('redirect loops hit maxRedirects', async () => {
  const { server, url } = await listen((_req, res) => {
    res.writeHead(302, { location: '/' })
    res.end()
  })
  try {
    await assert.rejects(
      () => fetchUntrusted(url, { allowPrivate: true, maxRedirects: 2 }),
      (err) => err.code === 'ERR_REDIRECT_LIMIT',
    )
  } finally {
    await close(server)
  }
})

test('missing Location is an error', async () => {
  const { server, url } = await listen((_req, res) => {
    res.writeHead(302)
    res.end()
  })
  try {
    await assert.rejects(
      () => fetchUntrusted(url, { allowPrivate: true }),
      (err) => err.code === 'ERR_REDIRECT',
    )
  } finally {
    await close(server)
  }
})
