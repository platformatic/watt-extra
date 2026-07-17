import assert from 'node:assert'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { join, dirname } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'
import { start } from '../index.js'
import Watt from '../lib/watt.js'
import schedulerPlugin from '../plugins/scheduler.js'
import updatePlugin from '../plugins/update.js'

import {
  setUpEnvironment,
  startICC,
  installDeps
} from './helper.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

function controlPlaneResponseWithMode (applicationId, applicationName, mode) {
  return () => ({
    applicationId,
    applicationName,
    config: {},
    scheduler: { mode },
    iccServices: {
      cron: { url: 'http://127.0.0.1:3000/cron' },
      compliance: { url: 'http://127.0.0.1:3000/compliance' },
      scaler: { url: 'http://127.0.0.1:3000/scaler' }
    }
  })
}

test('ICC coordination: should disable local jobs and register config jobs directly', async (t) => {
  const applicationName = 'test-app'
  const applicationId = randomUUID()
  const applicationPath = join(__dirname, 'fixtures', 'runtime-scheduler')

  await installDeps(t, applicationPath)

  let savedWattJob = null
  let savedState = null
  const icc = await startICC(t, {
    applicationId,
    applicationName,
    controlPlaneResponse: controlPlaneResponseWithMode(applicationId, applicationName, 'external'),
    saveWattJob: (job) => {
      savedWattJob = job
    },
    saveApplicationInstanceState: ({ state }) => {
      savedState = state
    }
  })

  setUpEnvironment({
    PLT_APP_NAME: applicationName,
    PLT_APP_DIR: applicationPath,
    PLT_ICC_URL: 'http://127.0.0.1:3000'
  })
  const app = await start()

  t.after(async () => {
    await app.close()
    await icc.close()
  })

  // The local scheduler triggers are disabled on released runtimes and paused
  // on runtimes exposing scheduler control.
  const config = await app.watt.runtime.getRuntimeConfig()
  if (typeof app.watt.runtime.pauseSchedulerJob === 'function') {
    assert.notStrictEqual(config.scheduler[0].enabled, false)
    assert.strictEqual(app.watt.runtime.getScheduler()[0].paused, true)
  } else {
    assert.strictEqual(config.scheduler[0].enabled, false)
  }

  assert.deepStrictEqual(savedWattJob, {
    name: 'test',
    schedule: '*/5 * * * *',
    method: 'GET',
    maxRetries: 3,
    applicationId,
    callbackUrl: 'http://localhost:3000'
  })

  // The jobs are reported in the application state
  assert.ok(savedState, 'the state should have been reported')
  assert.strictEqual(savedState.scheduler, undefined)
})

test('ICC coordination: should disable local jobs regardless of scheduler mode', async (t) => {
  const applicationName = 'test-app'
  const applicationId = randomUUID()
  const applicationPath = join(__dirname, 'fixtures', 'runtime-scheduler')

  await installDeps(t, applicationPath)

  let savedWattJob = null
  const icc = await startICC(t, {
    applicationId,
    applicationName,
    controlPlaneResponse: controlPlaneResponseWithMode(applicationId, applicationName, 'local'),
    saveWattJob: (job) => {
      savedWattJob = job
    }
  })

  setUpEnvironment({
    PLT_APP_NAME: applicationName,
    PLT_APP_DIR: applicationPath,
    PLT_ICC_URL: 'http://127.0.0.1:3000'
  })
  const app = await start()

  t.after(async () => {
    await app.close()
    await icc.close()
  })

  // ICC coordination always disables local execution.
  const config = await app.watt.runtime.getRuntimeConfig()
  assert.strictEqual(config.scheduler[0].enabled, false)

  assert.ok(savedWattJob)
})

function createMockApp (port) {
  return {
    log: { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} },
    instanceConfig: {
      applicationId: 'test-application-id',
      scheduler: { mode: 'external' }
    },
    instanceId: 'test-pod-123',
    getRuntimeId: () => 'test-runtime-id',
    getAuthorizationHeaders: async () => ({ Authorization: 'Bearer test-token' }),
    env: {
      PLT_ICC_URL: `http://localhost:${port}`,
      PLT_UPDATES_RECONNECT_INTERVAL_SEC: 1
    },
    watt: {
      runtime: {},
      applySchedulerMode: async () => {}
    }
  }
}

test('runtime scheduler ownership always pauses jobs when ICC is configured', async () => {
  const instanceConfig = {}
  const jobs = [
    { name: 'configured', paused: false },
    { name: 'frontend:0', paused: false }
  ]
  const watt = new Watt({
    env: {
      PLT_APP_DIR: join(__dirname, 'fixtures', 'runtime-scheduler'),
      PLT_ICC_URL: 'http://localhost:3000'
    },
    log: { info: () => {} },
    instanceConfig,
    instanceId: 'test-pod-123'
  })

  watt.runtime = {
    getScheduler: () => jobs,
    pauseSchedulerJob: async name => {
      jobs.find(job => job.name === name).paused = true
    },
    resumeSchedulerJob: async name => {
      jobs.find(job => job.name === name).paused = false
    }
  }

  await watt.applySchedulerMode()
  assert.deepStrictEqual(jobs.map(job => job.paused), [true, true])

  await watt.applySchedulerMode()
  assert.deepStrictEqual(jobs.map(job => job.paused), [true, true])
})

function setupMockIccServer (wss) {
  let ws = null

  const waitForClientSubscription = once(wss, 'connection').then(([socket]) => {
    ws = socket

    return new Promise((resolve) => {
      socket.on('message', (data) => {
        const message = JSON.parse(data.toString())

        if (message.command === 'subscribe' && message.topic === '/config') {
          socket.send(JSON.stringify({ command: 'ack' }))
          resolve()
        }
      })
    })
  })

  return { waitForClientSubscription, getWs: () => ws }
}

test('run-scheduled-job: should execute the job callback when triggered over the websocket', async (t) => {
  setUpEnvironment()
  const port = 14100

  const wss = new WebSocket.Server({ port })
  t.after(() => wss.close())

  const { waitForClientSubscription, getWs } = setupMockIccServer(wss)

  // The target the job callback should hit
  const receivedRequests = []
  let requestResolve
  const requestReceived = new Promise((resolve) => { requestResolve = resolve })
  const target = createServer((req, res) => {
    receivedRequests.push({ method: req.method, url: req.url })
    res.end('{"ok":true}')
    requestResolve()
  })
  await new Promise((resolve) => target.listen(0, resolve))
  t.after(() => target.close())

  const app = createMockApp(port)
  await schedulerPlugin(app)
  await updatePlugin(app)
  await app.connectToUpdates()
  t.after(() => app.closeUpdates())
  await waitForClientSubscription

  getWs().send(JSON.stringify({
    command: 'run-scheduled-job',
    requestId: 'job-request-1',
    params: {
      name: 'cleanup',
      callbackUrl: `http://127.0.0.1:${target.address().port}/cleanup`,
      method: 'POST',
      source: 'config'
    }
  }))

  await requestReceived

  const response = JSON.parse((await once(getWs(), 'message'))[0].toString())
  assert.deepStrictEqual(response, {
    requestId: 'job-request-1',
    success: true,
    result: { name: 'cleanup', statusCode: 200 }
  })

  assert.deepStrictEqual(receivedRequests, [{ method: 'POST', url: '/cleanup' }])
})

test('run-scheduled-job: should route legacy internal callbacks through the runtime', async (t) => {
  const app = createMockApp(0)

  const injected = []
  app.watt.runtime.inject = async (applicationId, params) => {
    injected.push({ applicationId, ...params })
    return { statusCode: 200 }
  }

  await schedulerPlugin(app)

  const result = await app.runScheduledJob({
    name: 'cleanup',
    callbackUrl: 'http://frontend.plt.local/cleanup',
    method: 'POST',
    source: 'config',
    body: { scheduledTime: 1 }
  })

  assert.deepStrictEqual(result, { name: 'cleanup', statusCode: 200 })
  assert.strictEqual(injected.length, 1)
  assert.strictEqual(injected[0].applicationId, 'frontend')
  assert.strictEqual(injected[0].method, 'POST')
  assert.strictEqual(injected[0].url, '/cleanup')
  assert.strictEqual(injected[0].body, '{"scheduledTime":1}')
})

test('run-scheduled-job: should use native runtime execution for application jobs', async (t) => {
  const app = createMockApp(0)

  const executed = []
  app.watt.runtime.runSchedulerJob = async (name) => {
    executed.push(name)
    return { name, success: true }
  }

  await schedulerPlugin(app)

  const result = await app.runScheduledJob({ name: 'frontend:0', source: 'application' })

  assert.deepStrictEqual(executed, ['frontend:0'])
  assert.deepStrictEqual(result, { name: 'frontend:0', success: true })
})

test('run-scheduled-job: should fail on non-2xx callback responses', async (t) => {
  const app = createMockApp(0)

  app.watt.runtime.inject = async () => ({ statusCode: 500 })

  await schedulerPlugin(app)

  await assert.rejects(
    app.runScheduledJob({
      name: 'failing',
      callbackUrl: 'http://frontend.plt.local/failing',
      source: 'config'
    }),
    /Scheduled job "failing" failed with HTTP 500/
  )
})

test('collectSchedulerJobs: should use the runtime scheduler status when available', async (t) => {
  const app = createMockApp(0)

  app.watt.runtime.getScheduler = async () => ([
    {
      name: 'cleanup',
      cron: '0 * * * *',
      callbackUrl: 'http://service.plt.local/cleanup',
      method: 'POST',
      source: 'config',
      paused: false
    },
    {
      name: 'frontend:0',
      cron: '* * * * *',
      source: 'application',
      applicationId: 'frontend',
      scheduleId: '0',
      tasks: ['db:cleanup']
    }
  ])

  await schedulerPlugin(app)

  const jobs = await app.collectSchedulerJobs()

  assert.strictEqual(jobs.length, 2)
  assert.strictEqual(jobs[0].name, 'cleanup')
  assert.strictEqual(jobs[0].source, 'config')
  assert.strictEqual(jobs[1].name, 'frontend:0')
  assert.strictEqual(jobs[1].source, 'application')
  assert.strictEqual(jobs[1].applicationId, 'frontend')
  assert.strictEqual(jobs[1].scheduleId, '0')
  assert.deepStrictEqual(jobs[1].tasks, ['db:cleanup'])
})

test('sendSchedulerInfo: should register config jobs before skipping application jobs on old ICC', async () => {
  const app = createMockApp(0)
  app.instanceConfig.iccServices = { cron: { url: 'http://cron.local' } }
  app.watt.runtime.getScheduler = async () => ([
    {
      name: 'config-job',
      cron: '*/5 * * * *',
      callbackUrl: 'http://service.plt.local/run',
      source: 'config'
    },
    {
      name: 'application:0',
      cron: '* * * * *',
      source: 'application',
      applicationId: 'frontend',
      scheduleId: '0',
      tasks: ['cleanup']
    },
    {
      name: 'application:1',
      cron: '0 * * * *',
      source: 'application',
      applicationId: 'frontend',
      scheduleId: '1',
      tasks: ['sync']
    }
  ])

  const requests = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (_url, options) => {
    requests.push(JSON.parse(options.body))
    const status = requests.length === 2 ? 400 : 200
    return {
      status,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: async () => '',
      json: async () => ({ error: 'unsupported' })
    }
  }

  try {
    await schedulerPlugin(app)
    await app.sendSchedulerInfo()
  } finally {
    globalThis.fetch = originalFetch
  }

  assert.strictEqual(requests.length, 2)
  assert.strictEqual(requests[0].callbackUrl, 'http://service.plt.local/run')
  assert.strictEqual(requests[1].callbackUrl, undefined)
  assert.deepStrictEqual(requests[1].tasks, ['cleanup'])
})

test('without ICC: should not apply runtime scheduler ownership', async (t) => {
  const app = createMockApp(0)
  app.env.PLT_ICC_URL = undefined

  let applications = 0
  app.watt.applySchedulerMode = async () => {
    applications++
  }

  await schedulerPlugin(app)
  await app.sendSchedulerInfo()

  assert.strictEqual(applications, 0)
})
