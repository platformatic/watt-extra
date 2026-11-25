export default {
  extensions: [{ path: '../../../index.js' }],
  applications: [{ id: 'main', path: 'main' }], logger: { level: 'error' },
  tracing: {
    enabled: true, applicationName: 'user-custom-name',
    exporter: { type: 'otlp', options: { url: 'http://jaeger:4318/v1/traces' } },
    skip: [{ method: 'GET', path: '/health' }]
  }
}
