import avvio from 'avvio'
import { after, mock } from 'node:test'
import { create } from '@platformatic/runtime'

// Observe the plugin container without adding a test-only API to the extension.
// All hooks and plugins still execute through the published Watt loader.
let application
mock.module('avvio', {
  defaultExport (app, ...args) {
    application = app
    return avvio(app, ...args)
  }
})

export async function start () {
  const root = process.env.PLT_APP_DIR
  const runtime = await create(root, undefined, { isProduction: true, setupSignals: false })
  after(() => runtime.close())
  const app = application
  const synchronized = Promise.withResolvers()
  synchronized.promise.catch(() => {})
  const sendToICC = app.sendToICC
  app.sendToICC = async () => {
    try {
      const result = await sendToICC()
      synchronized.resolve()
      return result
    } catch (err) {
      synchronized.reject(err)
      throw err
    }
  }
  app.close = () => runtime.close()
  try {
    await runtime.start()
    await synchronized.promise
    return app
  } catch (err) {
    await runtime.close()
    throw err
  }
}
