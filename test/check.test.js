import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkUrl, isBlockedHostname, UnsafeUrlError } from '../src/index.js'

test('blocks loopback and metadata names', () => {
  assert.equal(isBlockedHostname('localhost'), true)
  assert.equal(isBlockedHostname('LOCALHOST.'), true)
  assert.equal(isBlockedHostname('foo.localhost'), true)
  assert.equal(isBlockedHostname('printer.local'), true)
  assert.equal(isBlockedHostname('metadata.google.internal'), true)
  assert.equal(isBlockedHostname('metadata'), true)
  assert.equal(isBlockedHostname('x.svc.cluster.local'), true)
  assert.equal(isBlockedHostname('nope.invalid'), true)
  assert.equal(isBlockedHostname('example.com'), false)
  assert.equal(isBlockedHostname('internal.example.com'), false)
})

test('rejects credentials, odd schemes, and private literals', async () => {
  await reject('http://user:pass@example.com/', 'ERR_CREDENTIALS')
  await reject('http://example.com@127.0.0.1/', 'ERR_CREDENTIALS')
  await reject('file:///etc/passwd', 'ERR_BAD_PROTOCOL')
  await reject('gopher://x/', 'ERR_BAD_PROTOCOL')
  await reject('javascript:alert(1)', 'ERR_BAD_PROTOCOL')
  await reject('data:text/plain,hi', 'ERR_BAD_PROTOCOL')
  await reject('http://127.0.0.1/', 'ERR_BLOCKED_IP')
  await reject('http://127.1/', 'ERR_BLOCKED_IP')
  await reject('http://2130706433/', 'ERR_BLOCKED_IP')
  await reject('http://0x7f000001/', 'ERR_BLOCKED_IP')
  await reject('http://0/', 'ERR_BLOCKED_IP')
  await reject('http://169.254.169.254/latest/meta-data/', 'ERR_BLOCKED_IP')
  await reject('http://[::1]/', 'ERR_BLOCKED_IP')
  await reject('http://[::ffff:127.0.0.1]/', 'ERR_BLOCKED_IP')
  await reject('http://[::ffff:0:127.0.0.1]/', 'ERR_BLOCKED_IP')
  await reject('http://[::ffff:0:7f00:1]/', 'ERR_BLOCKED_IP')
  await reject('http://localhost/', 'ERR_BLOCKED_HOST')
  await reject('http://example.com:0/', 'ERR_INVALID_URL')
  await reject('not a url', 'ERR_INVALID_URL')
})

test('allowHosts is exact or a *. suffix', async () => {
  await reject('http://1.1.1.1/', 'ERR_BLOCKED_HOST', { allowHosts: ['example.com'] })

  const pinned = await checkUrl('http://1.1.1.1/path?q=1', { allowHosts: ['1.1.1.1'] })
  assert.equal(pinned.address, '1.1.1.1')
  assert.equal(pinned.url.pathname, '/path')

  const sub = await checkUrl('http://foo.example.com/', {
    allowHosts: ['*.example.com'],
    lookup: async () => [{ address: '1.1.1.1', family: 4 }],
  })
  assert.equal(sub.address, '1.1.1.1')

  const nested = await checkUrl('http://a.b.example.com/', {
    allowHosts: ['*.example.com'],
    lookup: async () => [{ address: '1.1.1.1' }],
  })
  assert.equal(nested.address, '1.1.1.1')

  await reject('http://example.com/', 'ERR_BLOCKED_HOST', {
    allowHosts: ['*.example.com'],
    lookup: async () => [{ address: '1.1.1.1', family: 4 }],
  })
})

test('lookup results are filtered to public addresses', async () => {
  const mixed = await checkUrl('http://dual.example/', {
    lookup: async () => [
      { address: '127.0.0.1', family: 4 },
      { address: '1.1.1.1', family: 4 },
    ],
  })
  assert.equal(mixed.address, '1.1.1.1')
  assert.equal(mixed.family, 4)

  const mappedThenPublic = await checkUrl('http://mapped.example/', {
    lookup: async () => [
      { address: '::ffff:127.0.0.1', family: 6 },
      { address: '8.8.8.8', family: 4 },
    ],
  })
  assert.equal(mappedThenPublic.address, '8.8.8.8')

  await reject('http://only-private.example/', 'ERR_BLOCKED_IP', {
    lookup: async () => [{ address: '10.0.0.1', family: 4 }],
  })
})

test('lookup must return IP addresses, not names', async () => {
  await reject('http://pin-fail.example/', 'ERR_BLOCKED_IP', {
    lookup: async () => [{ address: 'localhost' }],
  })
  await reject('http://pin-fail.example/', 'ERR_BLOCKED_IP', {
    allowPrivate: true,
    lookup: async () => [{ address: 'localhost' }],
  })
  await reject('http://pin-fail.example/', 'ERR_BLOCKED_IP', {
    allowPrivate: true,
    lookup: async () => [{ address: 'evil.example' }],
  })
  await reject('http://pin-fail.example/', 'ERR_BLOCKED_IP', {
    lookup: async () => ['not-an-ip', { address: '2130706433' }],
  })
  await reject('http://pin-fail.example/', 'ERR_BLOCKED_IP', {
    lookup: async () => null,
  })
})

test('lookup accepts bracketed IPs and string records', async () => {
  const pinned = await checkUrl('http://name.example/', {
    lookup: async () => ['[1.1.1.1]'],
  })
  assert.equal(pinned.address, '1.1.1.1')
  assert.equal(pinned.family, 4)
})

test('allowIps matches compressed IPv6 forms', async () => {
  const pinned = await checkUrl('http://[::1]:9/', { allowIps: ['0:0:0:0:0:0:0:1'] })
  assert.equal(pinned.family, 6)
  await reject('http://10.0.0.1/', 'ERR_BLOCKED_IP', { allowIps: ['127.0.0.1'] })
})

test('allowIps lets through only the listed address', async () => {
  const pinned = await checkUrl('http://127.0.0.1:9/', { allowIps: ['127.0.0.1'] })
  assert.equal(pinned.address, '127.0.0.1')
  await reject('http://10.0.0.1/', 'ERR_BLOCKED_IP', { allowIps: ['127.0.0.1'] })
})

test('allowPrivate skips the IP and name checks', async () => {
  const pinned = await checkUrl('http://127.0.0.1:9/', { allowPrivate: true })
  assert.equal(pinned.address, '127.0.0.1')

  const local = await checkUrl('http://localhost/', {
    allowPrivate: true,
    lookup: async () => [{ address: '127.0.0.1', family: 4 }],
  })
  assert.equal(local.address, '127.0.0.1')
})

test('UnsafeUrlError carries code and url', async () => {
  await assert.rejects(
    () => checkUrl('http://127.0.0.1/'),
    (err) => {
      assert.ok(err instanceof UnsafeUrlError)
      assert.equal(err.code, 'ERR_BLOCKED_IP')
      assert.equal(err.url, 'http://127.0.0.1/')
      assert.equal(err.ip, '127.0.0.1')
      return true
    },
  )
})

test('respects an already-aborted signal', async () => {
  const ac = new AbortController()
  ac.abort()
  await assert.rejects(
    () => checkUrl('http://1.1.1.1/', { signal: ac.signal }),
    (err) => err.name === 'AbortError' || err === ac.signal.reason,
  )
})

async function reject(url, code, options) {
  await assert.rejects(() => checkUrl(url, options), (err) => {
    assert.equal(err.code, code, url)
    return true
  })
}
