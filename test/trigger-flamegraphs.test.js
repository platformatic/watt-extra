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

  const createLogger = () => ({
    info: () => {},
    error: () => {},
    warn: () => {},
    debug: () => {},
    child: () => createLogger()
  })

  const app = {
    log: createLogger(),
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
      PLT_FLAMEGRAPHS_GRACE_PERIOD: 0,
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

  // Mock getApplicationDetails to return config with sourceMaps per service
  app.watt.runtime.getApplicationDetails = async (serviceId) => {
    if (serviceId === 'service-1') {
      return { id: serviceId, sourceMaps: true }
    } else if (serviceId === 'service-2') {
      return { id: serviceId, sourceMaps: false }
    }
    return { id: serviceId, sourceMaps: false }
  }

  app.watt.runtime.sendCommandToApplication = async (workerId, command, options) => {
    if (command === 'startProfiling') {
      startProfilingCalls.push({ workerId, command, options })
      return { success: true }
    }
    return { success: false }
  }

  await flamegraphsPlugin(app)
  await app.setupFlamegraphs()

  t.after(async () => {
    await app.cleanupFlamegraphs()
  })

  // Trigger profiling for both CPU and heap profiles
  await app.requestFlamegraphs({ profileType: 'cpu' })
  await app.requestFlamegraphs({ profileType: 'heap' })

  // Wait for profiling to start
  await sleep(100)

  // Should call startProfiling 4 times: 2 services × 2 profile types (cpu + heap)
  equal(startProfilingCalls.length, 4, 'Should call startProfiling for both services with cpu and heap')

  const service1CpuCall = startProfilingCalls.find(c => c.workerId === 'service-1:0' && c.options.type === 'cpu')
  const service1HeapCall = startProfilingCalls.find(c => c.workerId === 'service-1:0' && c.options.type === 'heap')
  const service2CpuCall = startProfilingCalls.find(c => c.workerId === 'service-2:0' && c.options.type === 'cpu')
  const service2HeapCall = startProfilingCalls.find(c => c.workerId === 'service-2:0' && c.options.type === 'heap')

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
  app.watt.runtime.getApplicationDetails = async (serviceId) => {
    return { id: serviceId }
  }

  app.watt.runtime.sendCommandToApplication = async (workerId, command, options) => {
    if (command === 'startProfiling') {
      startProfilingCalls.push({ workerId, command, options })
      return { success: true }
    }
    return { success: false }
  }

  await flamegraphsPlugin(app)
  await app.setupFlamegraphs()

  t.after(async () => {
    await app.cleanupFlamegraphs()
  })

  // Trigger profiling for both CPU and heap profiles
  await app.requestFlamegraphs({ profileType: 'cpu' })
  await app.requestFlamegraphs({ profileType: 'heap' })

  // Wait for profiling to start
  await sleep(100)

  equal(startProfilingCalls.length, 4, 'Should call startProfiling for both services with cpu and heap')

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

  app.watt.runtime.sendCommandToApplication = async (workerId, command, options) => {
    if (command === 'startProfiling') {
      startProfilingCalls.push({ workerId, command, options })
      return { success: true }
    }
    return { success: false }
  }

  await flamegraphsPlugin(app)
  await app.setupFlamegraphs()

  // Also try to send flamegraphs
  await app.requestFlamegraphs()

  // Wait to ensure no profiling starts
  await sleep(100)

  equal(startProfilingCalls.length, 0, 'Should not call startProfiling when disabled')
})

test('requestFlamegraphs should handle errors when starting profiling', async (t) => {
  setUpEnvironment()

  const app = createMockApp(port)
  const errors = []

  app.log.error = (result) => {
    errors.push(result)
  }

  app.watt.runtime.getApplicationDetails = async (serviceId) => {
    return { id: serviceId, sourceMaps: true }
  }

  app.watt.runtime.sendCommandToApplication = async (workerId, command, options) => {
    if (command === 'startProfiling') {
      throw new Error(`Failed to start profiling for ${workerId}`)
    }
    return { success: false }
  }

  await flamegraphsPlugin(app)
  await app.setupFlamegraphs()

  t.after(async () => {
    await app.cleanupFlamegraphs()
  })

  // Trigger profiling which will fail
  await app.requestFlamegraphs()

  // Wait for errors to be logged
  await sleep(100)

  // Should log 2 errors (1 per service in Profiler)
  equal(errors.length, 2, 'Should log errors for both failed services')
})

test('requestFlamegraphs should upload flamegraphs from all services', async (t) => {
  setUpEnvironment()

  const uploadedFlamegraphs = []
  const httpPort = port + 100

  const app = createMockApp(httpPort)

  const mockProfile = new Uint8Array([1, 2, 3, 4, 5])

  app.watt.runtime.sendCommandToApplication = async (workerId, command, options) => {
    if (command === 'startProfiling') {
      return { success: true }
    }
    if (command === 'getProfilingState') {
      return { latestProfileTimestamp: Date.now() }
    }
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
      res.end(JSON.stringify({ id: 'flamegraph-id' }))
    })
  })

  await new Promise(resolve => server.listen(httpPort, resolve))
  t.after(() => server.close())

  await flamegraphsPlugin(app)
  await app.setupFlamegraphs()

  t.after(async () => {
    await app.cleanupFlamegraphs()
  })

  // Trigger profiling
  await app.requestFlamegraphs()

  // Wait for profile to be generated (duration is 1 second)
  await sleep(1500)

  equal(uploadedFlamegraphs.length, 2, 'Should upload flamegraphs for both services')

  const service1Upload = uploadedFlamegraphs.find(u => u.url.includes('service-1'))
  const service2Upload = uploadedFlamegraphs.find(u => u.url.includes('service-2'))

  ok(service1Upload, 'Should upload flamegraph for service-1')
  ok(service2Upload, 'Should upload flamegraph for service-2')

  equal(service1Upload.headers['content-type'], 'application/octet-stream')
  equal(service1Upload.headers.authorization, 'Bearer test-token')
  deepEqual(service1Upload.body, Buffer.from(mockProfile))
})

test('requestFlamegraphs should handle missing profile data', async (t) => {
  setUpEnvironment()

  const app = createMockApp(port + 11)
  const errors = []

  app.log.error = (obj) => {
    errors.push(obj)
  }

  app.watt.runtime.sendCommandToApplication = async (workerId, command) => {
    if (command === 'startProfiling') {
      return { success: true }
    }
    if (command === 'getProfilingState') {
      return { latestProfileTimestamp: Date.now() }
    }
    if (command === 'getLastProfile') {
      // Return invalid data (not Uint8Array)
      return null
    }
    return { success: false }
  }

  await flamegraphsPlugin(app)
  await app.setupFlamegraphs()

  t.after(async () => {
    await app.cleanupFlamegraphs()
  })

  // Trigger profiling
  await app.requestFlamegraphs()

  // Wait for profile to be generated (duration is 1 second)
  await sleep(1500)

  equal(errors.length, 2, 'Should log errors for both services with missing profiles')
})

test('requestFlamegraphs should filter by serviceIds when provided', async (t) => {
  setUpEnvironment()

  const app = createMockApp(port + 12)
  const getProfileCalls = []

  app.watt.runtime.sendCommandToApplication = async (workerId, command) => {
    if (command === 'startProfiling') {
      return { success: true }
    }
    if (command === 'getProfilingState') {
      return { latestProfileTimestamp: Date.now() }
    }
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
      res.end(JSON.stringify({ id: 'flamegraph-id' }))
    })
  })

  await new Promise(resolve => server.listen(port + 12, resolve))
  t.after(() => server.close())

  await flamegraphsPlugin(app)
  await app.setupFlamegraphs()

  t.after(async () => {
    await app.cleanupFlamegraphs()
  })

  // Trigger profiling for specific worker
  await app.requestFlamegraphs({ serviceIds: ['service-1'] })

  // Wait for profile to be generated (duration is 1 second)
  await sleep(1500)

  equal(getProfileCalls.length, 1, 'Should only request profile for specified service')
  equal(getProfileCalls[0], 'service-1:0', 'Should request profile for service-1')
})

test('requestFlamegraphs should skip when PLT_DISABLE_FLAMEGRAPHS is set', async (t) => {
  setUpEnvironment()

  const app = createMockApp(port + 13)
  app.env.PLT_DISABLE_FLAMEGRAPHS = true

  const getProfileCalls = []

  app.watt.runtime.sendCommandToApplication = async (workerId, command) => {
    if (command === 'startProfiling') {
      return { success: true }
    }
    if (command === 'getLastProfile') {
      getProfileCalls.push(workerId)
      return new Uint8Array([1, 2, 3])
    }
    return { success: false }
  }

  await flamegraphsPlugin(app)
  await app.requestFlamegraphs()

  // Wait to ensure no profiling starts
  await sleep(100)

  equal(getProfileCalls.length, 0, 'Should not request profiles when disabled')
})

test('requestFlamegraphs should throw error when scaler URL is missing', async (t) => {
  setUpEnvironment()

  const app = createMockApp(port + 14, false) // Don't include scaler URL

  await flamegraphsPlugin(app)

  let errorThrown = false
  try {
    await app.requestFlamegraphs()
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
  t.after(() => wss.close())

  const { waitForClientSubscription, getWs } = setupMockIccServer(
    wss,
    receivedMessages,
    true
  )

  const app = createMockApp(port + 15)

  app.watt.runtime.sendCommandToApplication = async (
    workerId,
    command
  ) => {
    if (command === 'startProfiling') {
      return { success: true }
    }
    if (command === 'getProfilingState') {
      return { latestProfileTimestamp: Date.now() }
    }
    if (command === 'getLastProfile') {
      getFlamegraphReqs.push({ serviceId: workerId })
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
      await app.cleanupFlamegraphs()
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
    (f) => f.serviceId === 'service-1:0'
  )
  const service2Req = getFlamegraphReqs.find(
    (f) => f.serviceId === 'service-2:0'
  )

  equal(service1Req.serviceId, 'service-1:0')
  equal(service2Req.serviceId, 'service-2:0')
})

test('should handle trigger-flamegraph when no runtime is available', async (t) => {
  setUpEnvironment()

  const receivedMessages = []

  const wss = new WebSocketServer({ port: port + 16 })
  t.after(() => wss.close())

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
  t.after(() => wss.close())

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

  const wss = new WebSocketServer({ port: port + 18 })
  t.after(() => wss.close())

  const { waitForClientSubscription, getWs } = setupMockIccServer(
    wss,
    receivedMessages,
    true
  )

  const app = createMockApp(port + 18)

  app.watt.runtime.sendCommandToApplication = async (
    workerId,
    command,
    options
  ) => {
    if (options && options.type) {
      equal(options.type, 'heap')
    }
    if (command === 'startProfiling') {
      return { success: true }
    }
    if (command === 'getProfilingState') {
      return { latestProfileTimestamp: Date.now() }
    }
    if (command === 'getLastProfile') {
      getHeapProfileReqs.push({ serviceId: workerId })
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
      await app.cleanupFlamegraphs()
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
    (f) => f.serviceId === 'service-1:0'
  )
  const service2Req = getHeapProfileReqs.find(
    (f) => f.serviceId === 'service-2:0'
  )

  equal(service1Req.serviceId, 'service-1:0')
  equal(service2Req.serviceId, 'service-2:0')
})

test('requestFlamegraphs should include alertId in query params when provided', async (t) => {
  setUpEnvironment()

  const uploadedRequests = []

  const app = createMockApp(port + 19)

  app.watt.runtime.sendCommandToApplication = async (workerId, command) => {
    if (command === 'startProfiling') {
      return { success: true }
    }
    if (command === 'getProfilingState') {
      return { latestProfileTimestamp: Date.now() }
    }
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
      res.end(JSON.stringify({ id: 'flamegraph-id' }))
    })
  })

  await new Promise(resolve => server.listen(port + 19, resolve))
  t.after(() => server.close())

  await flamegraphsPlugin(app)
  await app.setupFlamegraphs()

  t.after(async () => {
    await app.cleanupFlamegraphs()
  })

  // Trigger profiling with alertId
  await app.requestFlamegraphs({ alertId: 'test-alert-123' })

  // Wait for profile to be generated (duration is 1 second)
  await sleep(1500)

  equal(uploadedRequests.length, 2, 'Should upload flamegraphs for both services')

  for (const req of uploadedRequests) {
    ok(req.url.includes('alertId=test-alert-123'), 'URL should include alertId query param')
  }
})

test('requestFlamegraphs should failover to worker 1 when worker 0 crashes', async (t) => {
  setUpEnvironment()

  const uploadedFlamegraphs = []
  const startProfilingCalls = []
  const httpPort = port + 20

  const app = createMockApp(httpPort)

  // Track which workers are available
  let availableWorkers = {
    'service-1:0': { application: 'service-1', worker: 0, status: 'started' },
    'service-1:1': { application: 'service-1', worker: 1, status: 'started' }
  }

  // Update getWorkers to return dynamic worker list
  app.watt.runtime.getWorkers = async () => availableWorkers

  // Update getApplications to return only service-1
  app.watt.runtime.getApplications = async () => ({
    applications: [{ id: 'service-1' }]
  })

  const mockProfile = new Uint8Array([1, 2, 3, 4, 5])

  app.watt.runtime.sendCommandToApplication = async (workerId, command, options) => {
    if (command === 'startProfiling') {
      startProfilingCalls.push({ workerId, options })
      return { success: true }
    }
    if (command === 'getProfilingState') {
      return { latestProfileTimestamp: Date.now() }
    }
    if (command === 'getLastProfile') {
      return mockProfile
    }
    if (command === 'stopProfiling') {
      return { success: true }
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
        workerId: req.url.includes('service-1') ? 'service-1' : 'unknown',
        body: buffer
      })
      res.writeHead(200)
      res.end(JSON.stringify({ id: 'flamegraph-id' }))
    })
  })

  await new Promise(resolve => server.listen(httpPort, resolve))
  t.after(() => server.close())

  await flamegraphsPlugin(app)
  await app.setupFlamegraphs()

  t.after(async () => {
    await app.cleanupFlamegraphs()
  })

  // First request: should start profiling on worker 0 (index 0 of workers array)
  await app.requestFlamegraphs({ serviceIds: ['service-1'] })

  // Wait for profile to be generated (duration is 1 second)
  await sleep(1500)

  equal(startProfilingCalls.length, 1, 'Should have started profiling once')
  equal(startProfilingCalls[0].workerId, 'service-1:0', 'Should have started profiling on worker 0')
  equal(uploadedFlamegraphs.length, 1, 'Should have uploaded first flamegraph')

  // Simulate worker 0 crashing - remove it from available workers
  availableWorkers = {
    'service-1:1': { application: 'service-1', worker: 1, status: 'started' }
  }

  // Second request: should detect worker 0 is gone and start profiling on worker 1 (now at index 0)
  await app.requestFlamegraphs({ serviceIds: ['service-1'] })

  // Wait for profile to be generated
  await sleep(1500)

  equal(startProfilingCalls.length, 2, 'Should have started profiling twice')
  equal(startProfilingCalls[1].workerId, 'service-1:1', 'Should have started profiling on worker 1')
  equal(uploadedFlamegraphs.length, 2, 'Should have uploaded second flamegraph')
})
