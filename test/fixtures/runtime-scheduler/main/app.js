import { createServer } from 'node:http'
export function create () {
  return createServer((_req, res) => {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ executions }))
  })
}
let executions = 0
export const scheduledTasks = [{ cron: '* * * * * *', tasks: ['test'] }]
export const tasks = { test: async () => ++executions }
