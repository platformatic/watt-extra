import assert from 'node:assert'
import { test } from 'node:test'
import entrypoint from '../plugins/entrypoint.js'

async function resolveEntrypoint (applications, routedTargetPorts, warnings = []) {
  const instanceConfig = {}
  if (routedTargetPorts) {
    instanceConfig.ports = routedTargetPorts.map((targetPort) => ({ port: null, targetPort }))
  }

  const app = {
    log: {
      info () {},
      warn (data, message) {
        warnings.push(message)
      }
    },
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
  return app.getEntrypoint()
}

const api = { id: 'api', type: '@platformatic/service', urls: ['http://127.0.0.1:3042'] }
const next = { id: 'next', type: '@platformatic/next', urls: ['http://127.0.0.1:3000'] }
const internal = { id: 'internal', type: '@platformatic/service', urls: [] }

test('the application listening on a routed port is the entrypoint', async () => {
  assert.strictEqual(await resolveEntrypoint([next, api, internal], [3042, 9090]), 'api')
})

test('ports no application listens on are ignored', async () => {
  assert.strictEqual(await resolveEntrypoint([api, next], [9090, 3042]), 'api')
})

test('several listening applications and none on a routed port mean no entrypoint', async () => {
  assert.strictEqual(await resolveEntrypoint([next, api], [9090]), null)
})

test('a listening gateway is the entrypoint, whatever the routed ports', async () => {
  const gateway = { id: 'zzz', type: '@platformatic/gateway', urls: ['http://127.0.0.1:4000'] }
  assert.strictEqual(await resolveEntrypoint([api, gateway], [3042, 4000]), 'zzz')
  assert.strictEqual(await resolveEntrypoint([api, gateway], [3042]), 'zzz')
  assert.strictEqual(await resolveEntrypoint([api, next, gateway]), 'zzz')
})

test('several applications on routed ports: the first one', async () => {
  const other = { id: 'other', type: '@platformatic/service', urls: ['http://127.0.0.1:5000'] }
  assert.strictEqual(await resolveEntrypoint([next, other, api], [3042, 5000]), 'other')
})

test('a single listening application is the entrypoint, whatever the routed ports', async () => {
  assert.strictEqual(await resolveEntrypoint([api, internal]), 'api')
  assert.strictEqual(await resolveEntrypoint([api, internal], [9090]), 'api')
})

test('without routed ports several listening applications mean no entrypoint', async () => {
  assert.strictEqual(await resolveEntrypoint([api, next]), null)
})

test('a URL without a port uses the default port of its protocol', async () => {
  const https = { id: 'secure', type: '@platformatic/service', urls: ['https://example.com'] }
  assert.strictEqual(await resolveEntrypoint([https, api], [443]), 'secure')
})

test('warns only when several listening applications leave no entrypoint', async () => {
  const ambiguousWarnings = []
  assert.strictEqual(await resolveEntrypoint([next, api], [9090], ambiguousWarnings), null)
  assert.strictEqual(ambiguousWarnings.length, 1)

  const internalWarnings = []
  assert.strictEqual(await resolveEntrypoint([internal], [3042], internalWarnings), null)
  assert.deepStrictEqual(internalWarnings, [])
})

test('the entrypoint is resolved once', async () => {
  let getApplicationsCalls = 0
  const app = {
    log: { info () {}, warn () {} },
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

  assert.strictEqual(await app.getEntrypoint(), 'api')
  assert.strictEqual(await app.getEntrypoint(), 'api')
  assert.strictEqual(getApplicationsCalls, 1)
})
