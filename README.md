# fetch-untrusted

`fetch()` for URLs you didn't write.

Node will request whatever you hand it. If that string came from a
user, a webhook, or a model, that includes `http://169.254.169.254/`
and `http://127.0.0.1:6379/`.

This resolves the host once, drops private and IANA special-use
addresses, then connects to that IP. `Host` and SNI stay on the
original name, so a later DNS change cannot retarget the socket.
Redirects go through the same checks.

```js
import { fetchUntrusted, UnsafeUrlError } from 'fetch-untrusted'

const res = await fetchUntrusted(url)
const body = await res.text()
```

Returns a normal `Response`. Node 18+, no dependencies. Copy `src/`
if you'd rather not install it.

```sh
npm i fetch-untrusted
```

## Options

`method`, `headers`, `body`, `signal`, and `redirect` work like
`fetch`. `redirect` defaults to `follow` (`error` / `manual` also
work). `Host` is always taken from the URL.

| option | default | |
| --- | --- | --- |
| `timeout` | `10000` | ms, covers DNS, connect, redirects, and the body |
| `maxBytes` | `5000000` | response body cap |
| `maxRedirects` | `5` | |
| `allowHosts` | | hostname must match if set. `*.example.com` matches subdomains, not the apex |
| `allowIps` | | extra IPs, even if private. `::1` and `0:0:0:0:0:0:0:1` are the same address |
| `allowPrivate` | `false` | skip the IP and name checks. `lookup` still has to return IPs |
| `lookup` | `dns.lookup` | `(hostname) => [{ address, family? }]` or a string IP |

`body` can be a string, `Buffer`, `Uint8Array`, Node stream, or web
`ReadableStream`. FormData / Blob / URLSearchParams are not accepted.

301/302 after POST, and 303 from anything but GET/HEAD, continue as
GET with no body. 307/308 keep the method and body. A stream body
can't be replayed on 307/308 (`ERR_REDIRECT`).

## checkUrl

If you already have a client and just need the pin:

```js
import { checkUrl } from 'fetch-untrusted'

const { url, address } = await checkUrl(input)
// connect to `address`, send Host: url.host
```

`isBlockedIp` and `isBlockedHostname` are the same lists without a
DNS lookup.

## What it blocks

Private, loopback, link-local, CGNAT, multicast, reserved.
`192.0.0.0/24`, TEST-NET, benchmarking, old 6to4 anycast.
IPv6 unique-local, discard (`100::/64`), `100:0:0:1::/64`,
documentation (`2001:db8::/32`, `3fff::/20`), SRv6 (`5f00::/16`).

Mapped and translated forms (`::ffff:x`, `::ffff:0:x`, NAT64, 6to4)
are judged by the embedded IPv4. Odd literals (`2130706433`,
`0x7f000001`, `127.1`) are normalized by the URL parser first.

These names are rejected before DNS: `localhost`, `*.localhost`,
`*.local`, `*.internal`, `*.intranet`, `*.private`, `*.corp`, `*.home`,
`*.lan`, `*.invalid`, `metadata`, `metadata.google.internal`,
`*.svc.cluster.local`.

If DNS returns both a public address and `127.0.0.1`, the public one
is used. A `lookup` function has to return IPs. Hostnames and other
junk are ignored so they can't undo the pin.

Special-use ranges are blocked as published. A few addresses inside
those prefixes are globally reachable (some `192.0.0.0/24`
assignments, for example). Those get refused too.

`allowPrivate` is for tests.

## Errors

`UnsafeUrlError`:

| code | |
| --- | --- |
| `ERR_INVALID_URL` | not a URL, no host, or port `0` |
| `ERR_BAD_PROTOCOL` | not `http:` / `https:` |
| `ERR_CREDENTIALS` | userinfo in the URL |
| `ERR_BLOCKED_HOST` | name or `allowHosts` |
| `ERR_BLOCKED_IP` | no public (or allowed) IP |
| `ERR_REDIRECT` | `redirect: 'error'`, bad `Location`, or stream body on 307/308 |
| `ERR_REDIRECT_LIMIT` | more than `maxRedirects` |
| `ERR_RESPONSE_TOO_LARGE` | body exceeded `maxBytes` |
| `ERR_TIMEOUT` | `timeout` elapsed |

Socket errors, TLS failures, and a caller `signal` abort are thrown
as-is.

```js
try {
  await fetchUntrusted(url)
} catch (err) {
  if (err instanceof UnsafeUrlError) console.error(err.code, err.message)
  else throw err
}
```

This is not a `fetch` polyfill. No cookies, decompression, retries, or
caching. It also won't save you if a *public* host itself redirects
somewhere you can't see from here. It just won't be your process
opening that socket.

## License

MIT
