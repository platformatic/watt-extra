import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

// The Durable Objects of Lavoratore applications (@platformatic/lavoratore), orchestrated by ICC: see
// docs/durable-objects.md of Lavoratore. Everything here is optional: an ICC which knows nothing of Durable Objects
// sends no `durableObjects` with the instance config and no command, and nothing changes.

export const LAVORATORE_TYPES = ['@platformatic/lavoratore', 'lavoratore']

// The ITC commands handled by the Lavoratore applications, with the same names and payloads as their runtime messages
export const COMMANDS = {
  'durable-objects-promote': 'plt:lavoratore:promote',
  'durable-objects-drain': 'plt:lavoratore:drain',
  'durable-objects-list': 'plt:lavoratore:objects'
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

// What ICC said about Durable Objects when it refused the registration of the pod, or null. The error of the client
// carries the body of the response: an ICC which orchestrates Durable Objects adds `durableObjects` to its refusals,
// i.e. the 4xx answers, since a pod it does not accept must not receive objects. Any other failure, an ICC which cannot
// be reached, which fails, or which knows nothing of Durable Objects, says nothing, and nothing changes.
export function refusedDurableObjects (err) {
  let body

  try {
    body = JSON.parse(err?.message)
  } catch {
    return null
  }

  if (!body || typeof body !== 'object' || !(body.statusCode >= 400 && body.statusCode < 500)) {
    return null
  }

  const durableObjects = body.durableObjects
  return durableObjects && typeof durableObjects === 'object' ? { durableObjects } : null
}

// The result of a promotion of the Lavoratore applications of the pod: promoted when all those which place Durable
// Objects across pods are. An application which does not answers { status: 'unsupported' }, or has no handler with a
// version of Lavoratore which predates that answer: it has nothing to promote, and a pod with no other has none either.
export function aggregatePromotion (results) {
  return {
    promoted: Object.values(results).every(result => result.promoted === true || result.status === 'unsupported'),
    applications: results
  }
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

// The objects the Lavoratore applications of the pod hold, each with its application: active, or hibernated. An
// application without Durable Objects answers { status: 'unsupported' } and has none. Truncated when an application
// holds more objects than it lists: total counts them all. applications are those which listed their objects, even
// none: ICC tells from them a pod which holds no object from one which cannot list, and from the skipped ones a list
// which misses the objects of some applications.
export function aggregateObjects (results) {
  const objects = []
  const applications = []
  let total = 0
  let truncated = false

  for (const [application, result] of Object.entries(results)) {
    if (!Array.isArray(result.objects)) {
      continue
    }

    applications.push(application)

    for (const object of result.objects) {
      objects.push({ application, ...object })
    }

    total += result.total ?? result.objects.length
    truncated ||= result.truncated === true
  }

  return { total, truncated, applications, objects }
}
