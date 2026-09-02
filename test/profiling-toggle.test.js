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
  const commandWaiters = []

  function notifyCommandWaiters () {
    for (let i = commandWaiters.length - 1; i >= 0; i--) {
      const { command, count, resolve } = commandWaiters[i]
      if (commandCalls.filter((c) => c.command === command).length >= count) {
        commandWaiters.splice(i, 1)
        resolve()
      }
    }
  }

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
        notifyCommandWaiters()
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
    commandCalls,
    // Resolves when `count` calls of `command` have been recorded
    waitForCommands: (command, count) => {
      if (commandCalls.filter((c) => c.command === command).length >= count) {
        return Promise.resolve()
      }
      const { promise, resolve } = Promise.withResolvers()
      commandWaiters.push({ command, count, resolve })
      return promise
    }
  }

  return app
}

async function startScalerMock (t, opts = {}) {
  const scaler = fastify({ keepAliveTimeout: 1, forceCloseConnections: true })
  const statesReports = []
  const reportWaiters = []

  function notifyReportWaiters () {
    for (let i = reportWaiters.length - 1; i >= 0; i--) {
      const { count, resolve } = reportWaiters[i]
      if (statesReports.length >= count) {
        reportWaiters.splice(i, 1)
        resolve()
      }
    }
  }

  let activeStatesRequests = 0
  let maxConcurrentStatesRequests = 0

  if (!opts.withoutStatesRoute) {
    scaler.post('/scaler/flamegraphs/states', async (req) => {
      activeStatesRequests++
      maxConcurrentStatesRequests = Math.max(maxConcurrentStatesRequests, activeStatesRequests)
      if (opts.statesDelay) {
        await sleep(opts.statesDelay)
      }
      activeStatesRequests--
      statesReports.push(req.body)
      notifyReportWaiters()
      return {}
    })
  }

  await scaler.listen({ port: 0, host: '127.0.0.1' })
  t.after(() => scaler.close())

  // Resolves when `count` state reports have been received
  function waitForReports (count = 1) {
    if (statesReports.length >= count) {
      return Promise.resolve()
    }
    const { promise, resolve } = Promise.withResolvers()
    reportWaiters.push({ count, resolve })
    return promise
  }

  const url = `http://127.0.0.1:${scaler.server.address().port}/scaler`
  return {
    scaler,
    statesReports,
    url,
    waitForReports,
    getMaxConcurrentStatesRequests: () => maxConcurrentStatesRequests
  }
}

// The worker-started listener logs this message synchronously before arming a
// worker, so its absence right after a synchronous emit proves the listener
// took the deactivated branch, without waiting on wall-clock time.
const ARMING_LOG = 'Starting profiling on new worker'

function recordInfoLogs (app) {
  const messages = []
  app.log.info = (...args) => {
    messages.push(args[args.length - 1])
  }
  return messages
}

test('setProfilingEnabled(false) stops profiling for both types on every worker', async (t) => {
  setUpEnvironment()

  const { statesReports, url, waitForReports } = await startScalerMock(t)
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

  await waitForReports(1)
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
  const infoLogs = recordInfoLogs(app)

  // The mock runtime dispatches listeners synchronously and the arming log
  // happens before any await, so no waiting is needed for the negative check
  app.watt.runtime.emit('application:worker:started', {
    application: 'service-3',
    worker: 0
  })

  ok(!infoLogs.includes(ARMING_LOG))
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
  await app.waitForCommands('startProfiling', 2)

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

  // setupFlamegraphs awaits its start commands internally, so the check
  // right after it is deterministic
  await app.setupFlamegraphs()

  const startCalls = app.commandCalls.filter((c) => c.command === 'startProfiling')
  equal(startCalls.length, 0)
})

test('a pod started with PLT_DISABLE_FLAMEGRAPHS boots deactivated but reports its state', async (t) => {
  setUpEnvironment()

  const { statesReports, url, waitForReports } = await startScalerMock(t)
  const app = createMockApp({
    scalerUrl: url,
    env: { PLT_DISABLE_FLAMEGRAPHS: true }
  })

  await flamegraphsPlugin(app)
  await app.setupFlamegraphs()
  t.after(() => app.cleanupFlamegraphs())
  await waitForReports(1)

  const startCalls = app.commandCalls.filter((c) => c.command === 'startProfiling')
  equal(startCalls.length, 0)

  equal(statesReports.length, 1)
  ok(statesReports[0].states.every((s) => s.enabled === false))
})

test('a pod started with PLT_DISABLE_FLAMEGRAPHS can be activated at runtime', async (t) => {
  setUpEnvironment()

  const { url } = await startScalerMock(t)
  const app = createMockApp({
    scalerUrl: url,
    env: { PLT_DISABLE_FLAMEGRAPHS: true }
  })

  await flamegraphsPlugin(app)
  await app.setupFlamegraphs()
  t.after(() => app.cleanupFlamegraphs())

  const result = await app.setProfilingEnabled(true)
  equal(result.success, true)
  deepEqual(result.types.sort(), ['cpu', 'heap'])

  let startCalls = app.commandCalls.filter((c) => c.command === 'startProfiling')
  equal(startCalls.length, 4)

  // A worker started after the activation is armed too
  app.commandCalls.length = 0
  app.watt.runtime.emit('application:worker:started', {
    application: 'service-3',
    worker: 0
  })
  await app.waitForCommands('startProfiling', 2)

  startCalls = app.commandCalls.filter((c) => c.command === 'startProfiling')
  equal(startCalls.length, 2)

  // And it can be deactivated again
  app.commandCalls.length = 0
  await app.setProfilingEnabled(false)
  const stopCalls = app.commandCalls.filter((c) => c.command === 'stopProfiling')
  equal(stopCalls.length, 4)
})

test('sendFlamegraphs works on a runtime-activated pod started with PLT_DISABLE_FLAMEGRAPHS', async (t) => {
  setUpEnvironment()

  const { url } = await startScalerMock(t)
  const app = createMockApp({
    scalerUrl: url,
    env: { PLT_DISABLE_FLAMEGRAPHS: true }
  })
  let profileRequests = 0
  app.watt.runtime.getApplicationLastProfile = async () => {
    profileRequests++
    return { profile: new Uint8Array([1]), timestamp: Date.now(), preserved: false }
  }

  await flamegraphsPlugin(app)

  await app.sendFlamegraphs({ profileType: 'cpu' })
  equal(profileRequests, 0)

  await app.setProfilingEnabled(true)
  await app.sendFlamegraphs({ profileType: 'cpu' })
  equal(profileRequests, 2)
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
  await app.waitForCommands('stopProfiling', 4)

  const stopCalls = app.commandCalls.filter((c) => c.command === 'stopProfiling')
  equal(stopCalls.length, 4)

  app.commandCalls.length = 0
  ws.send(JSON.stringify({ command: 'start-profiling', params: { types: ['cpu'] } }))
  await app.waitForCommands('startProfiling', 2)

  const startCalls = app.commandCalls.filter((c) => c.command === 'startProfiling')
  equal(startCalls.length, 2)
  ok(startCalls.every((c) => c.options.type === 'cpu'))

  app.commandCalls.length = 0
  ws.send(JSON.stringify({ command: 'stop-profiling', params: { types: ['cpu'] } }))
  await app.waitForCommands('stopProfiling', 2)

  const cpuStopCalls = app.commandCalls.filter((c) => c.command === 'stopProfiling')
  equal(cpuStopCalls.length, 2)
  ok(cpuStopCalls.every((c) => c.options.type === 'cpu'))
})

test('a partial worker failure is not reported as success and the report carries the real state', async (t) => {
  setUpEnvironment()

  const { statesReports, url, waitForReports } = await startScalerMock(t)
  const failingWorker = 'service-2:0'
  const capturing = { 'service-1:0': false, 'service-2:0': false }
  const app = createMockApp({
    scalerUrl: url,
    sendCommandToApplication: async (workerId, command, options) => {
      if (command === 'startProfiling') {
        if (workerId === failingWorker) {
          throw new Error('boom')
        }
        capturing[workerId] = true
        return {}
      }
      if (command === 'stopProfiling') {
        capturing[workerId] = false
        return {}
      }
      if (command === 'getProfilingState') {
        return {
          isCapturing: capturing[workerId],
          isProfilerRunning: capturing[workerId],
          isPaused: false
        }
      }
      return {}
    }
  })

  await flamegraphsPlugin(app)

  await app.setProfilingEnabled(false)
  const result = await app.setProfilingEnabled(true)

  // The toggle is not a success and the intent is still recorded
  equal(result.success, false)
  equal(result.failures, 1)
  deepEqual(result.types.sort(), ['cpu', 'heap'])

  // The report distinguishes intent (enabled) from reality (isCapturing)
  await waitForReports(2)
  const report = statesReports[statesReports.length - 1]
  const failedState = report.states.find((s) => s.workerId === failingWorker && s.type === 'cpu')
  equal(failedState.enabled, true)
  equal(failedState.isCapturing, false)
  const okState = report.states.find((s) => s.workerId === 'service-1:0' && s.type === 'cpu')
  equal(okState.enabled, true)
  equal(okState.isCapturing, true)
})

test('a blocked worker does not stall the state report', async (t) => {
  setUpEnvironment()

  const { statesReports, url, waitForReports } = await startScalerMock(t)
  const app = createMockApp({
    scalerUrl: url,
    env: { PLT_FLAMEGRAPHS_STATE_QUERY_TIMEOUT: 100 },
    sendCommandToApplication: async (workerId, command) => {
      if (command === 'getProfilingState' && workerId === 'service-1:0') {
        // A blocked worker event loop: the query never settles
        return new Promise(() => {})
      }
      if (command === 'getProfilingState') {
        return {
          isCapturing: true,
          isProfilerRunning: true,
          isPaused: false
        }
      }
      return {}
    }
  })

  await flamegraphsPlugin(app)
  await app.reportProfilingStates()
  await waitForReports(1)

  // The blocked worker is reported as unresponsive, the healthy one normally
  const report = statesReports[0]
  equal(report.states.length, 4)
  const blockedStates = report.states.filter((s) => s.workerId === 'service-1:0')
  equal(blockedStates.length, 2)
  ok(blockedStates.every((s) => s.unresponsive === true))
  const healthyStates = report.states.filter((s) => s.workerId === 'service-2:0')
  equal(healthyStates.length, 2)
  ok(healthyStates.every((s) => s.isCapturing === true && s.unresponsive === undefined))
})

test('overlapping state reports are coalesced', async (t) => {
  setUpEnvironment()

  const mock = await startScalerMock(t, { statesDelay: 100 })
  const app = createMockApp({ scalerUrl: mock.url })

  await flamegraphsPlugin(app)

  // The second call while the first is in flight queues a single re-run
  const first = app.reportProfilingStates()
  const second = app.reportProfilingStates()
  equal(first, second)

  await first
  await mock.waitForReports(2)

  equal(mock.statesReports.length, 2)
  equal(mock.getMaxConcurrentStatesRequests(), 1)
})

test('a timed-out worker is not queried again until it restarts', async (t) => {
  setUpEnvironment()

  const { statesReports, url, waitForReports } = await startScalerMock(t)
  const app = createMockApp({
    scalerUrl: url,
    env: { PLT_FLAMEGRAPHS_STATE_QUERY_TIMEOUT: 100 },
    sendCommandToApplication: async (workerId, command) => {
      if (command === 'getProfilingState' && workerId === 'service-1:0') {
        // A blocked worker event loop: the query never settles
        return new Promise(() => {})
      }
      if (command === 'getProfilingState') {
        return {
          isCapturing: true,
          isProfilerRunning: true,
          isPaused: false
        }
      }
      return {}
    }
  })

  const queriesToBlockedWorker = () => app.commandCalls.filter(
    (c) => c.command === 'getProfilingState' && c.workerId === 'service-1:0'
  ).length

  await flamegraphsPlugin(app)
  await app.setupFlamegraphs()
  t.after(() => app.cleanupFlamegraphs())

  // The first report queries the blocked worker, times out, and suppresses it
  await waitForReports(1)
  equal(queriesToBlockedWorker(), 2)

  // The next report does not query the suppressed worker but still reports
  // it as unresponsive
  await app.reportProfilingStates()
  await waitForReports(2)
  equal(queriesToBlockedWorker(), 2)
  const suppressedReport = statesReports[statesReports.length - 1]
  equal(suppressedReport.states.length, 4)
  ok(suppressedReport.states
    .filter((s) => s.workerId === 'service-1:0')
    .every((s) => s.unresponsive === true))

  // A worker restart clears the suppression and it is queried again
  app.watt.runtime.emit('application:worker:started', {
    application: 'service-1',
    worker: 0
  })
  await app.reportProfilingStates()
  await waitForReports(3)
  equal(queriesToBlockedWorker(), 4)
})

test('attaches the last observed worker ELU to the state report', async (t) => {
  setUpEnvironment()

  const { statesReports, url, waitForReports } = await startScalerMock(t)
  const app = createMockApp({ scalerUrl: url })

  await flamegraphsPlugin(app)
  await app.setupFlamegraphs()
  t.after(() => app.cleanupFlamegraphs())
  await waitForReports(1)

  // The runtime health events carry the same ELU the profiling gate uses
  app.watt.runtime.emit('application:worker:health', {
    id: 'service-1:0',
    application: 'service-1',
    currentHealth: { elu: 0.97, heapUsed: 1, heapTotal: 2 }
  })

  await app.reportProfilingStates()
  await waitForReports(2)

  const report = statesReports[statesReports.length - 1]
  const sampled = report.states.filter((s) => s.workerId === 'service-1:0')
  ok(sampled.length > 0)
  ok(sampled.every((s) => s.lastELU === 0.97))

  // Workers without a sample simply omit the field (older runtimes, quiet
  // workers): the consumer must not require it
  const unsampled = report.states.filter((s) => s.workerId === 'service-2:0')
  ok(unsampled.every((s) => s.lastELU === undefined))
})

test('a stale ELU sample is not attached to the state report', async (t) => {
  setUpEnvironment()

  const { statesReports, url, waitForReports } = await startScalerMock(t)
  const app = createMockApp({ scalerUrl: url })

  await flamegraphsPlugin(app)
  await app.setupFlamegraphs()
  t.after(() => app.cleanupFlamegraphs())
  await waitForReports(1)

  app.watt.runtime.emit('application:worker:health', {
    id: 'service-1:0',
    application: 'service-1',
    currentHealth: { elu: 0.97 }
  })

  // Jump past the sample max age
  const realNow = Date.now()
  t.mock.method(Date, 'now', () => realNow + 61 * 1000)

  await app.reportProfilingStates()
  await waitForReports(2)

  const report = statesReports[statesReports.length - 1]
  ok(report.states.every((s) => s.lastELU === undefined))
})
