import assert from 'node:assert'
import { test } from 'node:test'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getPrivateSymbol } from '@platformatic/foundation'
import { createLogger } from '../index.js'
import { runCLI } from './helper.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

test('createLogger uses isoTime timestamp when configured', async (t) => {
  const fixturePath = join(__dirname, 'fixtures', 'custom-logger')

  const originalCwd = process.cwd()
  process.chdir(fixturePath)
  t.after(() => process.chdir(originalCwd))

  const logger = await createLogger()

  const timeSym = getPrivateSymbol(logger, 'pino.time')
  const timeOutput = logger[timeSym]()
  assert.match(timeOutput, /"time":"[0-9]{4}-[0-9]{2}-[0-9]{2}T/)
})

test('start() uses isoTime timestamp when configured', async (t) => {
  const fixturePath = join(__dirname, 'fixtures', 'custom-logger')

  let buffer = ''
  let resolved = false

  await runCLI(['start'], {
    spawnOpts: {
      cwd: fixturePath,
      env: {
        ...process.env,
        PLT_DISABLE_COMPLIANCE_CHECK: 'true',
        PLT_DISABLE_FLAMEGRAPHS: 'true',
        PLT_APP_NAME: 'test-app'
      }
    },
    onProcess: (proc) => t.after(() => proc.kill()),
    onStdout: (data, { resolve, reject }) => {
      if (resolved) return

      buffer += data.toString()
      const lines = buffer.split('\n')
      buffer = lines.pop()

      for (const line of lines) {
        if (!line.trim()) continue

        let json
        try {
          json = JSON.parse(line)
        } catch {
          continue
        }

        if (json.time !== undefined) {
          resolved = true
          try {
            assert.match(String(json.time), /^[0-9]{4}-[0-9]{2}-[0-9]{2}T/)
            resolve()
          } catch (err) {
            reject(err)
          }
          return
        }
      }
    }
  })
})
