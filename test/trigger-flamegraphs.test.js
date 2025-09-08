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
  const mockWatt = {
    runtime: {
      getApplications: () => ({
        applications: [{ id: 'service-1' }, { id: 'service-2' }],
      }),
    },
  }

  const app = {
    log: {
      info: () => {},
      error: () => {},
      warn: () => {},
      debug: () => {},
    },
    instanceConfig: {
      applicationId: 'test-application-id',
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
      PLT_FLAMEGRAPHS_INTERVAL_SEC: 1
    },
    watt: mockWatt,
  }

  if (includeScalerUrl) {
    app.instanceConfig.iccServices = {
      scaler: {
        url: `http://localhost:${port}/scaler`,
      },
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
    if (command === 'getLastProfile') {
      getFlamegraphReqs.push({ serviceId })
      if (getFlamegraphReqs.length === 2) {
        uploadResolve()
      }
      return { success: true }
    }
    return { success: false }
  }

  await updatePlugin(app)
  await flamegraphsPlugin(app)

  await app.connectToUpdates()
  await app.setupFlamegraphs()

  await waitForClientSubscription

  const triggerFlamegraphMessage = {
    command: 'trigger-flamegraph',
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
    command: 'trigger-flamegraph',
  }

  getWs().send(JSON.stringify(triggerFlamegraphMessage))

  await sleep(100)

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
    command: 'trigger-flamegraph',
  }

  getWs().send(JSON.stringify(triggerFlamegraphMessage))

  await sleep(100)

  await app.closeUpdates()
})
