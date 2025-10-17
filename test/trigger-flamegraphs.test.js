import { test } from 'node:test'
import { equal } from 'node:assert'
import { once } from 'node:events'
import { setTimeout as sleep } from 'node:timers/promises'
import { WebSocketServer } from 'ws'
import { setUpEnvironment } from './helper.js'
import updatePlugin from '../plugins/update.js'
import flamegraphsPlugin from '../plugins/flamegraphs.js'

function setupMockIccServer (wss, receivedMessages, validateAuth = false) {
  let ws = null

  const waitForClientSubscription = once(wss, 'connection').then(
    ([socket, req]) => {
      ws = socket

      if (validateAuth) {
        equal(req.headers.authorization, 'Bearer test-token')
      }

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
    }
  )

  return { waitForClientSubscription, getWs: () => ws }
}

function createMockApp (port, includeScalerUrl = true) {
  const eventListeners = new Map()

  const mockWatt = {
    areFlamegraphsEnabled: true,
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
      applicationId: 'test-application-id'
    },
    instanceId: 'test-pod-123',
    getAuthorizationHeader: async () => {
      return { Authorization: 'Bearer test-token' }
    },
    env: {
      PLT_APP_NAME: 'test-app',
      PLT_APP_DIR: '/path/to/app',
      PLT_ICC_URL: `http://localhost:${port}`,
      PLT_DISABLE_FLAMEGRAPHS: false,
      PLT_FLAMEGRAPHS_INTERVAL_SEC: 1,
      PLT_FLAMEGRAPHS_ELU_THRESHOLD: 0,
      PLT_FLAMEGRAPHS_GRACE_PERIOD: 0
    },
    watt: mockWatt
  }

  if (includeScalerUrl) {
    app.instanceConfig.iccServices = {
      scaler: {
        url: `http://localhost:${port}/scaler`
      }
    }
  }

  return app
}

const port = 14000

test('should handle trigger-flamegraph command and upload flamegraphs from services', async (t) => {
  setUpEnvironment()

  const receivedMessages = []
  const getFlamegraphReqs = []
  let uploadResolve
  const allUploadsComplete = new Promise((resolve) => {
    uploadResolve = resolve
  })

  const wss = new WebSocketServer({ port })
  t.after(async () => wss.close())

  const { waitForClientSubscription, getWs } = setupMockIccServer(
    wss,
    receivedMessages,
    true
  )

  const app = createMockApp(port)

  app.watt.runtime.sendCommandToApplication = async (
    serviceId,
    command
  ) => {
    if (command === 'startProfiling') {
      return { success: true }
    }
    if (command === 'getLastProfile') {
      getFlamegraphReqs.push({ serviceId })
      if (getFlamegraphReqs.length === 2) {
        uploadResolve()
      }
      return new Uint8Array([1, 2, 3, 4, 5])
    }
    return { success: false }
  }

  await updatePlugin(app)
  await flamegraphsPlugin(app)

  await app.connectToUpdates()
  await app.setupFlamegraphs()

  await waitForClientSubscription

  const triggerFlamegraphMessage = {
    command: 'trigger-flamegraph'
  }

  getWs().send(JSON.stringify(triggerFlamegraphMessage))

  await allUploadsComplete

  equal(getFlamegraphReqs.length, 2)

  const service1Req = getFlamegraphReqs.find(
    (f) => f.serviceId === 'service-1'
  )
  const service2Req = getFlamegraphReqs.find(
    (f) => f.serviceId === 'service-2'
  )

  equal(service1Req.serviceId, 'service-1')
  equal(service2Req.serviceId, 'service-2')

  if (app.cleanupFlamegraphs) app.cleanupFlamegraphs()
  await app.closeUpdates()
})

test('should handle trigger-flamegraph when no runtime is available', async (t) => {
  setUpEnvironment()

  const receivedMessages = []

  const wss = new WebSocketServer({ port: port + 1 })
  t.after(async () => wss.close())

  const { waitForClientSubscription, getWs } = setupMockIccServer(
    wss,
    receivedMessages,
    false
  )

  const app = createMockApp(port + 1)
  app.watt.runtime = null

  await updatePlugin(app)
  await app.connectToUpdates()
  await waitForClientSubscription

  const triggerFlamegraphMessage = {
    command: 'trigger-flamegraph'
  }

  getWs().send(JSON.stringify(triggerFlamegraphMessage))

  await sleep(100)

  if (app.cleanupFlamegraphs) app.cleanupFlamegraphs()
  await app.closeUpdates()
})

test('should handle trigger-flamegraph when flamegraph upload fails', async (t) => {
  setUpEnvironment()

  const receivedMessages = []

  const wss = new WebSocketServer({ port: port + 2 })
  t.after(async () => wss.close())

  const { waitForClientSubscription, getWs } = setupMockIccServer(
    wss,
    receivedMessages,
    false
  )

  const app = createMockApp(port + 2)

  app.watt.runtime.sendCommandToApplication = async (
    serviceId,
    command,
    options
  ) => {
    if (command === 'startProfiling') {
      return { success: true }
    }
    if (command === 'sendFlamegraph' && options.url && options.headers) {
      throw new Error('Flamegraph upload failed')
    }
    return { success: false }
  }

  await updatePlugin(app)
  await flamegraphsPlugin(app)

  await app.connectToUpdates()
  await app.setupFlamegraphs()

  await waitForClientSubscription

  const triggerFlamegraphMessage = {
    command: 'trigger-flamegraph'
  }

  getWs().send(JSON.stringify(triggerFlamegraphMessage))

  await sleep(100)

  if (app.cleanupFlamegraphs) app.cleanupFlamegraphs()
  await app.closeUpdates()
})

test('should handle trigger-heapprofile command and upload heap profiles from services', async (t) => {
  setUpEnvironment()

  const receivedMessages = []
  const getHeapProfileReqs = []
  let uploadResolve
  const allUploadsComplete = new Promise((resolve) => {
    uploadResolve = resolve
  })

  const wss = new WebSocketServer({ port: port + 3 })
  t.after(async () => wss.close())

  const { waitForClientSubscription, getWs } = setupMockIccServer(
    wss,
    receivedMessages,
    true
  )

  const app = createMockApp(port + 3)

  app.watt.runtime.sendCommandToApplication = async (
    serviceId,
    command,
    options
  ) => {
    if (options && options.type) {
      equal(options.type, 'heap')
    }
    if (command === 'startProfiling') {
      return { success: true }
    }
    if (command === 'getLastProfile') {
      getHeapProfileReqs.push({ serviceId })
      if (getHeapProfileReqs.length === 2) {
        uploadResolve()
      }
      return new Uint8Array([1, 2, 3, 4, 5])
    }
    return { success: false }
  }

  await updatePlugin(app)
  await flamegraphsPlugin(app)

  await app.connectToUpdates()
  await app.setupFlamegraphs()

  await waitForClientSubscription

  const triggerHeapProfileMessage = {
    command: 'trigger-heapprofile'
  }

  getWs().send(JSON.stringify(triggerHeapProfileMessage))

  await allUploadsComplete

  equal(getHeapProfileReqs.length, 2)

  const service1Req = getHeapProfileReqs.find(
    (f) => f.serviceId === 'service-1'
  )
  const service2Req = getHeapProfileReqs.find(
    (f) => f.serviceId === 'service-2'
  )

  equal(service1Req.serviceId, 'service-1')
  equal(service2Req.serviceId, 'service-2')

  if (app.cleanupFlamegraphs) app.cleanupFlamegraphs()
  await app.closeUpdates()
})

test('should handle PLT_PPROF_NO_PROFILE_AVAILABLE error with info log', async (t) => {
  setUpEnvironment()

  const receivedMessages = []
  const infoLogs = []
  let errorCount = 0
  let uploadResolve
  const allUploadsComplete = new Promise((resolve) => {
    uploadResolve = resolve
  })

  const wss = new WebSocketServer({ port: port + 4 })
  t.after(async () => wss.close())

  const { waitForClientSubscription, getWs } = setupMockIccServer(
    wss,
    receivedMessages,
    true
  )

  const app = createMockApp(port + 4)
  const originalInfo = app.log.info
  app.log.info = (...args) => {
    originalInfo(...args)
    if (args[1] && args[1].includes('No profile available for the service')) {
      infoLogs.push(args)
      errorCount++
      if (errorCount === 2) {
        uploadResolve()
      }
    }
  }

  app.watt.runtime.sendCommandToApplication = async (
    serviceId,
    command
  ) => {
    if (command === 'startProfiling') {
      return { success: true }
    }
    if (command === 'getLastProfile') {
      const error = new Error('No profile available - wait for profiling to complete or trigger manual capture')
      error.code = 'PLT_PPROF_NO_PROFILE_AVAILABLE'
      throw error
    }
    return { success: false }
  }

  await updatePlugin(app)
  await flamegraphsPlugin(app)

  await app.connectToUpdates()
  await app.setupFlamegraphs()

  await waitForClientSubscription

  const triggerFlamegraphMessage = {
    command: 'trigger-flamegraph'
  }

  getWs().send(JSON.stringify(triggerFlamegraphMessage))

  await allUploadsComplete

  equal(infoLogs.length, 2)
  equal(infoLogs[0][0].serviceId, 'service-1')
  equal(infoLogs[0][0].podId, 'test-pod-123')
  equal(infoLogs[0][1], 'No profile available for the service')

  if (app.cleanupFlamegraphs) app.cleanupFlamegraphs()
  await app.closeUpdates()
})

test('should handle PLT_PPROF_NOT_ENOUGH_ELU error with info log', async (t) => {
  setUpEnvironment()

  const receivedMessages = []
  const infoLogs = []
  let errorCount = 0
  let uploadResolve
  const allUploadsComplete = new Promise((resolve) => {
    uploadResolve = resolve
  })

  const wss = new WebSocketServer({ port: port + 5 })
  t.after(async () => wss.close())

  const { waitForClientSubscription, getWs } = setupMockIccServer(
    wss,
    receivedMessages,
    true
  )

  const app = createMockApp(port + 5)
  const originalInfo = app.log.info
  app.log.info = (...args) => {
    originalInfo(...args)
    if (args[1] && args[1].includes('ELU low, CPU profiling not active')) {
      infoLogs.push(args)
      errorCount++
      if (errorCount === 2) {
        uploadResolve()
      }
    }
  }

  app.watt.runtime.sendCommandToApplication = async (
    serviceId,
    command
  ) => {
    if (command === 'startProfiling') {
      return { success: true }
    }
    if (command === 'getLastProfile') {
      const error = new Error('No profile available - event loop utilization has been below threshold for too long')
      error.code = 'PLT_PPROF_NOT_ENOUGH_ELU'
      throw error
    }
    return { success: false }
  }

  await updatePlugin(app)
  await flamegraphsPlugin(app)

  await app.connectToUpdates()
  await app.setupFlamegraphs()

  await waitForClientSubscription

  const triggerFlamegraphMessage = {
    command: 'trigger-flamegraph'
  }

  getWs().send(JSON.stringify(triggerFlamegraphMessage))

  await allUploadsComplete

  equal(infoLogs.length, 2)
  equal(infoLogs[0][0].serviceId, 'service-1')
  equal(infoLogs[0][0].podId, 'test-pod-123')
  equal(infoLogs[0][1], 'ELU low, CPU profiling not active')

  if (app.cleanupFlamegraphs) app.cleanupFlamegraphs()
  await app.closeUpdates()
})

test('should start profiling on new workers that start after initial setup', async (t) => {
  setUpEnvironment()

  const receivedMessages = []
  const startProfilingCalls = []

  const wss = new WebSocketServer({ port: port + 6 })
  t.after(async () => wss.close())

  const { waitForClientSubscription } = setupMockIccServer(
    wss,
    receivedMessages,
    false
  )

  const app = createMockApp(port + 6)

  app.watt.runtime.sendCommandToApplication = async (
    serviceId,
    command,
    options
  ) => {
    if (command === 'startProfiling') {
      startProfilingCalls.push({ serviceId, options })
    }
    return { success: true }
  }

  await updatePlugin(app)
  await flamegraphsPlugin(app)

  await app.connectToUpdates()
  await app.setupFlamegraphs()

  await waitForClientSubscription

  equal(startProfilingCalls.length, 4)
  equal(startProfilingCalls[0].serviceId, 'service-1:0')
  equal(startProfilingCalls[0].options.type, 'cpu')
  equal(startProfilingCalls[1].serviceId, 'service-1:0')
  equal(startProfilingCalls[1].options.type, 'heap')
  equal(startProfilingCalls[2].serviceId, 'service-2:0')
  equal(startProfilingCalls[2].options.type, 'cpu')
  equal(startProfilingCalls[3].serviceId, 'service-2:0')
  equal(startProfilingCalls[3].options.type, 'heap')

  app.watt.runtime.emit('application:worker:started', {
    application: 'service-1',
    worker: 1,
    workersCount: 2
  })

  await sleep(10)

  equal(startProfilingCalls.length, 6)
  equal(startProfilingCalls[4].serviceId, 'service-1:1')
  equal(startProfilingCalls[4].options.durationMillis, 1000)
  equal(startProfilingCalls[4].options.eluThreshold, 0)
  equal(startProfilingCalls[4].options.type, 'cpu')
  equal(startProfilingCalls[5].serviceId, 'service-1:1')
  equal(startProfilingCalls[5].options.durationMillis, 1000)
  equal(startProfilingCalls[5].options.eluThreshold, 0)
  equal(startProfilingCalls[5].options.type, 'heap')

  if (app.cleanupFlamegraphs) app.cleanupFlamegraphs()
  await app.closeUpdates()
})

test('should not start profiling on new workers when flamegraphs are disabled', async (t) => {
  setUpEnvironment()

  const receivedMessages = []
  const startProfilingCalls = []

  const wss = new WebSocketServer({ port: port + 7 })
  t.after(async () => wss.close())

  const { waitForClientSubscription } = setupMockIccServer(
    wss,
    receivedMessages,
    false
  )

  const app = createMockApp(port + 7)
  app.env.PLT_DISABLE_FLAMEGRAPHS = true

  app.watt.runtime.sendCommandToApplication = async (
    serviceId,
    command,
    options
  ) => {
    if (command === 'startProfiling') {
      startProfilingCalls.push({ serviceId, options })
    }
    return { success: true }
  }

  await updatePlugin(app)
  await flamegraphsPlugin(app)

  await app.connectToUpdates()
  await app.setupFlamegraphs()

  await waitForClientSubscription

  equal(startProfilingCalls.length, 0)

  app.watt.runtime.emit('application:worker:started', {
    application: 'service-1',
    worker: 1,
    workersCount: 2
  })

  await sleep(10)

  equal(startProfilingCalls.length, 0)

  if (app.cleanupFlamegraphs) app.cleanupFlamegraphs()
  await app.closeUpdates()
})
