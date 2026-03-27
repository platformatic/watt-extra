import assert from 'node:assert'
import { test } from 'node:test'
import { runCLI } from './helper.js'

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
