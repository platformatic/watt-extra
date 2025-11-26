import assert from 'node:assert'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import { Profile } from 'pprof-format'
import { setUpEnvironment, startICC } from './helper.js'
import { start } from '../index.js'
import { Profiler } from '../plugins/flamegraphs.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

async function setupApp (t) {
  const applicationName = 'test-app'
  const applicationId = randomUUID()
  const applicationPath = join(__dirname, 'fixtures', 'service-1')

  const icc = await startICC(t, {
    applicationId,
    applicationName
  })

  setUpEnvironment({
    PLT_APP_NAME: applicationName,
    PLT_APP_DIR: applicationPath,
    PLT_ICC_URL: 'http://127.0.0.1:3000'
  })

  const app = await start()

  t.after(async () => {
    await app.close()
    await icc.close()
  })

  return app
}

test('Profiler should start profiling and generate profile on first request', async (t) => {
  const app = await setupApp(t)

  let profileReceived = false
  const profiler = new Profiler({
    app,
    workerId: 'main:0',
    type: 'cpu',
    duration: 1000,
    sourceMaps: false,
    onProfile: (err, profile, requests) => {
      assert.strictEqual(err, null)
      assert.ok(profile)
      assert.ok(profile.data)
      assert.ok(profile.timestamp)
      assert.strictEqual(requests.length, 1)
      assert.strictEqual(requests[0].alertId, 'test-alert')
      profileReceived = true
    }
  })

  t.after(async () => {
    await profiler.stop()
  })

  // Request a profile
  await profiler.requestProfile({ alertId: 'test-alert' })

  // Wait for profile to be generated (duration is 1 second)
  await sleep(1500)

  assert.ok(profileReceived, 'Profile should have been generated')
})

test('Profiler should queue multiple requests and associate them with the profile', async (t) => {
  const app = await setupApp(t)

  let profileReceived = false
  const profiler = new Profiler({
    app,
    workerId: 'main:0',
    type: 'cpu',
    duration: 1000,
    sourceMaps: false,
    onProfile: (err, profile, requests) => {
      assert.strictEqual(err, null)
      assert.ok(profile)
      assert.strictEqual(requests.length, 3)
      assert.strictEqual(requests[0].alertId, 'alert-1')
      assert.strictEqual(requests[1].alertId, 'alert-2')
      assert.strictEqual(requests[2].alertId, 'alert-3')
      profileReceived = true
    }
  })

  t.after(async () => {
    await profiler.stop()
  })

  // Queue multiple requests
  await profiler.requestProfile({ alertId: 'alert-1' })
  await profiler.requestProfile({ alertId: 'alert-2' })
  await profiler.requestProfile({ alertId: 'alert-3' })

  // Wait for profile to be generated
  await sleep(1500)

  assert.ok(profileReceived, 'Profile should have been generated with all requests')
})

test('Profiler should filter requests by timestamp', async (t) => {
  const app = await setupApp(t)

  const profilesReceived = []
  const profiler = new Profiler({
    app,
    workerId: 'main:0',
    type: 'cpu',
    duration: 1000,
    sourceMaps: false,
    onProfile: (err, profile, requests) => {
      if (err) return
      profilesReceived.push({ profile, requests })
    }
  })

  t.after(async () => {
    await profiler.stop()
  })

  // Request first profile
  await profiler.requestProfile({ alertId: 'alert-1' })

  // Wait for first profile
  await sleep(1500)

  // Request second profile after some delay
  await profiler.requestProfile({ alertId: 'alert-2' })

  // Wait for second profile
  await sleep(1500)

  assert.strictEqual(profilesReceived.length, 2)
  assert.strictEqual(profilesReceived[0].requests.length, 1)
  assert.strictEqual(profilesReceived[0].requests[0].alertId, 'alert-1')
  assert.strictEqual(profilesReceived[1].requests.length, 1)
  assert.strictEqual(profilesReceived[1].requests[0].alertId, 'alert-2')
})

test('Profiler should auto-stop after idle period', async (t) => {
  const app = await setupApp(t)

  let stopCalled = false
  const originalSendCommand = app.watt.runtime.sendCommandToApplication
  app.watt.runtime.sendCommandToApplication = async (workerId, command, options) => {
    if (command === 'stopProfiling') {
      stopCalled = true
    }
    return originalSendCommand.call(app.watt.runtime, workerId, command, options)
  }

  const profiler = new Profiler({
    app,
    workerId: 'main:0',
    type: 'cpu',
    duration: 1000,
    sourceMaps: false,
    onProfile: () => {}
  })

  t.after(async () => {
    await profiler.stop()
  })

  // Request a profile
  await profiler.requestProfile({ alertId: 'test-alert' })

  // Wait for profile generation + idle timeout (duration + duration/2)
  await sleep(2000)

  assert.ok(stopCalled, 'Profiler should have stopped after idle period')
})

test('Profiler should not stop if new requests arrive', async (t) => {
  const app = await setupApp(t)

  let stopCalled = false
  const originalSendCommand = app.watt.runtime.sendCommandToApplication
  app.watt.runtime.sendCommandToApplication = async (workerId, command, options) => {
    if (command === 'stopProfiling') {
      stopCalled = true
    }
    return originalSendCommand.call(app.watt.runtime, workerId, command, options)
  }

  const profilesReceived = []
  const profiler = new Profiler({
    app,
    workerId: 'main:0',
    type: 'cpu',
    duration: 1000,
    sourceMaps: false,
    onProfile: (err, profile, requests) => {
      if (err) return
      profilesReceived.push({ profile, requests })
    }
  })

  t.after(async () => {
    await profiler.stop()
  })

  // Request first profile
  await profiler.requestProfile({ alertId: 'alert-1' })

  // Wait for first profile
  await sleep(1200)

  // Request second profile before idle timeout
  await profiler.requestProfile({ alertId: 'alert-2' })

  // Wait for second profile
  await sleep(1200)

  assert.strictEqual(profilesReceived.length, 2)
  assert.strictEqual(stopCalled, false, 'Profiler should not have stopped yet')
})

test('Profiler should handle errors when starting profiling', async (t) => {
  const app = await setupApp(t)

  // Mock sendCommandToApplication to throw error on startProfiling
  const originalSendCommand = app.watt.runtime.sendCommandToApplication
  app.watt.runtime.sendCommandToApplication = async (workerId, command, options) => {
    if (command === 'startProfiling') {
      throw new Error('Failed to start profiling')
    }
    return originalSendCommand.call(app.watt.runtime, workerId, command, options)
  }

  let errorReceived = false
  const profiler = new Profiler({
    app,
    workerId: 'main:0',
    type: 'cpu',
    duration: 1000,
    sourceMaps: false,
    onProfile: (err, profile, requests) => {
      assert.ok(err)
      assert.strictEqual(err.message, 'Failed to start profiling')
      assert.strictEqual(profile, null)
      assert.strictEqual(requests.length, 1)
      errorReceived = true
    }
  })

  t.after(async () => {
    await profiler.stop()
  })

  // Request a profile
  await profiler.requestProfile({ alertId: 'test-alert' })

  // Wait for error callback
  await sleep(200)

  assert.ok(errorReceived, 'Error should have been handled')
})

test('Profiler should handle errors when getting profile', async (t) => {
  const app = await setupApp(t)

  // Mock sendCommandToApplication to throw error on getLastProfile
  const originalSendCommand = app.watt.runtime.sendCommandToApplication
  app.watt.runtime.sendCommandToApplication = async (workerId, command, options) => {
    if (command === 'getLastProfile') {
      throw new Error('Failed to get profile')
    }
    return originalSendCommand.call(app.watt.runtime, workerId, command, options)
  }

  let errorReceived = false
  const profiler = new Profiler({
    app,
    workerId: 'main:0',
    type: 'cpu',
    duration: 1000,
    sourceMaps: false,
    onProfile: (err, profile, requests) => {
      assert.ok(err)
      assert.strictEqual(err.message, 'Failed to get profile')
      assert.strictEqual(profile, null)
      assert.strictEqual(requests.length, 1)
      errorReceived = true
    }
  })

  t.after(async () => {
    await profiler.stop()
  })

  // Request a profile
  await profiler.requestProfile({ alertId: 'test-alert' })

  // Wait for profile generation attempt
  await sleep(1500)

  assert.ok(errorReceived, 'Error should have been handled')
})

test('Profiler should pass sourceMaps option correctly', async (t) => {
  const app = await setupApp(t)

  let sourceMapsOptionReceived = null
  const originalSendCommand = app.watt.runtime.sendCommandToApplication
  app.watt.runtime.sendCommandToApplication = async (workerId, command, options) => {
    if (command === 'startProfiling') {
      sourceMapsOptionReceived = options.sourceMaps
    }
    return originalSendCommand.call(app.watt.runtime, workerId, command, options)
  }

  const profiler = new Profiler({
    app,
    workerId: 'main:0',
    type: 'cpu',
    duration: 1000,
    sourceMaps: true,
    onProfile: () => {}
  })

  t.after(async () => {
    await profiler.stop()
  })

  // Request a profile
  await profiler.requestProfile({ alertId: 'test-alert' })

  // Wait for profiling to start
  await sleep(200)

  assert.strictEqual(sourceMapsOptionReceived, true, 'sourceMaps option should be passed correctly')
})

test('Profiler should manually stop profiling when stop() is called', async (t) => {
  const app = await setupApp(t)

  let stopCalled = false
  const originalSendCommand = app.watt.runtime.sendCommandToApplication
  app.watt.runtime.sendCommandToApplication = async (workerId, command, options) => {
    if (command === 'stopProfiling') {
      stopCalled = true
    }
    return originalSendCommand.call(app.watt.runtime, workerId, command, options)
  }

  const profiler = new Profiler({
    app,
    workerId: 'main:0',
    type: 'cpu',
    duration: 1000,
    sourceMaps: false,
    onProfile: () => {}
  })

  // Request a profile
  await profiler.requestProfile({ alertId: 'test-alert' })

  // Wait a bit
  await sleep(200)

  // Manually stop
  await profiler.stop()

  assert.ok(stopCalled, 'stopProfiling should have been called')
})

test('Profiler should handle requests with custom timestamps', async (t) => {
  const app = await setupApp(t)

  let profileReceived = false
  const profiler = new Profiler({
    app,
    workerId: 'main:0',
    type: 'cpu',
    duration: 1000,
    sourceMaps: false,
    onProfile: (err, profile, requests) => {
      assert.strictEqual(err, null)
      assert.ok(profile)
      assert.strictEqual(requests.length, 1)
      assert.strictEqual(requests[0].timestamp, 123456)
      profileReceived = true
    }
  })

  t.after(async () => {
    await profiler.stop()
  })

  // Request with custom timestamp
  await profiler.requestProfile({ alertId: 'test-alert', timestamp: 123456 })

  // Wait for profile to be generated
  await sleep(1500)

  assert.ok(profileReceived, 'Profile should have been generated with custom timestamp')
})

test('Profiler should generate valid pprof profile', async (t) => {
  const app = await setupApp(t)

  let profileData = null
  const profiler = new Profiler({
    app,
    workerId: 'main:0',
    type: 'cpu',
    duration: 1000,
    sourceMaps: false,
    onProfile: (err, profile, requests) => {
      if (!err && profile) {
        profileData = profile.data
      }
    }
  })

  t.after(async () => {
    await profiler.stop()
  })

  // Request a profile
  await profiler.requestProfile({ alertId: 'test-alert' })

  // Wait for profile to be generated
  await sleep(1500)

  assert.ok(profileData, 'Profile data should exist')

  // Verify it's a valid pprof format
  const profile = Profile.decode(profileData)
  assert.ok(profile, 'Profile should be decodable')
  assert.ok(profile.sample, 'Profile should have samples')
})
