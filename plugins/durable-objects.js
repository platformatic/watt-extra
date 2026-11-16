import { aggregateDrain, aggregatePromotion, COMMANDS, isLavoratoreApplication } from '../lib/durable-objects.js'

// Forwards the Durable Objects commands of ICC to the Lavoratore applications of the runtime, see lib/durable-objects.js
async function durableObjects (app, _opts) {
  function lavoratoreApplications () {
    const runtime = app.watt?.runtime

    if (!runtime) {
      throw new Error('Runtime not started, cannot reach the Durable Objects applications')
    }

    return (runtime.getRuntimeConfig(true).applications ?? []).filter(isLavoratoreApplication).map(application => application.id)
  }

  // Runs a command on every Lavoratore application: a promotion with { generation } or a drain. Returns the aggregate
  // of their answers, see lib/durable-objects.js. An application whose version of Lavoratore does not handle the
  // command answers nothing: it is reported as an error, since ICC must not take the command as done.
  async function sendDurableObjectsCommand (command, params = {}) {
    const name = COMMANDS[command]

    if (!name) {
      throw new Error(`Unknown Durable Objects command "${command}"`)
    }

    const ids = lavoratoreApplications()

    if (ids.length === 0) {
      throw new Error('This pod has no Durable Objects application')
    }

    const results = {}

    for (const id of ids) {
      const result = await app.watt.runtime.sendCommandToApplication(id, name, params)

      // The runtime answers {} when the application has no handler for the command
      if (!result || typeof result !== 'object' || Object.keys(result).length === 0) {
        throw new Error(`The application "${id}" does not handle the ${command} command: upgrade @platformatic/lavoratore`)
      }

      results[id] = result
    }

    return command === 'durable-objects-promote' ? aggregatePromotion(results) : aggregateDrain(results)
  }

  app.sendDurableObjectsCommand = sendDurableObjectsCommand
}

export default durableObjects
