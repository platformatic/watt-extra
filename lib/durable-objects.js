import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

// The Durable Objects of Lavoratore applications (@platformatic/lavoratore), orchestrated by ICC: see
// docs/durable-objects.md of Lavoratore. Everything here is optional: an ICC which knows nothing of Durable Objects
// sends no `durableObjects` with the instance config and no command, and nothing changes.

export const LAVORATORE_TYPES = ['@platformatic/lavoratore', 'lavoratore']

// The ITC commands handled by the Lavoratore applications, with the same names and payloads as their runtime messages
export const COMMANDS = {
  'durable-objects-promote': 'plt:lavoratore:promote',
  'durable-objects-drain': 'plt:lavoratore:drain'
}

// The names a runtime gives to the configuration file of an application which declares none
const CONFIG_FILES = ['watt.json', 'platformatic.json', 'platformatic.application.json']

// The configuration file of an application, parsed, or null when there is none or it cannot be read as JSON
async function readApplicationConfig (application) {
  const candidates = []

  if (application?.config) {
    candidates.push(application.config)
  } else if (application?.path) {
    for (const file of CONFIG_FILES) {
      candidates.push(join(application.path, file))
    }
  }

  for (const candidate of candidates) {
    try {
      return JSON.parse(await readFile(candidate, 'utf8'))
    } catch {}
  }

  return null
}

// Whether an application of the runtime configuration is a Lavoratore one. The runtime configuration reports the type
// only for some applications, and "unknown" for one whose capability it resolves when it starts, so the configuration
// file of the application decides too: its module, or its schema.
export async function isLavoratoreApplication (application) {
  if (LAVORATORE_TYPES.includes(application?.type)) {
    return true
  }

  const config = await readApplicationConfig(application)

  if (!config) {
    return false
  }

  return LAVORATORE_TYPES.includes(config.module) || /\/@platformatic\/lavoratore\/[^/]+\.json$/.test(config.$schema ?? '')
}

// The configuration patch of a Lavoratore application under ICC, or null when ICC said nothing about Durable Objects:
// a pod of a staged version receives no objects until ICC promotes it, with the generation of the approval
export function durableObjectsPatch (instanceConfig) {
  const durableObjects = instanceConfig?.durableObjects

  if (!durableObjects || typeof durableObjects !== 'object') {
    return null
  }

  return [
    {
      op: 'merge',
      path: '/lavoratore/durableObjects/placement',
      value: { promoted: durableObjects.staged !== true }
    }
  ]
}

// Whether the patch applies to a Lavoratore application: only one which places Durable Objects across pods, i.e. whose
// configuration has a placement. A configuration which cannot be read gets the patch: the application ignores it
// without Durable Objects.
export async function placesDurableObjects (application) {
  const config = await readApplicationConfig(application)
  return config ? config.lavoratore?.durableObjects?.placement != null : true
}

// The result of a promotion of the Lavoratore applications of the pod which handle it: promoted when all are. A pod
// where none handles it, i.e. without Durable Objects placed across pods, has nothing to promote.
export function aggregatePromotion (results) {
  return { promoted: Object.values(results).every(result => result.promoted === true), applications: results }
}

// The status of a drain of the Lavoratore applications of the pod which handle it: draining while any is, or waits for
// the newer version; drained when all are, or cannot drain at all, or none handles it; blocked when none is partial and
// some are blocked; partial otherwise.
export function aggregateDrain (results) {
  const statuses = Object.values(results).map(result => result.status)
  const done = value => value === 'drained' || value === 'unsupported'
  let status = 'partial'

  if (statuses.some(value => value === 'draining' || value === 'waiting')) {
    status = 'draining'
  } else if (statuses.every(done)) {
    status = 'drained'
  } else if (statuses.every(value => done(value) || value === 'blocked')) {
    status = 'blocked'
  }

  return { status, applications: results }
}
