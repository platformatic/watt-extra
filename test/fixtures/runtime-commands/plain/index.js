import { createServer } from 'node:http'

export function create () {
  return createServer((_req, res) => {
    res.end('ok')
  })
}
