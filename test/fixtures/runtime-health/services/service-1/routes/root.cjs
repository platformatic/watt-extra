/// <reference path="../global.d.ts" />

const { request } = require('undici')

'use strict'
/** @param {import('fastify').FastifyInstance} fastify */
module.exports = async function (fastify, opts) {
  fastify.get('/example', async (request, reply) => {
    return { hello: fastify.example }
  })

  fastify.post('/service-2/cpu-intensive', async (req, reply) => {
    await request('http://service-2.plt.local/cpu-intensive', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: req.body
    })
  })
}
