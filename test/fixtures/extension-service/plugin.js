export default async function (app) {
  app.get('/', async request => ({
    ok: true,
    ip: request.ip,
    deploymentVersion: process.env.PLT_DEPLOYMENT_VERSION
  }))
}
