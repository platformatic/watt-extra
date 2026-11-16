import { test } from 'node:test'
import assert from 'node:assert'
import { once } from 'node:events'
import { WebSocketServer } from 'ws'
import { setUpEnvironment } from './helper.js'
import { aggregateDrain, aggregatePromotion, durableObjectsPatch, isLavoratoreApplication } from '../lib/durable-objects.js'
import durableObjectsPlugin from '../plugins/durable-objects.js'
import updatePlugin from '../plugins/update.js'

const logger = { info () {}, error () {}, warn () {}, debug () {} }

function createMockRuntime (applications, results = {}) {
  const commands = []

  return {
    commands,
    getRuntimeConfig () {
      return { applications }
    },
    async sendCommandToApplication (id, name, params) {
      commands.push({ id, name, params })
      const result = results[id]
      return typeof result === 'function' ? result() : result ?? {}
    }
  }
}

async function createApp (runtime) {
  const app = { log: logger, watt: { runtime } }
  await durableObjectsPlugin(app)
  return app
}

test('the patch of a Lavoratore application follows what ICC says about Durable Objects', () => {
  // An ICC which knows nothing of Durable Objects changes nothing
  assert.strictEqual(durableObjectsPatch(null), null)
  assert.strictEqual(durableObjectsPatch({ applicationId: 'app' }), null)
  assert.strictEqual(durableObjectsPatch({ durableObjects: 'yes' }), null)

  // A staged version receives no objects until ICC promotes it
  assert.deepStrictEqual(durableObjectsPatch({ durableObjects: { staged: true } }), [
    { op: 'merge', path: '/lavoratore/durableObjects/placement', value: { promoted: false } }
  ])
  assert.deepStrictEqual(durableObjectsPatch({ durableObjects: { staged: false } }), [
    { op: 'merge', path: '/lavoratore/durableObjects/placement', value: { promoted: true } }
  ])
  assert.deepStrictEqual(durableObjectsPatch({ durableObjects: {} })[0].value, { promoted: true })

  assert.strictEqual(isLavoratoreApplication({ type: '@platformatic/lavoratore' }), true)
  assert.strictEqual(isLavoratoreApplication({ type: 'lavoratore' }), true)
  assert.strictEqual(isLavoratoreApplication({ type: '@platformatic/service' }), false)
  assert.strictEqual(isLavoratoreApplication(undefined), false)
})

test('the answers of the applications are aggregated', () => {
  assert.deepStrictEqual(aggregatePromotion({ a: { promoted: true }, b: { promoted: true } }), { promoted: true, applications: { a: { promoted: true }, b: { promoted: true } } })
  assert.strictEqual(aggregatePromotion({ a: { promoted: true }, b: { promoted: false, status: 'duplicate' } }).promoted, false)
  assert.strictEqual(aggregatePromotion({}).promoted, false)

  assert.strictEqual(aggregateDrain({ a: { status: 'drained' }, b: { status: 'drained' } }).status, 'drained')
  assert.strictEqual(aggregateDrain({ a: { status: 'drained' }, b: { status: 'draining' } }).status, 'draining')
  assert.strictEqual(aggregateDrain({ a: { status: 'partial' }, b: { status: 'draining' } }).status, 'draining')
  assert.strictEqual(aggregateDrain({ a: { status: 'drained' }, b: { status: 'blocked' } }).status, 'blocked')
  assert.strictEqual(aggregateDrain({ a: { status: 'blocked' }, b: { status: 'partial' } }).status, 'partial')
  assert.strictEqual(aggregateDrain({}).status, 'partial')
})

test('the commands are forwarded to every Lavoratore application of the runtime', async () => {
  const applications = [
    { id: 'front', type: '@platformatic/service' },
    { id: 'objects', type: '@platformatic/lavoratore' },
    { id: 'legacy', type: 'lavoratore' }
  ]
  const runtime = createMockRuntime(applications, {
    objects: { promoted: true, status: 'applied', generation: 3, admission: 2 },
    legacy: { promoted: true, status: 'duplicate', generation: 3, admission: 1 }
  })
  const app = await createApp(runtime)

  const promotion = await app.sendDurableObjectsCommand('durable-objects-promote', { generation: 3 })
  assert.strictEqual(promotion.promoted, true)
  assert.deepStrictEqual(Object.keys(promotion.applications), ['objects', 'legacy'])
  assert.deepStrictEqual(runtime.commands, [
    { id: 'objects', name: 'plt:lavoratore:promote', params: { generation: 3 } },
    { id: 'legacy', name: 'plt:lavoratore:promote', params: { generation: 3 } }
  ])

  const draining = createMockRuntime(applications, {
    objects: { status: 'drained', moved: 2 },
    legacy: { status: 'blocked', blocked: 1 }
  })
  const drain = await (await createApp(draining)).sendDurableObjectsCommand('durable-objects-drain')
  assert.strictEqual(drain.status, 'blocked')
  assert.deepStrictEqual(drain.applications.objects, { status: 'drained', moved: 2 })
  assert.deepStrictEqual(draining.commands.map(command => command.name), ['plt:lavoratore:drain', 'plt:lavoratore:drain'])
})

test('a pod without Durable Objects, an application without the handler and an unknown command are errors', async () => {
  const none = await createApp(createMockRuntime([{ id: 'front', type: '@platformatic/service' }]))
  await assert.rejects(none.sendDurableObjectsCommand('durable-objects-drain'), /no Durable Objects application/)

  // The runtime answers {} when the application has no handler, i.e. an older version of Lavoratore
  const older = await createApp(createMockRuntime([{ id: 'objects', type: '@platformatic/lavoratore' }]))
  await assert.rejects(older.sendDurableObjectsCommand('durable-objects-promote', { generation: 1 }), /does not handle the durable-objects-promote command/)

  const app = await createApp(createMockRuntime([{ id: 'objects', type: '@platformatic/lavoratore' }], { objects: { status: 'drained' } }))
  await assert.rejects(app.sendDurableObjectsCommand('durable-objects-restart'), /Unknown Durable Objects command/)

  const stopped = { log: logger, watt: { runtime: null } }
  await durableObjectsPlugin(stopped)
  await assert.rejects(stopped.sendDurableObjectsCommand('durable-objects-drain'), /Runtime not started/)
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

async function reply (ws, frame) {
  ws.send(JSON.stringify(frame))
  return JSON.parse((await once(ws, 'message'))[0].toString())
}

test('the Durable Objects commands of ICC are answered over the websocket with their result', async (t) => {
  setUpEnvironment()
  const port = 14300
  const wss = new WebSocketServer({ port })
  t.after(() => wss.close())
  const { waitForClientSubscription, getWs } = setupMockIccServer(wss)

  const received = []
  const app = {
    log: logger,
    instanceConfig: { applicationId: 'test-application-id' },
    getAuthorizationHeaders: async () => ({ Authorization: 'Bearer test-token' }),
    getRuntimeId: () => 'test-runtime-id',
    env: { PLT_APP_NAME: 'test-app', PLT_APP_DIR: '/path/to/app', PLT_ICC_URL: `http://localhost:${port}`, PLT_UPDATES_RECONNECT_INTERVAL_SEC: 1 },
    async sendDurableObjectsCommand (command, params) {
      received.push({ command, params })

      if (params.generation === 7) {
        return { promoted: false, applications: { objects: { promoted: false, status: 'superseded', generation: 7, admission: null } } }
      }

      if (params.generation === 8) {
        throw new Error('The application "objects" does not handle the durable-objects-promote command')
      }

      return command === 'durable-objects-promote'
        ? { promoted: true, applications: { objects: { promoted: true, status: 'applied', generation: params.generation, admission: 1 } } }
        : { status: 'drained', applications: { objects: { status: 'drained', moved: 3 } } }
    }
  }

  await updatePlugin(app)
  await app.connectToUpdates()
  t.after(() => app.closeUpdates())
  await waitForClientSubscription

  assert.deepStrictEqual(await reply(getWs(), { command: 'durable-objects-promote', requestId: 'promote-1', params: { generation: 2 } }), {
    requestId: 'promote-1',
    success: true,
    result: { promoted: true, applications: { objects: { promoted: true, status: 'applied', generation: 2, admission: 1 } } }
  })

  // A promotion which did not promote the pod is not acknowledged as done
  const superseded = await reply(getWs(), { command: 'durable-objects-promote', requestId: 'promote-2', params: { generation: 7 } })
  assert.strictEqual(superseded.success, false)
  assert.strictEqual(superseded.result.applications.objects.status, 'superseded')

  const failed = await reply(getWs(), { command: 'durable-objects-promote', requestId: 'promote-3', params: { generation: 8 } })
  assert.deepStrictEqual(failed, { requestId: 'promote-3', success: false, error: { message: 'The application "objects" does not handle the durable-objects-promote command', name: 'Error' } })

  assert.deepStrictEqual(await reply(getWs(), { command: 'durable-objects-drain', requestId: 'drain-1' }), {
    requestId: 'drain-1',
    success: true,
    result: { status: 'drained', applications: { objects: { status: 'drained', moved: 3 } } }
  })

  assert.deepStrictEqual(received, [
    { command: 'durable-objects-promote', params: { generation: 2 } },
    { command: 'durable-objects-promote', params: { generation: 7 } },
    { command: 'durable-objects-promote', params: { generation: 8 } },
    { command: 'durable-objects-drain', params: {} }
  ])
})
