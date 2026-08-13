import net from 'node:net'

// IANA IPv4 Special-Purpose Address Registry.
const V4 = [
  [0x00000000, 8],  // 0.0.0.0/8       this network
  [0x0a000000, 8],  // 10.0.0.0/8      private
  [0x64400000, 10], // 100.64.0.0/10   CGNAT
  [0x7f000000, 8],  // 127.0.0.0/8     loopback
  [0xa9fe0000, 16], // 169.254.0.0/16  link-local / cloud metadata
  [0xac100000, 12], // 172.16.0.0/12   private
  [0xc0000000, 24], // 192.0.0.0/24    IETF protocol assignments
  [0xc0000200, 24], // 192.0.2.0/24    TEST-NET-1
  [0xc0586300, 24], // 192.88.99.0/24  deprecated 6to4 relay anycast
  [0xc0a80000, 16], // 192.168.0.0/16  private
  [0xc6120000, 15], // 198.18.0.0/15   benchmarking
  [0xc6336400, 24], // 198.51.100.0/24 TEST-NET-2
  [0xcb007100, 24], // 203.0.113.0/24  TEST-NET-3
  [0xe0000000, 4],  // 224.0.0.0/4     multicast
  [0xf0000000, 4],  // 240.0.0.0/4     reserved
]

// IANA IPv6 Special-Purpose Address Registry (non-embedded forms).
const V6 = [
  [0x0064ff9b000100000000000000000000n, 48], // 64:ff9b:1::/48  local NAT64
  [0x01000000000000000000000000000000n, 64], // 100::/64        discard
  [0x01000000000000010000000000000000n, 64], // 100:0:0:1::/64  IANA special-use
  [0x20010000000000000000000000000000n, 23], // 2001::/23       IETF (Teredo, ORCHID, etc)
  [0x20010db8000000000000000000000000n, 32], // 2001:db8::/32   documentation
  [0x3fff0000000000000000000000000000n, 20], // 3fff::/20       documentation (RFC 9637)
  [0x5f000000000000000000000000000000n, 16], // 5f00::/16       SRv6 SIDs (RFC 9602)
  [0xfc000000000000000000000000000000n, 7],  // fc00::/7        unique local
  [0xfe800000000000000000000000000000n, 10], // fe80::/10       link-local
  [0xff000000000000000000000000000000n, 8],  // ff00::/8        multicast
]

export function normalizeIp(ip) {
  if (typeof ip !== 'string') return null
  let s = ip.trim()
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1)
  return net.isIP(s) ? s : null
}

export function ipsEqual(a, b) {
  const left = normalizeIp(a)
  const right = normalizeIp(b)
  if (!left || !right) return false
  if (left === right) return true
  const lf = net.isIP(left)
  const rf = net.isIP(right)
  if (lf === 4 && rf === 4) return ipv4ToInt(left) === ipv4ToInt(right)
  if (lf === 6 && rf === 6) {
    const aa = ipv6ToBig(left)
    const bb = ipv6ToBig(right)
    return aa !== null && aa === bb
  }
  return false
}

export function isBlockedIp(ip) {
  const addr = normalizeIp(ip)
  if (!addr) return true

  if (net.isIPv4(addr)) return blockedV4(ipv4ToInt(addr))

  const n = ipv6ToBig(addr)
  if (n === null) return true

  // Mapped / translated forms: judge the embedded IPv4.
  if (prefix(n, 0xffffn << 32n, 96)) return blockedV4(low32(n)) // ::ffff:0:0/96
  if (prefix(n, 0xffffn << 48n, 96)) return blockedV4(low32(n)) // ::ffff:0:0:0/96  SIIT
  if (prefix(n, 0x0064ff9b000000000000000000000000n, 96)) return blockedV4(low32(n)) // 64:ff9b::/96
  if (prefix(n, 0x2002n << 112n, 16)) return blockedV4(Number((n >> 80n) & 0xffffffffn)) // 6to4
  if (prefix(n, 0n, 96)) return n === 0n || n === 1n || blockedV4(low32(n)) // ::/96, ::1, old v4-compatible

  return V6.some(([base, bits]) => prefix(n, base, bits))
}

function blockedV4(n) {
  return V4.some(([base, bits]) => (n >>> (32 - bits)) === (base >>> (32 - bits)))
}

function low32(n) {
  return Number(n & 0xffffffffn)
}

function prefix(addr, base, bits) {
  const shift = 128n - BigInt(bits)
  return (addr >> shift) === (base >> shift)
}

function ipv4ToInt(ip) {
  const p = ip.split('.')
  return (((+p[0] << 24) | (+p[1] << 16) | (+p[2] << 8) | +p[3]) >>> 0)
}

function ipv6ToBig(ip) {
  ip = ip.split('%')[0]

  if (ip.includes('.')) {
    const cut = ip.lastIndexOf(':')
    const v4 = ipv4ToInt(ip.slice(cut + 1))
    ip = `${ip.slice(0, cut + 1)}${((v4 >>> 16) & 0xffff).toString(16)}:${(v4 & 0xffff).toString(16)}`
  }

  const [left, right] = ip.split('::')
  const head = left ? left.split(':') : []
  let parts
  if (right === undefined) {
    parts = head
  } else {
    const tail = right ? right.split(':') : []
    parts = [...head, ...Array(8 - head.length - tail.length).fill('0'), ...tail]
  }

  if (parts.length !== 8) return null

  let n = 0n
  for (const part of parts) {
    const word = parseInt(part, 16)
    if (!Number.isInteger(word) || word < 0 || word > 0xffff) return null
    n = (n << 16n) + BigInt(word)
  }
  return n
}
