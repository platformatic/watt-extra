export default {
  module: '@platformatic/service', service: { openapi: true },
  plugins: { paths: [{ path: './plugins', encapsulate: false }, './routes'] }
}
