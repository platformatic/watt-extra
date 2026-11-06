export default {
  module: '@platformatic/service', server: { hostname: '127.0.0.1', port: 3042 },
  service: { openapi: true }, plugins: { paths: [{ path: './plugins', encapsulate: false }, './routes'] }
}
