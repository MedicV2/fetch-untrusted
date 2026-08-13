import http from 'node:http'

export function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({ server, port, url: `http://127.0.0.1:${port}/` })
    })
  })
}

export function close(server) {
  server.closeAllConnections?.()
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()))
  })
}
