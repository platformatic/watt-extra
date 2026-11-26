import { test } from 'node:test'
import assert from 'node:assert'
import { once } from 'node:events'
import { setTimeout as sleep } from 'node:timers/promises'
import { WebSocketServer } from 'ws'
import { setUpEnvironment } from './helper.js'
import { CAPABILITIES, contextOf, refusedContext } from '../lib/application-commands.js'
import applicationCommandsPlugin from '../plugins/application-commands.js'
import updatePlugin from '../plugins/update.js'

const logger = { info () {}, error () {}, warn () {}, debug () {} }

function createMockRuntime (ids, results = {}, types = {}) {
  const commands = []

  return {
    commands,
    details: 0,
    getRuntimeConfig () {
      return { applications: ids.map(id => ({ id })) }
    },
    async getApplicationDetails (id) {
      this.details++

      if (types[id] === 'broken') {
        throw new Error('The application does not answer')
      }

      return { id, type: types[id] ?? 'node' }
    },
    async sendCommandToApplication (id, name, params) {
      commands.push({ id, name, params })
      const result = results[id]
      return typeof result === 'function' ? result(params) : result === undefined ? {} : result
    }
  }
}

async function createApp (runtime) {
  const app = { log: logger, watt: { runtime } }
  await applicationCommandsPlugin(app)
  return app
}

test('the context is an object ICC gives with the configuration of the instance, or with its refusal', () => {
  assert.strictEqual(contextOf(null), null)
  assert.strictEqual(contextOf({ applicationId: 'app' }), null)
  assert.strictEqual(contextOf({ context: 'staged' }), null)
  assert.strictEqual(contextOf({ context: [1] }), null)
  assert.deepStrictEqual(contextOf({ context: { version: { staged: true } } }), { version: { staged: true } })

  const refusal = body => refusedContext(new Error(JSON.stringify(body)))

  // Only a refusal, i.e. a 4xx answer, which carries a context
  assert.deepStrictEqual(refusal({ statusCode: 409, context: { version: { staged: true } } }), { context: { version: { staged: true } } })
  assert.strictEqual(refusal({ statusCode: 409 }), null)
  assert.strictEqual(refusal({ statusCode: 409, context: 'staged' }), null)
  assert.strictEqual(refusal({ statusCode: 500, context: { version: { staged: true } } }), null)
  assert.strictEqual(refusal({ context: { version: { staged: true } } }), null)
  assert.strictEqual(refusedContext(new Error('connect ECONNREFUSED')), null)
  assert.strictEqual(refusedContext(null), null)

  // What ICC reads to choose how to speak to this watt-extra
  assert.deepStrictEqual(CAPABILITIES, ['application-command'])
})

test('a command is forwarded as it is to every application, or to the one ICC names, and answered with what they said', async () => {
  const runtime = createMockRuntime(['objects', 'rooms', 'front'], {
    objects: { promoted: true, status: 'applied' },
    rooms: { promoted: false, status: 'unsupported' }
    // front has no handler for the message: the runtime answers {}
  }, { objects: 'objects-capability', rooms: 'objects-capability', front: 'next' })
  const app = await createApp(runtime)
  const types = { objects: 'objects-capability', rooms: 'objects-capability', front: 'next' }

  assert.deepStrictEqual(await app.sendApplicationCommand({ name: 'plt:test:promote', payload: { generation: 2 } }), {
    applications: { objects: { promoted: true, status: 'applied' }, rooms: { promoted: false, status: 'unsupported' } },
    skipped: ['front'],
    errors: {},
    types
  })
  assert.deepStrictEqual(runtime.commands.sort((a, b) => a.id.localeCompare(b.id)), [
    { id: 'front', name: 'plt:test:promote', params: { generation: 2 } },
    { id: 'objects', name: 'plt:test:promote', params: { generation: 2 } },
    { id: 'rooms', name: 'plt:test:promote', params: { generation: 2 } }
  ])

  // One application, with the type of that one alone
  runtime.commands.length = 0
  assert.deepStrictEqual(await app.sendApplicationCommand({ application: 'objects', name: 'plt:test:list', payload: { limit: 1 } }), {
    applications: { objects: { promoted: true, status: 'applied' } },
    skipped: [],
    errors: {},
    types: { objects: 'objects-capability' }
  })
  assert.deepStrictEqual(runtime.commands, [{ id: 'objects', name: 'plt:test:list', params: { limit: 1 } }])
  assert.deepStrictEqual(await app.sendApplicationCommand({ application: 'front', name: 'plt:test:list' }), { applications: {}, skipped: ['front'], errors: {}, types: { front: 'next' } })

  // The types are asked once
  assert.strictEqual(runtime.details, 3)

  // What is not a message of a capability, or not for an application of the runtime, is refused
  await assert.rejects(app.sendApplicationCommand({ name: 'restart' }), /must start with "plt:"/)
  await assert.rejects(app.sendApplicationCommand({ payload: {} }), /must start with "plt:"/)
  await assert.rejects(app.sendApplicationCommand({ name: 'plt:test:list', queue: 7 }), /queue of an application command must be a string/)
  await assert.rejects(app.sendApplicationCommand({ application: 'missing', name: 'plt:test:list' }), /"missing" is not an application of the runtime/)
  await assert.rejects((await createApp(null)).sendApplicationCommand({ name: 'plt:test:list' }), /Runtime not started/)
})

test('whatever a handler returns is an answer: only the {} of the runtime tells that an application has no handler', async () => {
  const runtime = createMockRuntime(['no', 'zero', 'text', 'list', 'nothing', 'empty', 'missing'], {
    no: false,
    zero: 0,
    text: 'done',
    list: [],
    nothing: null,
    empty: () => ({})
    // missing has no handler
  }, { missing: 'broken' })
  const app = await createApp(runtime)

  assert.deepStrictEqual(await app.sendApplicationCommand({ name: 'plt:test:raw' }), {
    applications: { no: false, zero: 0, text: 'done', list: [], nothing: null },
    // A handler which returns {} itself cannot be told from a missing one
    skipped: ['empty', 'missing'],
    errors: {},
    // An application whose type cannot be told has none, and is asked again
    types: { no: 'node', zero: 'node', text: 'node', list: 'node', nothing: 'node', empty: 'node', missing: null }
  })

  await app.sendApplicationCommand({ application: 'missing', name: 'plt:test:raw' })
  assert.strictEqual(runtime.details, 8)
})

test('an application which fails is reported with what the others answered, and the applications are asked at once', async () => {
  let release
  const gate = new Promise(resolve => { release = resolve })
  const order = []
  const runtime = createMockRuntime(['slow', 'broken', 'fast'], {
    slow: async () => {
      await gate
      order.push('slow')
      return { done: 'slow' }
    },
    broken: () => {
      throw new Error('Cannot do it')
    },
    fast: () => {
      order.push('fast')
      return { done: 'fast' }
    }
  })
  const app = await createApp(runtime)
  const pending = app.sendApplicationCommand({ name: 'plt:test:drain' })

  // The fast application answered while the slow one still runs
  await sleep(10)
  assert.deepStrictEqual(order, ['fast'])
  release()

  const { applications, skipped, errors } = await pending
  assert.deepStrictEqual({ applications, skipped, errors }, {
    applications: { slow: { done: 'slow' }, fast: { done: 'fast' } },
    skipped: [],
    errors: { broken: 'Cannot do it' }
  })
})

test('the commands of a queue run in the order they arrived, and a repetition joins only the last one', async () => {
  const gates = []
  const reached = []
  const runtime = createMockRuntime(['objects'], {
    objects: params => {
      reached.push(params.command)

      // The drains wait for the test, the resume answers at once
      if (params.command !== 'drain') {
        return { resumed: true }
      }

      return new Promise(resolve => gates.push(() => resolve({ status: 'drained', run: gates.length })))
    }
  })
  const app = await createApp(runtime)
  const drain = () => app.sendApplicationCommand({ name: 'plt:test:state', payload: { command: 'drain' }, queue: 'state' })
  const resume = () => app.sendApplicationCommand({ name: 'plt:test:state', payload: { command: 'resume' }, queue: 'state' })

  // A drain whose answer is late, its repetition, a resume, then the same drain again
  const first = drain()
  const repeated = drain()
  const resumed = resume()
  const third = drain()
  await sleep(10)

  // Only the first drain reached the application: the repetition joined it, the others wait their turn
  assert.deepStrictEqual(reached, ['drain'])
  assert.strictEqual(first, repeated)
  assert.notStrictEqual(third, first)

  // The first drain ends: the resume runs, then the last drain, which is not the first one
  gates[0]()
  assert.deepStrictEqual((await first).applications, { objects: { status: 'drained', run: 1 } })
  assert.deepStrictEqual((await resumed).applications, { objects: { resumed: true } })
  await sleep(10)
  assert.deepStrictEqual(reached, ['drain', 'resume', 'drain'])

  // A repetition of the last drain joins it, while it runs
  assert.strictEqual(drain(), third)
  gates[1]()
  assert.deepStrictEqual((await third).applications, { objects: { status: 'drained', run: 2 } })

  // Once it ended, the same command runs again, and so does one of another queue, or of none, at once
  const again = drain()
  const elsewhere = app.sendApplicationCommand({ name: 'plt:test:state', payload: { command: 'resume' }, queue: 'other' })
  const unqueued = [1, 2].map(() => app.sendApplicationCommand({ name: 'plt:test:state', payload: { command: 'resume' } }))
  await Promise.all([elsewhere, ...unqueued])
  assert.deepStrictEqual(reached.slice(3).sort(), ['drain', 'resume', 'resume', 'resume'])
  gates[2]()
  await again

  // A command which fails does not stop its queue
  const failing = createMockRuntime(['objects'], { objects: params => { if (params.fail) { throw new Error('No') } return { ok: true } } })
  const other = await createApp(failing)
  const failed = other.sendApplicationCommand({ name: 'plt:test:state', payload: { fail: true }, queue: 'state' })
  const next = other.sendApplicationCommand({ name: 'plt:test:state', payload: {}, queue: 'state' })
  assert.deepStrictEqual((await failed).errors, { objects: 'No' })
  assert.deepStrictEqual((await next).applications, { objects: { ok: true } })
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

test('the application commands of ICC are answered over the websocket with their result', async (t) => {
  setUpEnvironment()
  const port = 14300
  const wss = new WebSocketServer({ port })
  t.after(() => wss.close())
  const { waitForClientSubscription, getWs } = setupMockIccServer(wss)

  const received = []
  const logged = []
  const app = {
    log: { ...logger, info: (context, message) => logged.push(message ?? context) },
    instanceConfig: { applicationId: 'test-application-id' },
    getAuthorizationHeaders: async () => ({ Authorization: 'Bearer test-token' }),
    getRuntimeId: () => 'test-runtime-id',
    env: { PLT_APP_NAME: 'test-app', PLT_APP_DIR: '/path/to/app', PLT_ICC_URL: `http://localhost:${port}`, PLT_UPDATES_RECONNECT_INTERVAL_SEC: 1 },
    async sendApplicationCommand (command) {
      received.push(command)

      if (command.name === 'restart') {
        throw new Error('The name of an application command must start with "plt:"')
      }

      return { applications: { objects: { promoted: command.payload?.generation !== 7 } }, skipped: [], errors: {} }
    }
  }

  await updatePlugin(app)
  await app.connectToUpdates()
  t.after(() => app.closeUpdates())
  await waitForClientSubscription

  assert.deepStrictEqual(await reply(getWs(), { command: 'application-command', requestId: 'promote-1', params: { name: 'plt:test:promote', payload: { generation: 2 } } }), {
    requestId: 'promote-1',
    success: true,
    result: { applications: { objects: { promoted: true } }, skipped: [], errors: {} }
  })

  // A command which did nothing says so in its result: the frame stays valid for ICC, which reads it
  const superseded = await reply(getWs(), { command: 'application-command', requestId: 'promote-2', params: { application: 'objects', name: 'plt:test:promote', payload: { generation: 7 }, queue: 'state' } })
  assert.deepStrictEqual([superseded.success, superseded.result.applications.objects.promoted], [true, false])

  // A command which is refused fails
  assert.deepStrictEqual(await reply(getWs(), { command: 'application-command', requestId: 'restart-1', params: { name: 'restart' } }), {
    requestId: 'restart-1',
    success: false,
    error: { message: 'The name of an application command must start with "plt:"', name: 'Error' }
  })

  // A command ICC repeats while somebody looks at a page is not logged
  const before = logged.length
  assert.strictEqual((await reply(getWs(), { command: 'application-command', requestId: 'list-1', params: { name: 'plt:test:list', silent: true } })).success, true)
  assert.strictEqual(logged.length, before)
  assert.ok(logged.includes('Received application command from ICC'))

  assert.deepStrictEqual(received, [
    { application: undefined, name: 'plt:test:promote', payload: { generation: 2 }, queue: undefined },
    { application: 'objects', name: 'plt:test:promote', payload: { generation: 7 }, queue: 'state' },
    { application: undefined, name: 'restart', payload: undefined, queue: undefined },
    { application: undefined, name: 'plt:test:list', payload: undefined, queue: undefined }
  ])
})
