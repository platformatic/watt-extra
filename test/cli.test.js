import assert from 'node:assert'
import { test } from 'node:test'
import { spawn } from 'node:child_process'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { applyStartArgs } from '../cli.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// Helper function to run CLI with arguments and capture output
function runCLI (args = []) {
  return new Promise((resolve, reject) => {
    const cliPath = join(__dirname, '..', 'cli.js')
    const proc = spawn('node', [cliPath, ...args], {
      stdio: ['ignore', 'pipe', 'pipe']
    })

    const stdout = []
    const stderr = []

    proc.stdout.on('data', (data) => {
      stdout.push(data.toString())
    })

    proc.stderr.on('data', (data) => {
      stderr.push(data.toString())
    })

    proc.on('error', reject)

    proc.on('close', (code) => {
      resolve({
        code,
        stdout: stdout.join(''),
        stderr: stderr.join('')
      })
    })
  })
}

test('CLI should exit with error code for non-existent command', async (t) => {
  const { code } = await runCLI(['nonexistentcommand'])

  // The important part is that a non-existent command exits with error code 1
  assert.strictEqual(code, 1, 'Process should exit with code 1 for non-existent command')
})

test('CLI should show help when no arguments are provided', async (t) => {
  const { code, stdout } = await runCLI([])

  assert.strictEqual(code, 0, 'Process should exit with code 0')
  assert.ok(
    stdout.includes('WattExtra'),
    'Help output should include application name'
  )
})

test('CLI should show help with help command', async (t) => {
  const { code, stdout } = await runCLI(['help'])

  assert.strictEqual(code, 0, 'Process should exit with code 0')
  assert.ok(
    stdout.includes('WattExtra'),
    'Help output should include application name'
  )
})

test('CLI should show version with version command', async (t) => {
  const { code, stdout } = await runCLI(['version'])
  assert.strictEqual(code, 0, 'Process should exit with code 0')
  assert.ok(
    stdout.includes('WattExtra v'),
    'Version output should include version number'
  )
})

test('CLI should output JSON log without banner in non-TTY mode (version command)', async (t) => {
  const { code, stdout } = await runCLI(['version'])
  assert.strictEqual(code, 0, 'Process should exit with code 0')

  // In non-TTY mode, should NOT have the banner box characters
  assert.ok(
    !stdout.includes('+======'),
    'Non-TTY output should not include banner box'
  )

  // Should have JSON log with version
  assert.ok(
    stdout.includes('"msg":"WattExtra v'),
    'Non-TTY output should include JSON log with version'
  )
})

test('applyStartArgs: --log-level flag overrides env-provided PLT_LOG_LEVEL', () => {
  const env = { PLT_LOG_LEVEL: 'warn' }
  applyStartArgs(['--log-level', 'debug'], env)
  assert.strictEqual(env.PLT_LOG_LEVEL, 'debug')
})

test('applyStartArgs: -l short flag also overrides env', () => {
  const env = { PLT_LOG_LEVEL: 'warn' }
  applyStartArgs(['-l', 'trace'], env)
  assert.strictEqual(env.PLT_LOG_LEVEL, 'trace')
})

// Regression test: cli.js used to have `default: { 'log-level': 'info' }` in its
// minimist config, which populated args['log-level'] with 'info' whenever the flag
// was not passed. The subsequent unconditional write to process.env.PLT_LOG_LEVEL
// then silently clobbered the value provided by the deployment environment (e.g.
// PLT_LOG_LEVEL=warn from k8s), forcing the runtime to log at info regardless.
test('applyStartArgs: preserves env-provided PLT_LOG_LEVEL when --log-level is not passed', () => {
  const env = { PLT_LOG_LEVEL: 'warn' }
  applyStartArgs([], env)
  assert.strictEqual(env.PLT_LOG_LEVEL, 'warn')
})

test('applyStartArgs: defaults PLT_LOG_LEVEL to "info" when neither env nor flag is set', () => {
  const env = {}
  applyStartArgs([], env)
  assert.strictEqual(env.PLT_LOG_LEVEL, 'info')
})

test('applyStartArgs: passes through other CLI options to env', () => {
  const env = {}
  applyStartArgs([
    '--icc-url', 'http://icc.example',
    '--app-name', 'my-app',
    '--app-dir', 'test/fixtures/runtime-service'
  ], env)
  assert.strictEqual(env.PLT_ICC_URL, 'http://icc.example')
  assert.strictEqual(env.PLT_APP_NAME, 'my-app')
  assert.strictEqual(env.PLT_APP_DIR, resolve('test/fixtures/runtime-service'))
})

test('applyStartArgs: --help short-circuits without mutating env', () => {
  const env = {}
  const res = applyStartArgs(['--help'], env)
  assert.strictEqual(res.help, true)
  assert.strictEqual(env.PLT_LOG_LEVEL, undefined)
})
