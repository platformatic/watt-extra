import assert from 'node:assert/strict'
import { test } from 'node:test'
import { once } from 'node:events'
import { WebSocketServer } from 'ws'
import pino from 'pino'
import Watt from '../lib/watt.js'
import scheduler from '../plugins/scheduler.js'
import update from '../plugins/update.js'

const log = pino({ level: 'silent' })

function createApp () {
  return {
    log,
    env: { PLT_ICC_URL: 'http://icc.local' },
    instanceConfig: { applicationId: 'app', iccServices: { cron: { url: 'http://cron.local' } } },
    getAuthorizationHeaders: async () => ({}),
    watt: { runtime: {} }
  }
}

test('ICC registration includes application schedules and task names', async t => {
  const app = createApp()
  app.watt.runtime.getSchedulerJobs = async () => [{
    name: 'api:0',
    cron: '*/5 * * * *',
    source: 'application',
    applicationId: 'api',
    scheduleId: '0',
    tasks: ['cleanup'],
    maxRetries: 3
  }]
  const requests = []
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    requests.push(JSON.parse(options.body))
    return new Response('{}', { headers: { 'content-type': 'application/json' } })
  })
  await scheduler(app)
  await app.sendSchedulerInfo()
  assert.deepEqual(requests, [{
    name: 'api:0',
    schedule: '*/5 * * * *',
    source: 'application',
    applicationId: 'app',
    scheduleId: '0',
    tasks: ['cleanup'],
    maxRetries: 3
  }])
})

test('ICC without application schedule support receives only one registration attempt', async t => {
  const app = createApp()
  app.watt.runtime.getSchedulerJobs = async () => ['0', '1'].map(id => ({
    name: `api:${id}`, cron: '* * * * *', source: 'application', scheduleId: id, tasks: ['cleanup']
  }))
  let requests = 0
  t.mock.method(globalThis, 'fetch', async () => {
    requests++
    return new Response('{}', { status: 400, headers: { 'content-type': 'application/json' } })
  })
  await scheduler(app)
  await app.sendSchedulerInfo()
  assert.equal(requests, 1)
})

test('scheduler propagates native task execution failures', async () => {
  const app = createApp()
  const error = new Error('Task failed')
  app.watt.runtime.runSchedulerJob = async () => { throw error }
  await scheduler(app)
  await assert.rejects(app.runScheduledJob({ name: 'api:0' }), error)
})

test('scheduler does not register jobs without ICC', async () => {
  const app = createApp()
  app.env.PLT_ICC_URL = ''
  app.watt.runtime.getSchedulerJobs = () => assert.fail('Must not collect jobs without ICC')
  await scheduler(app)
  await app.sendSchedulerInfo()
})

test('ICC pauses active jobs, preserves paused jobs and tolerates an individual failure', async () => {
  const watt = new Watt({ env: { PLT_ICC_URL: 'http://icc.local' }, log })
  const paused = []
  watt.runtime = {
    getSchedulerJobs: () => [
      { name: 'failed', paused: false },
      { name: 'active', paused: false },
      { name: 'paused', paused: true }
    ],
    pauseSchedulerJob: async name => {
      paused.push(name)
      if (name === 'failed') throw new Error('pause failed')
    }
  }
  await watt.applySchedulerMode()
  assert.deepEqual(paused, ['failed', 'active'])
})

test('without ICC the extension leaves local scheduling to Watt', async () => {
  const watt = new Watt({ env: {}, log })
  watt.runtime = {
    getSchedulerJobs () { assert.fail('Local scheduling must not be modified') }
  }
  await watt.applySchedulerMode()
})

test('ICC scheduler commands use native Watt execution over the updates socket', async t => {
  const server = new WebSocketServer({ port: 0 })
  await once(server, 'listening')
  const executions = []
  const jobs = [{ name: 'api:cleanup', source: 'application', paused: true }]
  const app = {
    log,
    env: { PLT_ICC_URL: `http://127.0.0.1:${server.address().port}` },
    instanceConfig: { applicationId: 'test' },
    getRuntimeId: () => 'runtime',
    getAuthorizationHeaders: async () => ({}),
    watt: {
      runtime: {
        getSchedulerJobs: () => jobs,
        runSchedulerJob: async name => {
          executions.push(name)
          return { name, success: true }
        }
      }
    }
  }
  await scheduler(app)
  await update(app)
  t.after(async () => {
    await app.closeUpdates()
    await new Promise(resolve => server.close(resolve))
  })
  assert.deepEqual(await app.collectSchedulerJobs(), jobs)
  const connected = once(server, 'connection').then(async ([socket]) => {
    await once(socket, 'message')
    socket.send(JSON.stringify({ command: 'ack' }))
    return socket
  })
  await app.connectToUpdates()
  const socket = await connected
  const response = once(socket, 'message')
  socket.send(JSON.stringify({
    command: 'run-scheduled-job',
    requestId: 'run-1',
    params: { name: 'api:cleanup', source: 'application' }
  }))
  assert.deepEqual(JSON.parse((await response)[0]), {
    requestId: 'run-1', success: true, result: { name: 'api:cleanup', success: true }
  })
  assert.deepEqual(executions, ['api:cleanup'])
})
