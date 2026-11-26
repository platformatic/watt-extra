// An application which sets the context of the deployment in its own environment, and reports the one it started
// with: what ICC tells wins. It answers a command with values which are not objects.
import { createServer } from 'node:http'

const answers = { false: false, zero: 0, text: 'done', list: [], nothing: undefined }

globalThis.platformatic.itc.handle('plt:test:raw', message => answers[message.answer])

export function create () {
  return createServer((_req, res) => {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ context: process.env.PLT_DEPLOYMENT_CONTEXT ?? null }))
  })
}
