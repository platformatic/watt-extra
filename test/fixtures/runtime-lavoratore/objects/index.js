// Stands for a Lavoratore application: the runtime reports no type for it, as for the real one, and it answers the
// commands of ICC through the ITC of the runtime
import { createServer } from 'node:http'

const commands = []

globalThis.platformatic.itc.handle('plt:lavoratore:promote', message => {
  commands.push({ name: 'promote', message })
  return { promoted: true, status: 'applied', generation: message.generation, admission: 1 }
})

globalThis.platformatic.itc.handle('plt:lavoratore:drain', message => {
  commands.push({ name: 'drain', message })
  return { status: 'drained', moved: commands.length }
})

globalThis.platformatic.itc.handle('plt:lavoratore:resume', () => {
  commands.push({ name: 'resume' })
  return { resumed: true }
})

export function create () {
  return createServer((_req, res) => {
    res.setHeader('content-type', 'application/json')
    // With the configuration the application started with, i.e. patched by watt-extra
    res.end(JSON.stringify({ commands, placement: globalThis.lavoratoreStandIn.placement() }))
  })
}
