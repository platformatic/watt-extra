import assert from 'node:assert'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { setUpEnvironment, startICC } from './helper.js'
import pino from 'pino'
import buildApp from '../app.js'
import { start } from '../index.js'

// With a real runtime between watt-extra and the applications: one of the fixture handles the commands and reports
// the context of the deployment it started with, the other handles nothing
const applicationName = 'test-application'

async function startWith (t, controlPlaneResponse, accepted = true) {
  const applicationId = randomUUID()
  const icc = await startICC(t, { applicationId, applicationName, controlPlaneResponse })

  setUpEnvironment({
    PLT_APP_NAME: applicationName,
    PLT_APP_DIR: join(import.meta.dirname, 'fixtures', 'runtime-commands'),
    PLT_ICC_URL: icc.iccUrl,
    PLT_APP_PORT: 3047,
    PLT_METRICS_PORT: 9097
  })

  // start() retries the registration until ICC accepts it: a refused pod stops at the runtime, as a pod does while
  // it retries
  let app

  if (accepted) {
    app = await start()
  } else {
    app = await buildApp(pino({ level: 'silent' }))
    await app.startRuntime()
  }

  t.after(async () => {
    await app.close()
    await icc.close()
  })

  return { app, applicationId }
}

async function contextOf (app, application = 'objects') {
  const { body } = await app.watt.runtime.inject(application, { method: 'GET', url: '/' })
  const { context } = JSON.parse(body)
  return context === null ? null : JSON.parse(context)
}

function accepted (extra = {}) {
  return { applicationId: randomUUID(), applicationName, deploymentVersion: 'v1', iccServices: {}, config: {}, ...extra }
}

function refusal (reply, extra = {}) {
  reply.code(409)
  return { statusCode: 409, code: 'PLT_CONTROL_PLANE_VERSION_DEPLOYMENT_MISMATCH', error: 'Conflict', message: 'Version "v1" is already bound to another controller or image', ...extra }
}

test('the applications of a real runtime start with the context of ICC, and answer its commands', async (t) => {
  const context = { version: { staged: true, generation: 4 } }
  const { app } = await startWith(t, accepted({ context }))

  assert.deepStrictEqual(await contextOf(app), context)

  // What ICC tells wins over the variable an application sets for itself: a version ICC stages starts staged
  assert.deepStrictEqual(await contextOf(app, 'own'), context)

  // To every application: the ones without a handler are skipped, and each has the type its capability tells
  assert.deepStrictEqual(await app.sendApplicationCommand({ name: 'plt:test:promote', payload: { generation: 4 } }), {
    applications: { objects: { promoted: true, generation: 4 } },
    skipped: ['own', 'plain'],
    errors: {},
    types: { objects: 'nodejs', own: 'nodejs', plain: 'nodejs' }
  })

  // To one application, and a command which fails there
  assert.deepStrictEqual(await app.sendApplicationCommand({ application: 'objects', name: 'plt:test:promote', payload: { generation: 5 } }), {
    applications: { objects: { promoted: true, generation: 5 } },
    skipped: [],
    errors: {},
    types: { objects: 'nodejs' }
  })

  // Answers which are not objects come back as they are
  for (const [answer, expected] of [['false', false], ['zero', 0], ['text', 'done'], ['list', []], ['nothing', null]]) {
    assert.deepStrictEqual((await app.sendApplicationCommand({ application: 'own', name: 'plt:test:raw', payload: { answer } })).applications, { own: expected })
  }

  const failed = await app.sendApplicationCommand({ application: 'objects', name: 'plt:test:fail' })
  assert.deepStrictEqual([failed.applications, failed.skipped, Object.keys(failed.errors)], [{}, [], ['objects']])
  assert.match(failed.errors.objects, /This command fails/)
})

test('a pod ICC tells nothing about starts its applications without a context', async (t) => {
  const { app } = await startWith(t, accepted())

  assert.strictEqual(await contextOf(app), null)

  // An application which sets the variable for itself keeps it
  assert.deepStrictEqual(await contextOf(app, 'own'), { version: { staged: false }, own: true })
})

test('a pod ICC refuses starts its applications with the context of the refusal', async (t) => {
  const context = { version: { staged: true } }
  const { app } = await startWith(t, (_req, reply) => refusal(reply, { context }), false)

  assert.deepStrictEqual(app.registrationRefusal, { context })
  assert.deepStrictEqual(await contextOf(app), context)

  // The pod still answers the commands ICC sends once it accepts it
  assert.strictEqual((await app.sendApplicationCommand({ name: 'plt:test:promote', payload: { generation: 2 } })).applications.objects.promoted, true)
})

test('a pod refused by an ICC which gives no context starts as before', async (t) => {
  const { app } = await startWith(t, (_req, reply) => refusal(reply), false)

  assert.strictEqual(app.registrationRefusal, null)
  assert.strictEqual(await contextOf(app), null)
})
