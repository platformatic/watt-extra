import { defineConfig, globalIgnores } from 'eslint/config'
import neostandard from 'neostandard'

const ignores = [
  ...neostandard.resolveIgnoresFromGitignore(),
  'clients/**/*',
  'test/fixtures/**/*',
  'test/tmp/**/*',
  'node_modules/**/*'
]

// neostandard's `ignores` only scopes its own rules, so the list must also be
// declared as global ignores or ESLint still visits those files.
export default defineConfig([
  globalIgnores(ignores),
  ...neostandard({ ignores })
])
