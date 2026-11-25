export default {
  extensions: [{ path: '../../../index.js' }],
  applications: [{ id: 'composer', path: 'composer' }, { id: 'alpha', path: 'alpha' }, { id: 'beta', path: 'beta' }],
  logger: { level: 'error' }, httpCache: { cacheTagsHeader: 'x-custom-cache-tags' }
}
