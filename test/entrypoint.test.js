import assert from 'node:assert'
import { test } from 'node:test'
import entrypoint from '../plugins/entrypoint.js'

async function resolveEntrypoints (applications, routedTargetPorts) {
  const instanceConfig = {}
  if (routedTargetPorts) {
    instanceConfig.ports = routedTargetPorts.map((targetPort) => ({ port: null, targetPort }))
  }

  const app = {
    log: { info () {} },
    instanceConfig,
    watt: {
      runtime: {
        async getApplications () {
          return { applications }
        }
      }
    }
  }
  await entrypoint(app)
  return app.getEntrypoints()
}

const api = { id: 'api', type: '@platformatic/service', urls: ['http://127.0.0.1:3042'] }
const next = { id: 'next', type: '@platformatic/next', urls: ['http://127.0.0.1:3000'] }
const gateway = { id: 'gateway', type: 'gateway', urls: ['http://127.0.0.1:4000'] }
const internal = { id: 'internal', type: '@platformatic/service', urls: [] }

test('every application on a routed port is an entrypoint', async () => {
  assert.deepStrictEqual(await resolveEntrypoints([next, api, internal], [3042, 9090]), ['api'])
  assert.deepStrictEqual(await resolveEntrypoints([next, api, internal], [3042, 3000]), ['next', 'api'])
})

test('the routed ports go before a gateway', async () => {
  assert.deepStrictEqual(await resolveEntrypoints([api, gateway], [3042]), ['api'])
  assert.deepStrictEqual(await resolveEntrypoints([api, gateway], [3042, 4000]), ['api', 'gateway'])
})

test('two load balancer listeners on the same port are one entrypoint', async () => {
  assert.deepStrictEqual(await resolveEntrypoints([api, next], [3042, 3042]), ['api'])
})

test('a URL without a port uses the default port of its protocol', async () => {
  const https = { id: 'secure', type: '@platformatic/service', urls: ['https://example.com'] }
  assert.deepStrictEqual(await resolveEntrypoints([https, api], [443]), ['secure'])
})

for (const [title, routedTargetPorts] of [['without routed ports', undefined], ['when no routed port matches', [9090]]]) {
  test(`${title}: the listening gateways`, async () => {
    const otherGateway = { id: 'other', type: '@platformatic/gateway', urls: ['http://127.0.0.1:5000'] }
    const internalGateway = { id: 'mesh', type: 'gateway', urls: [] }
    const applications = [api, gateway, otherGateway, internalGateway]
    assert.deepStrictEqual(await resolveEntrypoints(applications, routedTargetPorts), ['gateway', 'other'])
  })

  test(`${title}: else every listening application`, async () => {
    assert.deepStrictEqual(await resolveEntrypoints([api, next, internal], routedTargetPorts), ['api', 'next'])
    assert.deepStrictEqual(await resolveEntrypoints([api, internal], routedTargetPorts), ['api'])
    assert.deepStrictEqual(await resolveEntrypoints([internal], routedTargetPorts), [])
  })
}

test('the entrypoints are resolved once', async () => {
  let getApplicationsCalls = 0
  const app = {
    log: { info () {} },
    instanceConfig: {},
    watt: {
      runtime: {
        async getApplications () {
          getApplicationsCalls++
          return { applications: [api] }
        }
      }
    }
  }
  await entrypoint(app)

  assert.deepStrictEqual(await app.getEntrypoints(), ['api'])
  assert.deepStrictEqual(await app.getEntrypoints(), ['api'])
  assert.strictEqual(getApplicationsCalls, 1)
})
