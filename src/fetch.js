import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import { Readable, Transform } from 'node:stream'
import { UnsafeUrlError } from './error.js'
import { bareHost, checkUrl, parseUrl } from './check.js'

const DEFAULT_TIMEOUT = 10_000
const DEFAULT_MAX_BYTES = 5_000_000
const DEFAULT_MAX_REDIRECTS = 5

export async function fetchUntrusted(input, options = {}) {
  const timeout = options.timeout ?? DEFAULT_TIMEOUT
  const ac = new AbortController()
  let timer = setTimeout(() => ac.abort(), timeout)
  const stopTimer = () => {
    if (timer === undefined) return
    clearTimeout(timer)
    timer = undefined
  }

  const onUserAbort = () => ac.abort()
  if (options.signal) {
    if (options.signal.aborted) ac.abort()
    else options.signal.addEventListener('abort', onUserAbort, { once: true })
  }

  try {
    return await run(input, {
      ...options,
      signal: ac.signal,
      _onFinish: stopTimer,
      _userSignal: options.signal,
    })
  } catch (err) {
    stopTimer()
    if (ac.signal.aborted && !options.signal?.aborted) {
      throw new UnsafeUrlError('Request timed out', {
        code: 'ERR_TIMEOUT',
        url: String(input),
      })
    }
    throw err
  } finally {
    options.signal?.removeEventListener('abort', onUserAbort)
  }
}

async function run(input, options) {
  const redirect = options.redirect ?? 'follow'
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS

  let url = parseUrl(input)
  let method = (options.method || 'GET').toUpperCase()
  let body = asNodeBody(options.body)
  let hops = 0

  while (true) {
    const pin = await checkUrl(url, options)
    const streamed = isStream(body)
    const incoming = await request(url, pin.address, { ...options, method, body })
    const status = incoming.statusCode

    if (redirect !== 'follow' || !isRedirect(status)) {
      if (redirect === 'error' && isRedirect(status)) {
        discard(incoming)
        throw new UnsafeUrlError('Unexpected redirect', {
          code: 'ERR_REDIRECT',
          url: url.href,
        })
      }
      return toResponse(incoming, maxBytes, url.href, {
        onFinish: options._onFinish,
        signal: options.signal,
        userSignal: options._userSignal,
      })
    }

    discard(incoming)
    hops += 1
    if (hops > maxRedirects) {
      throw new UnsafeUrlError('Too many redirects', {
        code: 'ERR_REDIRECT_LIMIT',
        url: url.href,
      })
    }

    const location = incoming.headers.location
    if (!location) {
      throw new UnsafeUrlError('Redirect missing Location', {
        code: 'ERR_REDIRECT',
        url: url.href,
      })
    }

    try {
      url = new URL(location, url)
    } catch {
      throw new UnsafeUrlError('Invalid redirect Location', {
        code: 'ERR_REDIRECT',
        url: String(location),
      })
    }

    if ((status === 307 || status === 308) && streamed) {
      throw new UnsafeUrlError('Cannot replay a stream body after 307/308', {
        code: 'ERR_REDIRECT',
        url: url.href,
      })
    }

    if (status === 303 && method !== 'GET' && method !== 'HEAD') {
      method = 'GET'
      body = undefined
    } else if ((status === 301 || status === 302) && method === 'POST') {
      method = 'GET'
      body = undefined
    }
  }
}

// Connect to the pinned IP. Host / SNI stay on the original name so TLS
// still matches and a later DNS change cannot retarget the socket.
function request(url, address, options) {
  const isHttps = url.protocol === 'https:'
  const lib = isHttps ? https : http
  const port = url.port !== '' ? Number(url.port) : isHttps ? 443 : 80
  const headers = collectHeaders(options.headers)
  headers.host = url.host

  const family = net.isIP(address)
  const reqOpts = {
    agent: false,
    protocol: url.protocol,
    hostname: address,
    port,
    path: `${url.pathname}${url.search}`,
    method: options.method,
    headers,
    signal: options.signal,
  }
  if (family) reqOpts.family = family

  const name = bareHost(url)
  if (isHttps && !net.isIP(name)) reqOpts.servername = name

  return new Promise((resolve, reject) => {
    const req = lib.request(reqOpts, resolve)
    req.on('error', reject)
    try {
      writeBody(req, options.body)
    } catch (err) {
      req.destroy()
      reject(err)
    }
  })
}

function writeBody(req, body) {
  if (body == null) {
    req.end()
    return
  }
  if (isStream(body)) {
    body.on('error', (err) => req.destroy(err))
    body.pipe(req)
    return
  }
  if (typeof body === 'string' || Buffer.isBuffer(body) || body instanceof Uint8Array) {
    req.end(body)
    return
  }
  throw new TypeError('body must be a string, Buffer, Uint8Array, or Readable stream')
}

function toResponse(incoming, maxBytes, href, hooks = {}) {
  incoming.on('close', () => hooks.onFinish?.())

  const timedOut = () =>
    hooks.signal?.aborted && !hooks.userSignal?.aborted
      ? new UnsafeUrlError('Request timed out', { code: 'ERR_TIMEOUT', url: href })
      : null

  const length = Number(incoming.headers['content-length'])
  if (Number.isFinite(length) && length > maxBytes) {
    incoming.on('error', () => {})
    incoming.destroy()
    hooks.onFinish?.()
    throw new UnsafeUrlError('Response exceeded maxBytes', {
      code: 'ERR_RESPONSE_TOO_LARGE',
      url: href,
    })
  }

  let seen = 0
  const limited = new Transform({
    transform(chunk, _enc, cb) {
      const timeout = timedOut()
      if (timeout) {
        incoming.destroy()
        cb(timeout)
        return
      }
      seen += chunk.length
      if (seen > maxBytes) {
        incoming.destroy()
        cb(new UnsafeUrlError('Response exceeded maxBytes', {
          code: 'ERR_RESPONSE_TOO_LARGE',
          url: href,
        }))
        return
      }
      cb(null, chunk)
    },
  })

  incoming.on('error', (err) => {
    limited.destroy(timedOut() || err)
  })
  incoming.pipe(limited)

  return new Response(Readable.toWeb(limited), {
    status: incoming.statusCode,
    statusText: incoming.statusMessage,
    headers: readHeaders(incoming),
  })
}

function collectHeaders(headers) {
  const out = {}
  if (!headers) return out

  const put = (key, value) => {
    if (key.toLowerCase() === 'host') return
    out[key] = value
  }

  if (headers instanceof Headers) {
    headers.forEach((value, key) => put(key, value))
  } else if (Array.isArray(headers)) {
    for (const [key, value] of headers) put(key, value)
  } else {
    for (const [key, value] of Object.entries(headers)) put(key, value)
  }
  return out
}

function readHeaders(incoming) {
  const headers = new Headers()
  const src = incoming.headersDistinct || incoming.headers
  for (const [key, value] of Object.entries(src)) {
    if (value == null || key === 'transfer-encoding' || key === 'connection') continue
    const list = Array.isArray(value) ? value : [value]
    for (const item of list) headers.append(key, item)
  }
  return headers
}

function discard(incoming) {
  incoming.on('error', () => {})
  incoming.resume()
}

function asNodeBody(body) {
  if (body != null && typeof body.getReader === 'function' && typeof body.pipe !== 'function') {
    return Readable.fromWeb(body)
  }
  return body
}

function isStream(body) {
  return body != null && typeof body.pipe === 'function'
}

function isRedirect(status) {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308
}
