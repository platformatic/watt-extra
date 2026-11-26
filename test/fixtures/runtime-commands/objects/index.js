// An application which handles the commands of ICC through the ITC of the runtime, and reports the context of the
// deployment it started with
import { createServer } from 'node:http'

const commands = []

globalThis.platformatic.itc.handle('plt:test:promote', message => {
  commands.push({ name: 'promote', message })
  return { promoted: true, generation: message.generation }
})

globalThis.platformatic.itc.handle('plt:test:fail', () => {
  throw new Error('This command fails')
})

export function create () {
  return createServer((_req, res) => {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ commands, context: process.env.PLT_DEPLOYMENT_CONTEXT ?? null }))
  })
}
