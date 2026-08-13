export class UnsafeUrlError extends Error {
  name: 'UnsafeUrlError'
  code: string
  url?: string
  ip?: string
}

export type LookupResult = { address: string; family?: number }

export type Lookup = (
  hostname: string,
) => Promise<LookupResult | LookupResult[] | string | string[] | null | undefined>

export interface FetchUntrustedOptions {
  method?: string
  headers?: HeadersInit | Record<string, string>
  body?: string | Uint8Array | ReadableStream | NodeJS.ReadableStream
  signal?: AbortSignal
  redirect?: 'follow' | 'error' | 'manual'
  timeout?: number
  maxBytes?: number
  maxRedirects?: number
  allowHosts?: string[]
  allowIps?: string[]
  allowPrivate?: boolean
  lookup?: Lookup
}

export interface CheckedUrl {
  url: URL
  address: string
  family: number
}

export function fetchUntrusted(
  url: string | URL,
  options?: FetchUntrustedOptions,
): Promise<Response>

export function checkUrl(
  url: string | URL,
  options?: Pick<
    FetchUntrustedOptions,
    'allowHosts' | 'allowIps' | 'allowPrivate' | 'lookup' | 'signal'
  >,
): Promise<CheckedUrl>

export function isBlockedIp(ip: string): boolean
export function isBlockedHostname(hostname: string): boolean
