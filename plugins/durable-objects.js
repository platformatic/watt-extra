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

  // The commands in flight, by command and parameters: ICC repeats a command which did not answer in time, and the
  // repetition joins the one still running instead of starting another
  const inflight = new Map()

  // Runs a command on every Lavoratore application: a promotion with { generation } or a drain. Returns the aggregate
  // of their answers, see lib/durable-objects.js. An application which has no handler for the command, i.e. without
  // Durable Objects placed across pods, or with a version of Lavoratore which predates the commands, is skipped: it has
  // nothing to promote or drain, and ICC must not wait for it. The applications are all asked even when one fails, and
  // the failure is reported with what the others answered.
  function sendDurableObjectsCommand (command, params = {}) {
    const name = COMMANDS[command]

    if (!name) {
      return Promise.reject(new Error(`Unknown Durable Objects command "${command}"`))
    }

    const key = `${command}:${JSON.stringify(params)}`
    let running = inflight.get(key)

    if (!running) {
      running = runCommand(command, name, params).finally(() => inflight.delete(key))
      inflight.set(key, running)
    }

    return running
  }

  async function runCommand (command, name, params) {
    const results = {}
    const skipped = []
    const errors = []

    for (const id of lavoratoreApplications()) {
      try {
        const result = await app.watt.runtime.sendCommandToApplication(id, name, params)

        // The runtime answers {} when the application has no handler for the command
        if (!result || typeof result !== 'object' || Object.keys(result).length === 0) {
          skipped.push(id)
        } else {
          results[id] = result
        }
      } catch (err) {
        errors.push(`${id}: ${err.message}`)
      }
    }

    if (errors.length > 0) {
      const error = new Error(`The ${command} command failed in the applications ${errors.join('; ')}`)
      error.results = results
      throw error
    }

    const aggregate = command === 'durable-objects-promote' ? aggregatePromotion(results) : aggregateDrain(results)
    return skipped.length > 0 ? { ...aggregate, skipped } : aggregate
  }

  app.sendDurableObjectsCommand = sendDurableObjectsCommand
}

export default durableObjects
