export class UnsafeUrlError extends Error {
  constructor(message, extra = {}) {
    super(message)
    this.name = 'UnsafeUrlError'
    this.code = extra.code || 'ERR_UNSAFE_URL'
    if (extra.url !== undefined) this.url = extra.url
    if (extra.ip !== undefined) this.ip = extra.ip
  }
}
