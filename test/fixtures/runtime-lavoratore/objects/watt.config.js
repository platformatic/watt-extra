export default {
  module: './capability.js',
  $schema: 'https://schemas.platformatic.dev/@platformatic/lavoratore/0.6.0.json',
  node: { main: 'index.js' },
  lavoratore: { durableObjects: { placement: { type: 'coordinator' } } }
}
