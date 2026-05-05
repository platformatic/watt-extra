import { readFile, stat } from 'node:fs/promises'
import { Agent } from 'undici'

const K8S_TOKEN_PATH = '/var/run/secrets/kubernetes.io/serviceaccount/token'

// ── Helpers ────────────────────────────────────────────────────────────────

function decodeJwtPayload (token) {
  try {
    if (!token) return null
    const base64Payload = token.split('.')[1]
    if (!base64Payload) return null
    const payload = Buffer.from(base64Payload, 'base64').toString('utf8')
    return JSON.parse(payload)
  } catch {
    return null
  }
}

function isTokenExpired (token, offset = 0) {
  const payload = decodeJwtPayload(token)
  if (!payload || !payload.exp) return true
  return payload.exp <= Math.floor(Date.now() / 1000) + offset
}

async function loadK8sToken (log) {
  let token
  try {
    await stat(K8S_TOKEN_PATH)
    log.info('Loading JWT token from K8s service account')
    token = await readFile(K8S_TOKEN_PATH, 'utf8')
  } catch {
    log.warn('Failed to load JWT token from K8s service account')
  }
  if (!token) {
    log.warn('K8s token not found, falling back to environment variable')
    token = process.env.PLT_TEST_TOKEN
  }
  return token
}

// Read ECS task identity (TaskARN suffix + cluster) from the task metadata
// endpoint. K8s identity travels via the SA JWT, so no resolution needed there.
async function resolveEcsIdentity (log) {
  const metadataUrl = `${process.env.ECS_CONTAINER_METADATA_URI_V4}/task`
  try {
    const res = await fetch(metadataUrl)
    if (!res.ok) throw new Error(`status ${res.status}`)
    const meta = await res.json()
    const id = meta.TaskARN?.split('/').pop()
    // meta.Cluster may be either the short name or the full cluster ARN
    // (e.g. 'arn:aws:ecs:us-east-1:123456789012:cluster/my-cluster'). We
    // strip down to the short name so callers can interpolate it into
    // URL paths without producing extra path segments.
    const cluster = meta.Cluster
    const namespace = cluster?.includes('/') ? cluster.split('/').pop() : cluster
    if (!id || !namespace) throw new Error('TaskARN or Cluster missing in metadata')
    log.info({ id, namespace }, 'Resolved ECS task identity')
    return { id, namespace }
  } catch (err) {
    log.error({ err, metadataUrl }, 'Failed to read ECS task metadata')
    return null
  }
}

// ── Provider strategies ────────────────────────────────────────────────────

// K8s strategy: load the SA JWT once, refresh on expiry, send as Bearer.
async function createK8sStrategy (app, offset) {
  app.token = await loadK8sToken(app.log)

  return async function getHeaders () {
    if (app.token && isTokenExpired(app.token, offset)) {
      app.log.info('JWT token expired, reloading')
      app.token = await loadK8sToken(app.log)

      app.watt?.updateSharedContext({
        iccAuthHeaders: { authorization: `Bearer ${app.token}` }
      }).catch(err => {
        app.log.error({ err }, 'Failed to update jwt token in shared context')
      })
    }
    return { authorization: `Bearer ${app.token}` }
  }
}

// ECS strategy: resolve task identity once and send as explicit headers.
// Unauthenticated for now; future hardening will replace this with a Sigv4-
// presigned sts:GetCallerIdentity proof carried in an Authorization header.
async function createEcsStrategy (app) {
  app.machineIdentity = await resolveEcsIdentity(app.log)

  return async function getHeaders () {
    if (!app.machineIdentity) return {}
    return {
      'x-ecs-task-id': app.machineIdentity.id,
      'x-ecs-cluster': app.machineIdentity.namespace
    }
  }
}

// ── Plugin ─────────────────────────────────────────────────────────────────

async function authPlugin (app) {
  // 1 min offset to refresh the token before it actually expires.
  const offset = parseInt(process.env.PLT_JWT_EXPIRATION_OFFSET_SEC ?? 0)

  const getProviderHeaders = app.provider === 'ecs'
    ? await createEcsStrategy(app)
    : await createK8sStrategy(app, offset)

  async function getAuthorizationHeaders (headers = {}) {
    return { ...headers, ...(await getProviderHeaders()) }
  }

  function authorizationTokenInterceptor (dispatch) {
    return async function InterceptedDispatch (opts, handler) {
      opts.headers = await getAuthorizationHeaders(opts.headers)
      return dispatch(opts, handler)
    }
  }

  // Periodically call the strategy so K8s token refresh propagates to the
  // runtime shared context before requests need it. No-op for ECS.
  setInterval(getAuthorizationHeaders, offset ? offset * 1000 / 2 : 30000).unref()

  // Can't replace the global dispatcher (shared with the runtime main thread).
  app.dispatcher = new Agent().compose(authorizationTokenInterceptor)
  app.getAuthorizationHeaders = getAuthorizationHeaders
}

export default authPlugin
