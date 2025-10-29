'use strict'

const { join } = require('node:path')
const { readFile } = require('node:fs/promises')
const { request } = require('undici')
const atomicSleep = require('atomic-sleep')

module.exports = async function (fastify) {
  fastify.get('/example', async () => {
    return { hello: 'world' }
  })

  fastify.get('/config', async () => {
    return fastify.platformatic.config
  })

  fastify.get('/preprocess', async () => {
    return {
      base: '~PLT_BASE_PATH',
      leadingSlash: '/~PLT_BASE_PATH',
      withPrefix: '~PLT_BASE_PATH/foo',
      externalUrl: '~PLT_EXTERNAL_APP_URL'
    }
  })

  fastify.get('/custom-ext-file', async () => {
    const customExtFilePath = join(__dirname, '..', 'file.custom')
    const customExtFile = await readFile(customExtFilePath, 'utf8')
    return { data: customExtFile }
  })

  fastify.get('/env', async () => {
    return { env: process.env }
  })

  fastify.post('/request', async (req) => {
    const { method, url } = req.body

    const { statusCode, headers, body } = await request(url, {
      method: method ?? 'GET',
      headers: {
        'content-type': 'application/json'
      }
    })
    const data = await body.text()

    return { statusCode, headers, data }
  })

  fastify.post('/cpu-intensive', async (req) => {
    // Simulate a CPU intensive operation
    const timeout = req.query.timeout || 10000
    atomicSleep(timeout)

    return { status: 'ok' }
  })

  fastify.post('/custom-health-signal', async (req) => {
    const { type, value, description } = req.body
    await globalThis.platformatic.sendHealthSignal({
      type,
      value,
      description
    })
  })
}
