import assert from 'node:assert'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { setUpEnvironment, startICC } from './helper.js'
import { start } from '../index.js'
import { LAVORATORE_TYPES } from '../lib/durable-objects.js'

// With a real runtime between watt-extra and the application: the mocks of durable-objects.test.js give the
// applications a type which the runtime does not report
test('the Durable Objects commands reach a Lavoratore application of a real runtime', async (t) => {
  const applicationName = 'test-application'
  const applicationId = randomUUID()

  const icc = await startICC(t, {
    applicationId,
    applicationName,
    controlPlaneResponse: {
      applicationId,
      applicationName,
      deploymentVersion: 'v1',
      iccServices: {},
      config: {},
      durableObjects: { staged: false }
    }
  })

  setUpEnvironment({
    PLT_APP_NAME: applicationName,
    PLT_APP_DIR: join(import.meta.dirname, 'fixtures', 'runtime-lavoratore'),
    PLT_ICC_URL: icc.iccUrl,
    PLT_APP_PORT: 3047,
    PLT_METRICS_PORT: 9097
  })

  const app = await start()

  t.after(async () => {
    await app.close()
    await icc.close()
  })

  // The premise: the runtime configuration does not say that the application is a Lavoratore one
  const applications = app.watt.runtime.getRuntimeConfig(true).applications
  assert.deepStrictEqual(applications.map(application => application.id).sort(), ['objects', 'plain'])
  assert.ok(applications.every(application => !LAVORATORE_TYPES.includes(application.type)))

  assert.deepStrictEqual(await app.sendDurableObjectsCommand('durable-objects-promote', { generation: 4 }), {
    promoted: true,
    applications: { objects: { promoted: true, status: 'applied', generation: 4, admission: 1 } }
  })

  assert.deepStrictEqual(await app.sendDurableObjectsCommand('durable-objects-drain', { wait: false, generation: 5 }), {
    status: 'drained',
    applications: { objects: { status: 'drained', moved: 2 } }
  })
})
