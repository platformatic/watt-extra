/// <reference path="../global.d.ts" />
'use strict'
/** @param {import('fastify').FastifyInstance} fastify */
module.exports = async function (fastify, opts) {
  fastify.get('/example', async (request, reply) => {
    return { hello: fastify.example }
  })

  fastify.post('/cpu-intensive', async (req, reply) => {
    // Simulate a CPU intensive operation
    const timeout = req.body.timeout ?? 1000
    const start = Date.now()

    while (Date.now() - start < timeout) {
      if (Date.now() % 1000 === 0) {}
    }

    return { status: 'ok' }
  })
}
