import net from 'node:net'
import { lookup as dnsLookup } from 'node:dns/promises'
import { UnsafeUrlError } from './error.js'
import { isBlockedIp, ipsEqual, normalizeIp } from './ip.js'

const BLOCKED_NAMES = new Set([
  'localhost',
  'metadata',
  'metadata.google.internal',
  'kubernetes',
  'kubernetes.default',
  'kubernetes.default.svc',
])

const BLOCKED_SUFFIXES = [
  '.localhost',
  '.local',
  '.internal',
  '.intranet',
  '.private',
  '.corp',
  '.home',
  '.lan',
  '.localdomain',
  '.invalid',
  '.svc.cluster.local',
]

export function bareHost(url) {
  const host = url.hostname
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
}

export function isBlockedHostname(hostname) {
  const h = normalizeHost(hostname)
  if (BLOCKED_NAMES.has(h)) return true
  return BLOCKED_SUFFIXES.some((suffix) => h.endsWith(suffix))
}

function hostAllowed(hostname, rules) {
  const h = normalizeHost(hostname)
  for (const rule of rules) {
    const r = normalizeHost(rule)
    if (r.startsWith('*.')) {
      const suffix = r.slice(1)
      if (h.endsWith(suffix) && h.length > suffix.length) return true
    } else if (h === r) {
      return true
    }
  }
  return false
}

export function parseUrl(input) {
  try {
    return input instanceof URL ? new URL(input.href) : new URL(input)
  } catch {
    throw new UnsafeUrlError('Invalid URL', {
      code: 'ERR_INVALID_URL',
      url: String(input),
    })
  }
}

export async function checkUrl(input, options = {}) {
  const url = parseUrl(input)

  if (url.username || url.password) {
    throw new UnsafeUrlError('URL must not include credentials', {
      code: 'ERR_CREDENTIALS',
      url: url.href,
    })
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UnsafeUrlError(`Blocked protocol ${url.protocol}`, {
      code: 'ERR_BAD_PROTOCOL',
      url: url.href,
    })
  }

  const hostname = bareHost(url)
  if (!hostname) {
    throw new UnsafeUrlError('URL has no hostname', {
      code: 'ERR_INVALID_URL',
      url: url.href,
    })
  }

  if (url.port === '0') {
    throw new UnsafeUrlError('Invalid port', {
      code: 'ERR_INVALID_URL',
      url: url.href,
    })
  }

  if (options.allowHosts && !hostAllowed(hostname, options.allowHosts)) {
    throw new UnsafeUrlError(`Host not in allowHosts: ${hostname}`, {
      code: 'ERR_BLOCKED_HOST',
      url: url.href,
    })
  }

  if (!options.allowPrivate && isBlockedHostname(hostname)) {
    throw new UnsafeUrlError(`Blocked hostname: ${hostname}`, {
      code: 'ERR_BLOCKED_HOST',
      url: url.href,
    })
  }

  if (options.signal?.aborted) throw abortError(options.signal)

  const records = await resolve(hostname, options)
  const usable = records.filter((r) => addressAllowed(r.address, options))

  if (usable.length === 0) {
    const ip = records.map((r) => r.address).join(', ')
    throw new UnsafeUrlError(`No public address for ${hostname}`, {
      code: 'ERR_BLOCKED_IP',
      url: url.href,
      ip,
    })
  }

  const address = usable[0].address
  return { url, address, family: net.isIP(address) }
}

function addressAllowed(address, options) {
  if (options.allowPrivate) return true
  if (options.allowIps && options.allowIps.some((item) => ipsEqual(item, address))) return true
  return !isBlockedIp(address)
}

function normalizeHost(hostname) {
  return String(hostname).toLowerCase().replace(/\.$/, '')
}

async function resolve(hostname, options) {
  if (net.isIP(hostname)) {
    return [{ address: hostname, family: net.isIP(hostname) }]
  }

  const pending = options.lookup
    ? Promise.resolve(options.lookup(hostname)).then(asRecords)
    : dnsLookup(hostname, { all: true, verbatim: true })

  const records = await withSignal(pending, options.signal)
  const out = []
  for (const record of records) {
    const address = normalizeIp(record && record.address)
    if (address) out.push({ address, family: net.isIP(address) })
  }
  return out
}

function asRecords(result) {
  if (result == null) return []
  const list = Array.isArray(result) ? result : [result]
  return list.map((item) => {
    if (typeof item === 'string') return { address: item }
    return item
  })
}

function withSignal(promise, signal) {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(abortError(signal))

  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError(signal))
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (err) => {
        signal.removeEventListener('abort', onAbort)
        reject(err)
      },
    )
  })
}

function abortError(signal) {
  if (signal.reason) return signal.reason
  const err = new Error('This operation was aborted')
  err.name = 'AbortError'
  return err
}
