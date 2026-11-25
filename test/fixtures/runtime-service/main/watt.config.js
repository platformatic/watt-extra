export default {
  module: '@platformatic/service',
  server: { hostname: '127.0.0.1', port: 3042, trustProxy: false },
  plugins: { paths: ['./routes'] }
}
