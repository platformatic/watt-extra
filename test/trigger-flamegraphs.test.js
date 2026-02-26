import { test } from 'node:test'
import { equal, ok, deepEqual } from 'node:assert'
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

function createMockApp (port, includeScalerUrl = true, env = {}) {
  const eventListeners = new Map()

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
        // Default implementation, can be overridden in tests
        return { id, sourceMaps: false }
      },
      getRuntimeConfig: async () => {
        // Default implementation, can be overridden in tests
        return {}
      }
    }
  }

  let runtimeId = null
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
    getRuntimeId: () => {
      if (!runtimeId) {
        runtimeId = 'test-runtime-id'
      }
      return runtimeId
    },
    env: {
      PLT_APP_NAME: 'test-app',
      PLT_APP_DIR: '/path/to/app',
      PLT_ICC_URL: `http://localhost:${port}`,
      PLT_DISABLE_FLAMEGRAPHS: false,
      PLT_FLAMEGRAPHS_INTERVAL_SEC: 1,
      PLT_FLAMEGRAPHS_ELU_THRESHOLD: 0,
      PLT_FLAMEGRAPHS_GRACE_PERIOD: 0,
      PLT_FLAMEGRAPHS_ATTEMPT_TIMEOUT: 1000,
      ...env
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

test('setupFlamegraphs should pass sourceMaps from application config to startProfiling', async (t) => {
  setUpEnvironment()

  const app = createMockApp(port)
  const startProfilingCalls = []

  // Mock getApplicationDetails to return config with sourceMaps for worker IDs
  app.watt.runtime.getApplicationDetails = async (workerFullId) => {
    if (workerFullId.startsWith('service-1')) {
      return { id: workerFullId, sourceMaps: true }
    } else if (workerFullId.startsWith('service-2')) {
      return { id: workerFullId, sourceMaps: false }
    }
    return { id: workerFullId, sourceMaps: false }
  }

  app.watt.runtime.getRuntimeConfig = async () => {
    return {}
  }

  app.watt.runtime.sendCommandToApplication = async (workerFullId, command, options) => {
    if (command === 'startProfiling') {
      startProfilingCalls.push({ workerFullId, command, options })
      return { success: true }
    }
    return { success: false }
  }

  await flamegraphsPlugin(app)
  await app.setupFlamegraphs()

  // Should call startProfiling 4 times: 2 workers × 2 profile types (cpu + heap)
  equal(startProfilingCalls.length, 4, 'Should call startProfiling for both workers with cpu and heap')

  const service1CpuCall = startProfilingCalls.find(c => c.workerFullId === 'service-1:0' && c.options.type === 'cpu')
  const service1HeapCall = startProfilingCalls.find(c => c.workerFullId === 'service-1:0' && c.options.type === 'heap')
  const service2CpuCall = startProfilingCalls.find(c => c.workerFullId === 'service-2:0' && c.options.type === 'cpu')
  const service2HeapCall = startProfilingCalls.find(c => c.workerFullId === 'service-2:0' && c.options.type === 'heap')

  ok(service1CpuCall, 'Should have called startProfiling for service-1 CPU')
  ok(service1HeapCall, 'Should have called startProfiling for service-1 heap')
  ok(service2CpuCall, 'Should have called startProfiling for service-2 CPU')
  ok(service2HeapCall, 'Should have called startProfiling for service-2 heap')

  equal(service1CpuCall.options.sourceMaps, true, 'Should pass sourceMaps=true for service-1 CPU')
  equal(service1HeapCall.options.sourceMaps, true, 'Should pass sourceMaps=true for service-1 heap')
  equal(service2CpuCall.options.sourceMaps, false, 'Should pass sourceMaps=false for service-2 CPU')
  equal(service2HeapCall.options.sourceMaps, false, 'Should pass sourceMaps=false for service-2 heap')
})

test('setupFlamegraphs should handle missing sourceMaps in application config', async (t) => {
  setUpEnvironment()

  const app = createMockApp(port)
  const startProfilingCalls = []

  // Mock getApplicationDetails to return config without sourceMaps
  app.watt.runtime.getApplicationDetails = async (workerFullId) => {
    return { id: workerFullId }
  }

  app.watt.runtime.getRuntimeConfig = async () => {
    return {}
  }

  app.watt.runtime.sendCommandToApplication = async (workerFullId, command, options) => {
    if (command === 'startProfiling') {
      startProfilingCalls.push({ workerFullId, command, options })
      return { success: true }
    }
    return { success: false }
  }

  await flamegraphsPlugin(app)
  await app.setupFlamegraphs()

  equal(startProfilingCalls.length, 4, 'Should call startProfiling for both workers with cpu and heap')

  for (const call of startProfilingCalls) {
    equal(call.options.sourceMaps, false, 'sourceMaps should be false when not in config')
    equal(call.options.durationMillis, 1000, 'Should still pass duration')
  }
})

test('setupFlamegraphs should skip profiling when PLT_DISABLE_FLAMEGRAPHS is set', async (t) => {
  setUpEnvironment()

  const app = createMockApp(port)
  app.env.PLT_DISABLE_FLAMEGRAPHS = true

  const startProfilingCalls = []

  app.watt.runtime.sendCommandToApplication = async (serviceId, command, options) => {
    if (command === 'startProfiling') {
      startProfilingCalls.push({ serviceId, command, options })
      return { success: true }
    }
    return { success: false }
  }

  await flamegraphsPlugin(app)
  await app.setupFlamegraphs()

  equal(startProfilingCalls.length, 0, 'Should not call startProfiling when disabled')
})

test('setupFlamegraphs should handle errors when starting profiling', async (t) => {
  setUpEnvironment()

  const app = createMockApp(port)
  const errors = []

  app.log.error = (result) => {
    errors.push(result)
  }

  app.watt.runtime.getApplicationDetails = async (workerFullId) => {
    return { id: workerFullId, sourceMaps: true }
  }

  app.watt.runtime.getRuntimeConfig = async () => {
    return {}
  }

  app.watt.runtime.sendCommandToApplication = async (workerFullId, command, options) => {
    if (command === 'startProfiling') {
      throw new Error(`Failed to start profiling for ${workerFullId}`)
    }
    return { success: false }
  }

  await flamegraphsPlugin(app)
  await app.setupFlamegraphs()

  // Should log 4 errors (2 workers, each logged twice: once in startProfilingOnWorker, once in setupFlamegraphs)
  equal(errors.length, 4, 'Should log errors for both failed workers')
})

test('sendFlamegraphs should upload flamegraphs from all services', async (t) => {
  setUpEnvironment()

  const uploadedFlamegraphs = []
  const httpPort = port + 100

  const app = createMockApp(httpPort)

  const mockProfile = new Uint8Array([1, 2, 3, 4, 5])

  app.watt.runtime.sendCommandToApplication = async (serviceId, command) => {
    if (command === 'getLastProfile') {
      return mockProfile
    }
    return { success: false }
  }

  // Mock HTTP server to receive flamegraphs
  const { createServer } = await import('node:http')
  const server = createServer((req, res) => {
    const body = []
    req.on('data', chunk => body.push(chunk))
    req.on('end', () => {
      const buffer = Buffer.concat(body)
      uploadedFlamegraphs.push({
        url: req.url,
        headers: req.headers,
        body: buffer
      })
      res.writeHead(200)
      res.end()
    })
  })

  await new Promise(resolve => server.listen(httpPort, resolve))
  t.after(() => server.close())

  await flamegraphsPlugin(app)
  await app.sendFlamegraphs()

  equal(uploadedFlamegraphs.length, 2, 'Should upload flamegraphs for both services')

  const service1Upload = uploadedFlamegraphs.find(u => u.url.includes('service-1'))
  const service2Upload = uploadedFlamegraphs.find(u => u.url.includes('service-2'))

  ok(service1Upload, 'Should upload flamegraph for service-1')
  ok(service2Upload, 'Should upload flamegraph for service-2')

  equal(service1Upload.headers['content-type'], 'application/octet-stream')
  equal(service1Upload.headers.authorization, 'Bearer test-token')
  deepEqual(service1Upload.body, Buffer.from(mockProfile))
})

test('sendFlamegraphs should handle missing profile data', async (t) => {
  setUpEnvironment()

  const app = createMockApp(port + 11)
  const errors = []

  app.log.error = (obj) => {
    errors.push(obj)
  }

  app.watt.runtime.sendCommandToApplication = async (serviceId, command) => {
    if (command === 'getLastProfile') {
      // Return invalid data (not Uint8Array)
      return null
    }
    return { success: false }
  }

  await flamegraphsPlugin(app)
  await app.sendFlamegraphs()

  equal(errors.length, 2, 'Should log errors for both services with missing profiles')
})

test('sendFlamegraphs should filter by workerIds when provided', async (t) => {
  setUpEnvironment()

  const app = createMockApp(port + 12)
  const getProfileCalls = []

  app.watt.runtime.sendCommandToApplication = async (workerId, command) => {
    if (command === 'getLastProfile') {
      getProfileCalls.push(workerId)
      return new Uint8Array([1, 2, 3])
    }
    return { success: false }
  }

  // Mock HTTP server
  const { createServer } = await import('node:http')
  const server = createServer((req, res) => {
    const body = []
    req.on('data', chunk => body.push(chunk))
    req.on('end', () => {
      res.writeHead(200)
      res.end()
    })
  })

  await new Promise(resolve => server.listen(port + 12, resolve))
  t.after(() => server.close())

  await flamegraphsPlugin(app)
  await app.sendFlamegraphs({ workerIds: ['service-1:0'] })

  equal(getProfileCalls.length, 1, 'Should only request profile for specified service')
  equal(getProfileCalls[0], 'service-1:0', 'Should request profile for service-1')
})

test('sendFlamegraphs should try to get the profile from a service if worker is not available', async (t) => {
  setUpEnvironment()

  const app = createMockApp(port + 12)
  const getProfileCalls = []

  app.watt.runtime.sendCommandToApplication = async (workerId, command) => {
    if (command === 'getLastProfile') {
      getProfileCalls.push(workerId)
      if (workerId === 'service-1:2') {
        throw new Error('Worker not available')
      }
      return new Uint8Array([1, 2, 3])
    }
    return { success: false }
  }

  // Mock HTTP server
  const { createServer } = await import('node:http')
  const server = createServer((req, res) => {
    const body = []
    req.on('data', chunk => body.push(chunk))
    req.on('end', () => {
      res.writeHead(200)
      res.end()
    })
  })

  await new Promise(resolve => server.listen(port + 12, resolve))
  t.after(() => server.close())

  await flamegraphsPlugin(app)
  await app.sendFlamegraphs({ workerIds: ['service-1:2'] })

  equal(getProfileCalls.length, 2)
  equal(getProfileCalls[0], 'service-1:2')
  equal(getProfileCalls[1], 'service-1')
})

test('sendFlamegraphs should skip when PLT_DISABLE_FLAMEGRAPHS is set', async (t) => {
  setUpEnvironment()

  const app = createMockApp(port + 13)
  app.env.PLT_DISABLE_FLAMEGRAPHS = true

  const getProfileCalls = []

  app.watt.runtime.sendCommandToApplication = async (workerId, command) => {
    if (command === 'getLastProfile') {
      getProfileCalls.push(workerId)
      return new Uint8Array([1, 2, 3])
    }
    return { success: false }
  }

  await flamegraphsPlugin(app)
  await app.sendFlamegraphs()

  equal(getProfileCalls.length, 0, 'Should not request profiles when disabled')
})

test('sendFlamegraphs should throw error when scaler URL is missing', async (t) => {
  setUpEnvironment()

  const app = createMockApp(port + 14, false) // Don't include scaler URL

  await flamegraphsPlugin(app)

  let errorThrown = false
  try {
    await app.sendFlamegraphs()
  } catch (err) {
    errorThrown = true
    ok(err.message.includes('No scaler URL'), 'Should throw error about missing scaler URL')
  }

  ok(errorThrown, 'Should throw error when scaler URL is missing')
})

test('should handle trigger-flamegraph command and upload flamegraphs from services', async (t) => {
  setUpEnvironment()

  const receivedMessages = []
  const getFlamegraphReqs = []
  let uploadResolve
  const allUploadsComplete = new Promise((resolve) => {
    uploadResolve = resolve
  })

  const wss = new WebSocketServer({ port: port + 15 })
  t.after(async () => wss.close())

  const { waitForClientSubscription, getWs } = setupMockIccServer(
    wss,
    receivedMessages,
    true
  )

  const app = createMockApp(port + 15)

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

  t.after(async () => {
    if (app.cleanupFlamegraphs) {
      app.cleanupFlamegraphs()
    }
    await app.closeUpdates()
  })

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
})

test('should handle trigger-flamegraph when no runtime is available', async (t) => {
  setUpEnvironment()

  const receivedMessages = []

  const wss = new WebSocketServer({ port: port + 16 })
  t.after(async () => wss.close())

  const { waitForClientSubscription, getWs } = setupMockIccServer(
    wss,
    receivedMessages,
    false
  )

  const app = createMockApp(port + 16)
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

  const wss = new WebSocketServer({ port: port + 17 })
  t.after(async () => wss.close())

  const { waitForClientSubscription, getWs } = setupMockIccServer(
    wss,
    receivedMessages,
    false
  )

  const app = createMockApp(port + 17)

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

  t.after(async () => {
    if (app.cleanupFlamegraphs) {
      app.cleanupFlamegraphs()
    }
    await app.closeUpdates()
  })

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
})

test('should handle PLT_PPROF_NO_PROFILE_AVAILABLE error with info log', async (t) => {
  setUpEnvironment()

  const receivedMessages = []
  const infoLogs = []

  const wss = new WebSocketServer({ port: port + 4 })
  t.after(async () => wss.close())

  const { waitForClientSubscription, getWs } = setupMockIccServer(
    wss,
    receivedMessages,
    true
  )

  const app = createMockApp(port + 4, true, {
    PLT_FLAMEGRAPHS_INTERVAL_SEC: 10,
    PLT_FLAMEGRAPHS_ATTEMPT_TIMEOUT: 1000
  })

  const originalInfo = app.log.info
  app.log.info = (...args) => {
    originalInfo(...args)
    infoLogs.push(args)
  }

  // Profile will be generated in 10s
  const profileGenerationDate = Date.now() + 10000
  const mockProfile = new Uint8Array([1, 2, 3, 4, 5])

  app.watt.runtime.sendCommandToApplication = async (
    serviceId,
    command
  ) => {
    if (command === 'startProfiling') {
      return { success: true }
    }
    if (command === 'getLastProfile') {
      const now = Date.now()
      if (now < profileGenerationDate) {
        const error = new Error('No profile available - wait for profiling to complete or trigger manual capture')
        error.code = 'PLT_PPROF_NO_PROFILE_AVAILABLE'
        throw error
      }
      return mockProfile
    }
    return { success: false }
  }

  await updatePlugin(app)
  await flamegraphsPlugin(app)

  await app.connectToUpdates()
  await app.setupFlamegraphs()

  t.after(async () => {
    if (app.cleanupFlamegraphs) {
      app.cleanupFlamegraphs()
    }
    await app.closeUpdates()
  })

  await waitForClientSubscription

  const triggerFlamegraphMessage = {
    command: 'trigger-flamegraph'
  }

  getWs().send(JSON.stringify(triggerFlamegraphMessage))

  await sleep(15000)

  const service1AttemptLogs = []
  const service2AttemptLogs = []
  const service1SuccessLogs = []
  const service2SuccessLogs = []

  for (const infoLog of infoLogs) {
    if (infoLog.length !== 2) continue
    const [options, message] = infoLog

    if (message.includes('No profile available for the service')) {
      const { workerId, attempt, maxAttempts, attemptTimeout } = options

      equal(maxAttempts, 11)
      equal(attemptTimeout, 1000)

      if (workerId === 'service-1') {
        service1AttemptLogs.push(infoLog)
        equal(attempt, service1AttemptLogs.length)
      }
      if (workerId === 'service-2') {
        service2AttemptLogs.push(infoLog)
        equal(attempt, service2AttemptLogs.length)
      }
      continue
    }

    if (message.includes('Sending flamegraph')) {
      if (options.serviceId === 'service-1') {
        service1SuccessLogs.push(infoLog)
      } else if (options.serviceId === 'service-2') {
        service2SuccessLogs.push(infoLog)
      }
    }
  }

  equal(service1AttemptLogs.length, 10)
  equal(service2AttemptLogs.length, 10)
  equal(service1SuccessLogs.length, 1)
  equal(service2SuccessLogs.length, 1)
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

  t.after(async () => {
    if (app.cleanupFlamegraphs) {
      app.cleanupFlamegraphs()
    }
    await app.closeUpdates()
  })

  await waitForClientSubscription

  const triggerFlamegraphMessage = {
    command: 'trigger-flamegraph'
  }

  getWs().send(JSON.stringify(triggerFlamegraphMessage))

  await allUploadsComplete

  equal(infoLogs.length, 2)
  equal(infoLogs[0][0].workerId, 'service-1')
  equal(infoLogs[0][1], 'ELU low, CPU profiling not active')
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

  t.after(async () => {
    if (app.cleanupFlamegraphs) {
      app.cleanupFlamegraphs()
    }
    await app.closeUpdates()
  })

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

  t.after(async () => {
    if (app.cleanupFlamegraphs) {
      app.cleanupFlamegraphs()
    }
    await app.closeUpdates()
  })

  await waitForClientSubscription

  equal(startProfilingCalls.length, 0)

  app.watt.runtime.emit('application:worker:started', {
    application: 'service-1',
    worker: 1,
    workersCount: 2
  })

  await sleep(10)

  equal(startProfilingCalls.length, 0)
})

test('sendFlamegraphs should include alertId in query params when provided', async (t) => {
  setUpEnvironment()

  const uploadedRequests = []

  const app = createMockApp(port + 18)

  app.watt.runtime.sendCommandToApplication = async (serviceId, command) => {
    if (command === 'getLastProfile') {
      return new Uint8Array([1, 2, 3])
    }
    return { success: false }
  }

  // Mock HTTP server to capture requests
  const { createServer } = await import('node:http')
  const server = createServer((req, res) => {
    const body = []
    req.on('data', chunk => body.push(chunk))
    req.on('end', () => {
      uploadedRequests.push({
        url: req.url,
        method: req.method
      })
      res.writeHead(200)
      res.end()
    })
  })

  await new Promise(resolve => server.listen(port + 18, resolve))
  t.after(() => server.close())

  await flamegraphsPlugin(app)
  await app.sendFlamegraphs({ alertId: 'test-alert-123' })

  equal(uploadedRequests.length, 2, 'Should upload flamegraphs for both services')

  for (const req of uploadedRequests) {
    ok(req.url.includes('alertId=test-alert-123'), 'URL should include alertId query param')
  }
})
