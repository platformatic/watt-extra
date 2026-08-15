import { test } from 'node:test'
import { equal, ok, deepEqual } from 'node:assert'
import { once } from 'node:events'
import { setTimeout as sleep } from 'node:timers/promises'
import { WebSocketServer } from 'ws'
import fastify from 'fastify'
import { setUpEnvironment } from './helper.js'
import updatePlugin from '../plugins/update.js'
import flamegraphsPlugin from '../plugins/flamegraphs.js'

const port = 15100

function createMockApp (opts = {}) {
  const {
    scalerUrl,
    iccPort = port,
    env = {},
    sendCommandToApplication
  } = opts

  const eventListeners = new Map()
  const commandCalls = []

  const mockWatt = {
    runtime: {
      getWorkers: async () => ({
        'service-1:0': { application: 'service-1', worker: 0, status: 'started' },
        'service-2:0': { application: 'service-2', worker: 0, status: 'started' }
      }),
      getApplications: async () => ({
        applications: [{ id: 'service-1' }, { id: 'service-2' }]
      }),
      on: (event, listener) => {
        if (!eventListeners.has(event)) {
          eventListeners.set(event, [])
        }
        eventListeners.get(event).push(listener)
      },
      removeListener: (event, listener) => {
        const listeners = eventListeners.get(event)
        if (listeners) {
          const index = listeners.indexOf(listener)
          if (index !== -1) {
            listeners.splice(index, 1)
          }
        }
      },
      emit: (event, ...args) => {
        const listeners = eventListeners.get(event) || []
        for (const listener of listeners) {
          listener(...args)
        }
      },
      getApplicationDetails: async (id) => {
        return { id, sourceMaps: false }
      },
      sendCommandToApplication: async (workerId, command, options) => {
        commandCalls.push({ workerId, command, options })
        if (sendCommandToApplication) {
          return sendCommandToApplication(workerId, command, options)
        }
        if (command === 'getProfilingState') {
          return {
            isCapturing: true,
            hasProfile: false,
            isProfilerRunning: false,
            isPaused: true,
            eluThreshold: 0.4,
            latestProfileTimestamp: null
          }
        }
        return { success: true }
      }
    }
  }

  const app = {
    log: {
      info: () => {},
      error: () => {},
      warn: () => {},
      debug: () => {}
    },
    instanceConfig: {
      applicationId: 'test-application-id',
      iccServices: scalerUrl
        ? { scaler: { url: scalerUrl } }
        : undefined
    },
    instanceId: 'test-pod-123',
    getAuthorizationHeaders: async () => {
      return { Authorization: 'Bearer test-token' }
    },
    getRuntimeId: () => 'test-runtime-id',
    env: {
      PLT_APP_NAME: 'test-app',
      PLT_APP_DIR: '/path/to/app',
      PLT_ICC_URL: `http://localhost:${iccPort}`,
      PLT_DISABLE_FLAMEGRAPHS: false,
      PLT_FLAMEGRAPHS_INTERVAL_SEC: 1,
      PLT_FLAMEGRAPHS_ELU_THRESHOLD: 0,
      PLT_FLAMEGRAPHS_GRACE_PERIOD: 0,
      PLT_FLAMEGRAPHS_ATTEMPT_TIMEOUT: 1000,
      PLT_FLAMEGRAPHS_CACHE_CLEANUP_INTERVAL: 120000,
      PLT_FLAMEGRAPHS_STATE_REPORT_INTERVAL: 30000,
      ...env
    },
    watt: mockWatt,
    commandCalls
  }

  return app
}

async function startScalerMock (t, opts = {}) {
  const scaler = fastify({ keepAliveTimeout: 1, forceCloseConnections: true })
  const statesReports = []

  if (!opts.withoutStatesRoute) {
    scaler.post('/scaler/flamegraphs/states', async (req) => {
      statesReports.push(req.body)
      return {}
    })
  }

  await scaler.listen({ port: 0, host: '127.0.0.1' })
  t.after(() => scaler.close())

  const url = `http://127.0.0.1:${scaler.server.address().port}/scaler`
  return { scaler, statesReports, url }
}

test('setProfilingEnabled(false) stops profiling for both types on every worker', async (t) => {
  setUpEnvironment()

  const { statesReports, url } = await startScalerMock(t)
  const app = createMockApp({ scalerUrl: url })

  await flamegraphsPlugin(app)

  const result = await app.setProfilingEnabled(false)
  equal(result.success, true)
  equal(result.enabled, false)

  const stopCalls = app.commandCalls.filter((c) => c.command === 'stopProfiling')
  equal(stopCalls.length, 4)
  for (const workerId of ['service-1:0', 'service-2:0']) {
    for (const type of ['cpu', 'heap']) {
      ok(stopCalls.find((c) => c.workerId === workerId && c.options.type === type))
    }
  }

  await sleep(200)
  equal(statesReports.length, 1)
})

test('setProfilingEnabled(true) after a stop restarts profiling with the boot options', async (t) => {
  setUpEnvironment()

  const { url } = await startScalerMock(t)
  const app = createMockApp({ scalerUrl: url })

  await flamegraphsPlugin(app)

  await app.setProfilingEnabled(false)
  app.commandCalls.length = 0

  const result = await app.setProfilingEnabled(true)
  equal(result.success, true)
  deepEqual(result.types.sort(), ['cpu', 'heap'])

  const startCalls = app.commandCalls.filter((c) => c.command === 'startProfiling')
  equal(startCalls.length, 4)
  for (const call of startCalls) {
    equal(call.options.durationMillis, 1000)
    equal(call.options.eluThreshold, 0)
    equal(call.options.sourceMaps, false)
  }
})

test('already-started and not-started profiler errors are treated as success', async (t) => {
  setUpEnvironment()

  const { url } = await startScalerMock(t)
  const app = createMockApp({
    scalerUrl: url,
    sendCommandToApplication: async (workerId, command) => {
      if (command === 'startProfiling') {
        const err = new Error('Profiling already started')
        err.code = 'PLT_PPROF_PROFILING_ALREADY_STARTED'
        throw err
      }
      if (command === 'stopProfiling') {
        const err = new Error('Profiling not started')
        err.code = 'PLT_PPROF_PROFILING_NOT_STARTED'
        throw err
      }
      return {}
    }
  })

  await flamegraphsPlugin(app)

  const stopResult = await app.setProfilingEnabled(false)
  equal(stopResult.success, true)

  const startResult = await app.setProfilingEnabled(true)
  equal(startResult.success, true)
})

test('a worker started while profiling is deactivated is not armed', async (t) => {
  setUpEnvironment()

  const { url } = await startScalerMock(t)
  const app = createMockApp({ scalerUrl: url })

  await flamegraphsPlugin(app)
  await app.setupFlamegraphs()
  t.after(() => app.cleanupFlamegraphs())

  await app.setProfilingEnabled(false)
  app.commandCalls.length = 0

  app.watt.runtime.emit('application:worker:started', {
    application: 'service-3',
    worker: 0
  })
  await sleep(100)

  const startCalls = app.commandCalls.filter((c) => c.command === 'startProfiling')
  equal(startCalls.length, 0)
})

test('a worker started while profiling is activated is armed', async (t) => {
  setUpEnvironment()

  const { url } = await startScalerMock(t)
  const app = createMockApp({ scalerUrl: url })

  await flamegraphsPlugin(app)
  await app.setupFlamegraphs()
  t.after(() => app.cleanupFlamegraphs())

  await app.setProfilingEnabled(false)
  await app.setProfilingEnabled(true)
  app.commandCalls.length = 0

  app.watt.runtime.emit('application:worker:started', {
    application: 'service-3',
    worker: 0
  })
  await sleep(100)

  const startCalls = app.commandCalls.filter((c) => c.command === 'startProfiling')
  equal(startCalls.length, 2)
  ok(startCalls.every((c) => c.workerId === 'service-3:0'))
})

test('a re-setup after an ICC recovery does not re-enable a deactivated pod', async (t) => {
  setUpEnvironment()

  const { url } = await startScalerMock(t)
  const app = createMockApp({ scalerUrl: url })

  await flamegraphsPlugin(app)
  await app.setupFlamegraphs()
  t.after(() => app.cleanupFlamegraphs())

  await app.setProfilingEnabled(false)
  app.commandCalls.length = 0

  await app.setupFlamegraphs()
  await sleep(100)

  const startCalls = app.commandCalls.filter((c) => c.command === 'startProfiling')
  equal(startCalls.length, 0)
})

test('PLT_DISABLE_FLAMEGRAPHS wins over the toggle command', async (t) => {
  setUpEnvironment()

  const { url } = await startScalerMock(t)
  const app = createMockApp({
    scalerUrl: url,
    env: { PLT_DISABLE_FLAMEGRAPHS: true }
  })

  await flamegraphsPlugin(app)

  const result = await app.setProfilingEnabled(true)
  equal(result.success, false)
  equal(result.reason, 'disabled-by-env')
  equal(app.commandCalls.length, 0)
})

test('sendFlamegraphs on a deactivated pod returns early without collecting', async (t) => {
  setUpEnvironment()

  const { url } = await startScalerMock(t)
  const app = createMockApp({ scalerUrl: url })
  let profileRequests = 0
  app.watt.runtime.getApplicationLastProfile = async () => {
    profileRequests++
    return { profile: new Uint8Array([1]), timestamp: Date.now(), preserved: false }
  }

  await flamegraphsPlugin(app)
  await app.setProfilingEnabled(false)

  await app.sendFlamegraphs({ profileType: 'cpu' })
  equal(profileRequests, 0)
})

test('reportProfilingStates posts the desired and real state of every worker', async (t) => {
  setUpEnvironment()

  const { statesReports, url } = await startScalerMock(t)
  const app = createMockApp({ scalerUrl: url })

  await flamegraphsPlugin(app)
  await app.reportProfilingStates()

  equal(statesReports.length, 1)
  const report = statesReports[0]
  equal(report.applicationId, 'test-application-id')
  equal(report.podId, 'test-pod-123')
  equal(report.expiresIn, 90000)
  equal(report.states.length, 4)

  const state = report.states.find(
    (s) => s.workerId === 'service-1:0' && s.type === 'cpu'
  )
  equal(state.serviceId, 'service-1')
  equal(state.enabled, true)
  equal(state.isCapturing, true)
  equal(state.isPaused, true)
})

test('reportProfilingStates disables itself when the scaler does not support it', async (t) => {
  setUpEnvironment()

  const { statesReports, url } = await startScalerMock(t, { withoutStatesRoute: true })
  const app = createMockApp({ scalerUrl: url })

  let warnings = 0
  app.log.warn = () => { warnings++ }

  await flamegraphsPlugin(app)
  await app.reportProfilingStates()
  await app.reportProfilingStates()

  equal(statesReports.length, 0)
  equal(warnings, 1)
})

test('a worker without the profiling state command is reported as unsupported', async (t) => {
  setUpEnvironment()

  const { statesReports, url } = await startScalerMock(t)
  const app = createMockApp({
    scalerUrl: url,
    sendCommandToApplication: async (workerId, command) => {
      if (command === 'getProfilingState') {
        return {}
      }
      return { success: true }
    }
  })

  await flamegraphsPlugin(app)
  await app.reportProfilingStates()

  equal(statesReports.length, 1)
  const report = statesReports[0]
  equal(report.states.length, 4)
  for (const state of report.states) {
    equal(state.unsupported, true)
    equal(state.enabled, true)
  }
})

test('handles start-profiling and stop-profiling commands from ICC', async (t) => {
  setUpEnvironment()

  const receivedMessages = []
  const wsPort = port + 1
  const wss = new WebSocketServer({ port: wsPort })
  t.after(async () => wss.close())

  let ws = null
  const waitForClientSubscription = once(wss, 'connection').then(([socket]) => {
    ws = socket
    return new Promise((resolve) => {
      socket.on('message', (data) => {
        const message = JSON.parse(data.toString())
        receivedMessages.push(message)
        if (message.command === 'subscribe' && message.topic === '/config') {
          socket.send(JSON.stringify({ command: 'ack' }))
          resolve()
        }
      })
    })
  })

  const { url } = await startScalerMock(t)
  const app = createMockApp({ scalerUrl: url, iccPort: wsPort })

  await updatePlugin(app)
  await flamegraphsPlugin(app)
  await app.connectToUpdates()
  t.after(async () => {
    await app.cleanupFlamegraphs()
    await app.closeUpdates()
  })

  await waitForClientSubscription

  ws.send(JSON.stringify({ command: 'stop-profiling', params: {} }))
  await sleep(200)

  let stopCalls = app.commandCalls.filter((c) => c.command === 'stopProfiling')
  equal(stopCalls.length, 4)

  app.commandCalls.length = 0
  ws.send(JSON.stringify({ command: 'start-profiling', params: { types: ['cpu'] } }))
  await sleep(200)

  const startCalls = app.commandCalls.filter((c) => c.command === 'startProfiling')
  equal(startCalls.length, 2)
  ok(startCalls.every((c) => c.options.type === 'cpu'))

  app.commandCalls.length = 0
  ws.send(JSON.stringify({ command: 'stop-profiling', params: { types: ['cpu'] } }))
  await sleep(200)

  stopCalls = app.commandCalls.filter((c) => c.command === 'stopProfiling')
  equal(stopCalls.length, 2)
  ok(stopCalls.every((c) => c.options.type === 'cpu'))
})
