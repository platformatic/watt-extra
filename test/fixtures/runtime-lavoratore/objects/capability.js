// A stand-in for the Lavoratore capability: the Node.js one, accepting the "lavoratore" key of the configuration, which
// watt-extra patches
import * as node from '@platformatic/node'

export const { Generator, loadConfiguration, packageJson, schemaComponents, transform, version } = node

export const schema = {
  ...node.schema,
  properties: { ...node.schema.properties, lavoratore: { type: 'object', additionalProperties: true } }
}

export async function create (configOrRoot, sourceOrConfig, context) {
  const capability = await node.create(configOrRoot, sourceOrConfig, { ...context, schema })

  // For the application, which reports the placement it started with
  globalThis.lavoratoreStandIn = { placement: () => capability.config?.lavoratore?.durableObjects?.placement }

  return capability
}
