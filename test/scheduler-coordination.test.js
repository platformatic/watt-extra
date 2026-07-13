import assert from 'node:assert'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { join, dirname } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'
import { start } from '../index.js'
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

test('external mode: should disable local jobs, skip legacy registration and report the jobs in the state', async (t) => {
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

  // The local scheduler triggers are disabled
  const config = await app.watt.runtime.getRuntimeConfig()
  assert.strictEqual(config.scheduler[0].enabled, false)

  // The legacy per-job registration is skipped: the control-plane
  // registers the jobs centrally from the state report
  assert.strictEqual(savedWattJob, null)

  // The jobs are reported in the application state
  assert.ok(savedState, 'the state should have been reported')
  assert.ok(Array.isArray(savedState.scheduler), 'the state should include the scheduler jobs')
  assert.strictEqual(savedState.scheduler.length, 1)
  assert.strictEqual(savedState.scheduler[0].name, 'test')
  assert.strictEqual(savedState.scheduler[0].cron, '*/5 * * * *')
  assert.strictEqual(savedState.scheduler[0].callbackUrl, 'http://localhost:3000')
  assert.strictEqual(savedState.scheduler[0].source, 'config')
})

test('local mode: should keep the local jobs running and skip any registration', async (t) => {
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

  // ICC coordination is disabled: the local scheduler stays enabled
  const config = await app.watt.runtime.getRuntimeConfig()
  assert.notStrictEqual(config.scheduler[0].enabled, false)

  // No registration happens: the jobs run locally in each pod
  assert.strictEqual(savedWattJob, null)
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
    watt: { runtime: {} }
  }
}

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
    params: {
      name: 'cleanup',
      callbackUrl: `http://127.0.0.1:${target.address().port}/cleanup`,
      method: 'POST',
      source: 'config'
    }
  }))

  await requestReceived

  assert.deepStrictEqual(receivedRequests, [{ method: 'POST', url: '/cleanup' }])
})

test('run-scheduled-job: should route internal mesh callbacks through the runtime', async (t) => {
  const app = createMockApp(0)

  const injected = []
  app.watt.runtime.inject = async (applicationId, params) => {
    injected.push({ applicationId, ...params })
    return { statusCode: 200 }
  }

  await schedulerPlugin(app)

  const result = await app.runScheduledJob({
    name: 'frontend:db:cleanup',
    callbackUrl: 'http://frontend.plt.local/_platformatic/tasks/db:cleanup',
    method: 'POST',
    source: 'nitro',
    body: { scheduledTime: 1 }
  })

  assert.deepStrictEqual(result, { name: 'frontend:db:cleanup', statusCode: 200 })
  assert.strictEqual(injected.length, 1)
  assert.strictEqual(injected[0].applicationId, 'frontend')
  assert.strictEqual(injected[0].method, 'POST')
  assert.strictEqual(injected[0].url, '/_platformatic/tasks/db:cleanup')
  assert.strictEqual(injected[0].body, '{"scheduledTime":1}')
})

test('run-scheduled-job: should use the native runtime execution for config jobs when available', async (t) => {
  const app = createMockApp(0)

  const executed = []
  app.watt.runtime.runSchedulerJob = async (name) => {
    executed.push(name)
    return { name, success: true }
  }

  await schedulerPlugin(app)

  const result = await app.runScheduledJob({ name: 'cleanup', source: 'config' })

  assert.deepStrictEqual(executed, ['cleanup'])
  assert.deepStrictEqual(result, { name: 'cleanup', success: true })
})

test('run-scheduled-job: should fail on non-2xx callback responses', async (t) => {
  const app = createMockApp(0)

  app.watt.runtime.inject = async () => ({ statusCode: 500 })

  await schedulerPlugin(app)

  await assert.rejects(
    app.runScheduledJob({
      name: 'failing',
      callbackUrl: 'http://frontend.plt.local/failing',
      source: 'nitro'
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
      name: 'frontend:db:cleanup',
      cron: '* * * * *',
      callbackUrl: 'http://frontend.plt.local/_platformatic/tasks/db:cleanup',
      method: 'POST',
      source: 'nitro',
      applicationId: 'frontend',
      taskName: 'db:cleanup'
    }
  ])

  await schedulerPlugin(app)

  const jobs = await app.collectSchedulerJobs()

  assert.strictEqual(jobs.length, 2)
  assert.strictEqual(jobs[0].name, 'cleanup')
  assert.strictEqual(jobs[0].source, 'config')
  assert.strictEqual(jobs[1].name, 'frontend:db:cleanup')
  assert.strictEqual(jobs[1].source, 'nitro')
  assert.strictEqual(jobs[1].applicationId, 'frontend')
  assert.strictEqual(jobs[1].taskName, 'db:cleanup')
})

test('external mode: should switch the application-level schedulers to external', async (t) => {
  const app = createMockApp(0)

  app.watt.runtime.getScheduler = async () => ([
    { name: 'cleanup', cron: '0 * * * *', callbackUrl: 'http://x.plt.local/y', source: 'config' },
    { name: 'frontend:log', cron: '* * * * *', source: 'nitro', applicationId: 'frontend', taskName: 'log' },
    { name: 'frontend:sync', cron: '* * * * *', source: 'nitro', applicationId: 'frontend', taskName: 'sync' }
  ])

  const modeChanges = []
  app.watt.runtime.setApplicationSchedulerMode = async (applicationId, mode) => {
    modeChanges.push({ applicationId, mode })
  }

  await schedulerPlugin(app)
  await app.sendSchedulerInfo()

  // One switch per application, even with multiple tasks
  assert.deepStrictEqual(modeChanges, [{ applicationId: 'frontend', mode: 'external' }])
})
