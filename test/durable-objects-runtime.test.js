import assert from 'node:assert'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { setUpEnvironment, startICC } from './helper.js'
import pino from 'pino'
import buildApp from '../app.js'
import { start } from '../index.js'
import { LAVORATORE_TYPES } from '../lib/durable-objects.js'

// With a real runtime between watt-extra and the application: the mocks of durable-objects.test.js give the
// applications a type which the runtime does not report. The application of the fixture stands for a Lavoratore one:
// it answers the commands, and reports the placement it started with.
const applicationName = 'test-application'

async function startWith (t, controlPlaneResponse, accepted = true) {
  const applicationId = randomUUID()
  const icc = await startICC(t, { applicationId, applicationName, controlPlaneResponse })

  setUpEnvironment({
    PLT_APP_NAME: applicationName,
    PLT_APP_DIR: join(import.meta.dirname, 'fixtures', 'runtime-lavoratore'),
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

async function placementOf (app) {
  const { body } = await app.watt.runtime.inject('objects', { method: 'GET', url: '/' })
  return JSON.parse(body).placement
}

function refusal (reply, extra = {}) {
  reply.code(409)
  return { statusCode: 409, code: 'PLT_CONTROL_PLANE_VERSION_DEPLOYMENT_MISMATCH', error: 'Conflict', message: 'Version "v1" is already bound to another controller or image', ...extra }
}

test('the Durable Objects commands reach a Lavoratore application of a real runtime', async (t) => {
  const { app } = await startWith(t, {
    applicationId: randomUUID(),
    applicationName,
    deploymentVersion: 'v1',
    iccServices: {},
    config: {},
    durableObjects: { staged: false }
  })

  // The premise: the runtime configuration does not say that the application is a Lavoratore one
  const applications = app.watt.runtime.getRuntimeConfig(true).applications
  assert.deepStrictEqual(applications.map(application => application.id).sort(), ['objects', 'plain'])
  assert.ok(applications.every(application => !LAVORATORE_TYPES.includes(application.type)))

  // ICC said that the version is not staged
  assert.deepStrictEqual(await placementOf(app), { type: 'coordinator', promoted: true })

  assert.deepStrictEqual(await app.sendDurableObjectsCommand('durable-objects-promote', { generation: 4 }), {
    promoted: true,
    applications: { objects: { promoted: true, status: 'applied', generation: 4, admission: 1 } }
  })

  assert.deepStrictEqual(await app.sendDurableObjectsCommand('durable-objects-drain', { wait: false, generation: 5 }), {
    status: 'drained',
    applications: { objects: { status: 'drained', moved: 2 } }
  })
})

test('a pod refused by an ICC which orchestrates Durable Objects starts its Lavoratore applications staged', async (t) => {
  const { app } = await startWith(t, (_req, reply) => refusal(reply, { durableObjects: { staged: true } }), false)

  assert.deepStrictEqual(app.registrationRefusal, { durableObjects: { staged: true } })
  assert.deepStrictEqual(await placementOf(app), { type: 'coordinator', promoted: false })

  // The pod still answers the promotion ICC sends once it accepts it
  assert.strictEqual((await app.sendDurableObjectsCommand('durable-objects-promote', { generation: 2 })).promoted, true)
})

test('a pod refused by an ICC which knows nothing of Durable Objects starts as before', async (t) => {
  const { app } = await startWith(t, (_req, reply) => refusal(reply), false)

  assert.strictEqual(app.registrationRefusal, null)
  assert.deepStrictEqual(await placementOf(app), { type: 'coordinator' })
})
