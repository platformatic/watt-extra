import { test } from 'node:test'
import assert from 'node:assert'
import { once } from 'node:events'
import { WebSocketServer } from 'ws'
import { setUpEnvironment } from './helper.js'
import { aggregateDrain, aggregatePromotion, durableObjectsPatch, isLavoratoreApplication, placesDurableObjects, refusedDurableObjects } from '../lib/durable-objects.js'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
})

test('Lavoratore applications are recognized by their type or by their configuration file', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'watt-extra-lavoratore-'))
  t.after(() => rm(dir, { recursive: true, force: true }))

  async function application (name, file, content) {
    const path = join(dir, name)
    await mkdir(path, { recursive: true })
    await writeFile(join(path, file), typeof content === 'string' ? content : JSON.stringify(content))
    return path
  }

  assert.strictEqual(await isLavoratoreApplication({ type: '@platformatic/lavoratore' }), true)
  assert.strictEqual(await isLavoratoreApplication({ type: 'lavoratore' }), true)
  assert.strictEqual(await isLavoratoreApplication({ type: '@platformatic/service' }), false)
  assert.strictEqual(await isLavoratoreApplication(undefined), false)

  // The runtime configuration says "unknown" for an application whose capability is resolved when it starts
  const byModule = await application('module', 'watt.json', { module: '@platformatic/lavoratore' })
  const bySchema = await application('schema', 'platformatic.json', { $schema: 'https://schemas.platformatic.dev/@platformatic/lavoratore/0.6.0.json' })
  const sibling = await application('sibling', 'watt.json', { $schema: 'https://schemas.platformatic.dev/@platformatic/lavoratore-caposquadra/0.6.0.json', module: '@platformatic/lavoratore-caposquadra' })
  const broken = await application('broken', 'watt.json', '{ not json')

  assert.strictEqual(await isLavoratoreApplication({ type: 'unknown', path: byModule }), true)
  assert.strictEqual(await isLavoratoreApplication({ type: 'unknown', path: bySchema }), true)
  assert.strictEqual(await isLavoratoreApplication({ type: 'unknown', config: join(byModule, 'watt.json') }), true)
  assert.strictEqual(await isLavoratoreApplication({ type: 'unknown', path: sibling }), false)
  assert.strictEqual(await isLavoratoreApplication({ type: 'unknown', path: broken }), false)
  assert.strictEqual(await isLavoratoreApplication({ type: 'unknown', path: join(dir, 'missing') }), false)

  // The placement is read from the same file
  const placed = await application('placed', 'watt.json', { module: '@platformatic/lavoratore', lavoratore: { durableObjects: { placement: { type: 'coordinator' } } } })
  assert.strictEqual(await placesDurableObjects({ path: placed }), true)
  assert.strictEqual(await placesDurableObjects({ path: byModule }), false)
})

test('only a refusal of ICC which names Durable Objects stages the pod', () => {
  const body = { statusCode: 409, code: 'PLT_CONTROL_PLANE_VERSION_DEPLOYMENT_MISMATCH', error: 'Conflict', message: 'refused' }

  assert.deepStrictEqual(refusedDurableObjects(new Error(JSON.stringify({ ...body, durableObjects: { staged: true } }))), { durableObjects: { staged: true } })
  assert.deepStrictEqual(durableObjectsPatch(refusedDurableObjects(new Error(JSON.stringify({ ...body, durableObjects: { staged: true } })))), [
    { op: 'merge', path: '/lavoratore/durableObjects/placement', value: { promoted: false } }
  ])

  // An ICC which knows nothing of Durable Objects, one which fails, and one which cannot be reached
  assert.strictEqual(refusedDurableObjects(new Error(JSON.stringify(body))), null)
  assert.strictEqual(refusedDurableObjects(new Error(JSON.stringify({ ...body, statusCode: 503, durableObjects: { staged: true } }))), null)
  assert.strictEqual(refusedDurableObjects(new Error(JSON.stringify({ ...body, durableObjects: 'yes' }))), null)
  assert.strictEqual(refusedDurableObjects(new Error('connect ECONNREFUSED 127.0.0.1:3000')), null)
  assert.strictEqual(refusedDurableObjects(new Error('null')), null)
  assert.strictEqual(refusedDurableObjects(undefined), null)
})

test('the answers of the applications are aggregated', () => {
  assert.deepStrictEqual(aggregatePromotion({ a: { promoted: true }, b: { promoted: true } }), { promoted: true, applications: { a: { promoted: true }, b: { promoted: true } } })
  assert.strictEqual(aggregatePromotion({ a: { promoted: true }, b: { promoted: false, status: 'duplicate' } }).promoted, false)
  // An application which places nothing across pods has nothing to promote
  assert.strictEqual(aggregatePromotion({ a: { promoted: true }, b: { promoted: false, status: 'unsupported' } }).promoted, true)
  assert.strictEqual(aggregatePromotion({ b: { promoted: false, status: 'unsupported' } }).promoted, true)
  // Nothing to promote or drain
  assert.strictEqual(aggregatePromotion({}).promoted, true)
  assert.strictEqual(aggregateDrain({}).status, 'drained')
  assert.strictEqual(aggregateDrain({ a: { status: 'unsupported' }, b: { status: 'drained' } }).status, 'drained')
  assert.strictEqual(aggregateDrain({ a: { status: 'waiting' }, b: { status: 'drained' } }).status, 'draining')
  assert.strictEqual(aggregateDrain({ a: { status: 'superseded' }, b: { status: 'drained' } }).status, 'partial')

  assert.strictEqual(aggregateDrain({ a: { status: 'drained' }, b: { status: 'drained' } }).status, 'drained')
  assert.strictEqual(aggregateDrain({ a: { status: 'drained' }, b: { status: 'draining' } }).status, 'draining')
  assert.strictEqual(aggregateDrain({ a: { status: 'partial' }, b: { status: 'draining' } }).status, 'draining')
  assert.strictEqual(aggregateDrain({ a: { status: 'drained' }, b: { status: 'blocked' } }).status, 'blocked')
  assert.strictEqual(aggregateDrain({ a: { status: 'blocked' }, b: { status: 'partial' } }).status, 'partial')
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

test('applications without the handler are skipped, failures are reported with the other answers, and repeated commands join', async () => {
  // The runtime answers {} when the application has no handler: a plain Worker, or an older Lavoratore
  const mixed = createMockRuntime([{ id: 'front', type: '@platformatic/lavoratore' }, { id: 'objects', type: '@platformatic/lavoratore' }], {
    objects: { status: 'drained', moved: 1 }
  })
  assert.deepStrictEqual(await (await createApp(mixed)).sendDurableObjectsCommand('durable-objects-drain', { wait: false }), {
    status: 'drained', applications: { objects: { status: 'drained', moved: 1 } }, skipped: ['front']
  })

  const plain = await createApp(createMockRuntime([{ id: 'front', type: '@platformatic/lavoratore' }]))
  assert.deepStrictEqual(await plain.sendDurableObjectsCommand('durable-objects-promote', { generation: 1 }), { promoted: true, applications: {}, skipped: ['front'] })
  assert.deepStrictEqual(await plain.sendDurableObjectsCommand('durable-objects-drain'), { status: 'drained', applications: {}, skipped: ['front'] })

  // ICC asks only the pods it knows to run Lavoratore: finding none is a failure, never an answer it takes for done
  const none = await createApp(createMockRuntime([{ id: 'api', type: '@platformatic/service' }]))
  await assert.rejects(none.sendDurableObjectsCommand('durable-objects-drain'), /No Lavoratore application found/)
  await assert.rejects(none.sendDurableObjectsCommand('durable-objects-promote', { generation: 1 }), /No Lavoratore application found/)

  // One application fails: the other is still asked, and the error carries its answer
  const failing = createMockRuntime([{ id: 'a', type: '@platformatic/lavoratore' }, { id: 'b', type: '@platformatic/lavoratore' }], {
    a: () => { throw new Error('boom') },
    b: { promoted: true, status: 'applied' }
  })
  await assert.rejects((await createApp(failing)).sendDurableObjectsCommand('durable-objects-promote', { generation: 2 }), err => {
    assert.match(err.message, /durable-objects-promote command failed in the applications a: boom/)
    assert.deepStrictEqual(err.results, { b: { promoted: true, status: 'applied' } })
    return true
  })
  assert.strictEqual(failing.commands.length, 2)

  // The same command repeated while it runs joins it; another generation does not
  let release
  const slow = createMockRuntime([{ id: 'objects', type: '@platformatic/lavoratore' }], {
    objects: () => new Promise(resolve => { release = () => resolve({ promoted: true }) })
  })
  const app = await createApp(slow)
  const first = app.sendDurableObjectsCommand('durable-objects-promote', { generation: 3 })
  const second = app.sendDurableObjectsCommand('durable-objects-promote', { generation: 3 })
  await new Promise(resolve => setImmediate(resolve))
  assert.strictEqual(slow.commands.length, 1)
  release()
  assert.deepStrictEqual(await first, await second)
  const third = app.sendDurableObjectsCommand('durable-objects-promote', { generation: 3 })
  await new Promise(resolve => setImmediate(resolve))
  assert.strictEqual(slow.commands.length, 2)
  release()
  await third

  await assert.rejects(app.sendDurableObjectsCommand('durable-objects-restart'), /Unknown Durable Objects command/)

  const stopped = { log: logger, watt: { runtime: null } }
  await durableObjectsPlugin(stopped)
  await assert.rejects(stopped.sendDurableObjectsCommand('durable-objects-drain'), /Runtime not started/)
})

test('the patch applies only to the applications which place Durable Objects', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'watt-extra-do-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const write = async (name, content) => {
    const path = join(dir, name)
    await writeFile(path, typeof content === 'string' ? content : JSON.stringify(content))
    return { config: path }
  }

  assert.strictEqual(await placesDurableObjects(await write('placed.json', { lavoratore: { durableObjects: { placement: { type: 'coordinator' } } } })), true)
  assert.strictEqual(await placesDurableObjects(await write('local.json', { lavoratore: { durableObjects: {} } })), false)
  assert.strictEqual(await placesDurableObjects(await write('plain.json', { lavoratore: {} })), false)
  // A configuration which cannot be read gets the patch
  assert.strictEqual(await placesDurableObjects(await write('broken.json', '{ not json')), true)
  assert.strictEqual(await placesDurableObjects({ config: join(dir, 'missing.json') }), true)
  assert.strictEqual(await placesDurableObjects({}), true)
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

  // A promotion which did not promote the pod says so in its result: the frame stays valid for ICC, which reads it
  const superseded = await reply(getWs(), { command: 'durable-objects-promote', requestId: 'promote-2', params: { generation: 7 } })
  assert.strictEqual(superseded.success, true)
  assert.strictEqual(superseded.result.promoted, false)
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
