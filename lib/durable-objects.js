import { readFile } from 'node:fs/promises'

// The Durable Objects of Lavoratore applications (@platformatic/lavoratore), orchestrated by ICC: see
// docs/durable-objects.md of Lavoratore. Everything here is optional: an ICC which knows nothing of Durable Objects
// sends no `durableObjects` with the instance config and no command, and nothing changes.

export const LAVORATORE_TYPES = ['@platformatic/lavoratore', 'lavoratore']

// The ITC commands handled by the Lavoratore applications, with the same names and payloads as their runtime messages
export const COMMANDS = {
  'durable-objects-promote': 'plt:lavoratore:promote',
  'durable-objects-drain': 'plt:lavoratore:drain'
}

export function isLavoratoreApplication (application) {
  return LAVORATORE_TYPES.includes(application?.type)
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
  if (!application?.config) {
    return true
  }

  try {
    const config = JSON.parse(await readFile(application.config, 'utf8'))
    return config?.lavoratore?.durableObjects?.placement != null
  } catch {
    return true
  }
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
