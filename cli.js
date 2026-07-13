#!/usr/bin/env node
import commist from 'commist'
import minimist from 'minimist'
import { resolve, join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import helpMeInit from 'help-me'
import { readFileSync } from 'node:fs'
import { start, logger } from './index.js'
import { getSimpleBanner } from './lib/banner.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const helpMe = helpMeInit({
  dir: join(__dirname, 'help'),
  ext: '.txt'
})

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
const commistInstance = commist()

function version () {
  if (process.stdout.isTTY) {
    console.log(getSimpleBanner(pkg.version))
  } else {
    logger.info(`WattExtra v${pkg.version}`)
  }
}

// Parse start command argv and apply CLI options to env.
// Precedence for PLT_LOG_LEVEL: --log-level flag > pre-set env > 'info' default.
// Do NOT add a minimist default for `log-level`: that would make args['log-level']
// always truthy and unconditionally clobber an env-provided value.
export function applyStartArgs (argv, env = process.env) {
  const args = minimist(argv, {
    alias: {
      h: 'help',
      l: 'log-level',
      i: 'icc-url',
      a: 'app-name',
      d: 'app-dir'
    },
    boolean: ['help'],
    string: ['log-level', 'icc-url', 'app-name', 'app-dir'],
    default: {
      'app-dir': process.cwd()
    }
  })

  if (args.help) {
    return { args, help: true }
  }

  if (args['log-level']) {
    env.PLT_LOG_LEVEL = args['log-level']
  } else if (!env.PLT_LOG_LEVEL) {
    env.PLT_LOG_LEVEL = 'info'
  }

  if (args['icc-url']) {
    env.PLT_ICC_URL = args['icc-url']
  }

  if (args['app-name']) {
    env.PLT_APP_NAME = args['app-name']
  }

  if (args['app-dir']) {
    env.PLT_APP_DIR = resolve(args['app-dir']) // Ensure the path is absolute
  }

  return { args, help: false }
}

// Handle start command
async function startCommand (argv) {
  if (process.stdout.isTTY) {
    console.log(getSimpleBanner(pkg.version))
  } else {
    logger.info(`WattExtra v${pkg.version}`)
  }

  const { args, help } = applyStartArgs(argv)

  logger.debug({ args, argv }, 'Start command arguments')

  if (help) {
    helpMe.toStdout('start')
    return true
  }

  await start()
  return true
}

// Handle help command
function help (args) {
  // Make sure args exists and has the expected structure
  const command = args && args._ ? args._[0] : undefined
  helpMe.toStdout(command || 'watt-extra')
}

// Register commands
commistInstance.register('start', startCommand)
commistInstance.register('help', help)
commistInstance.register('version', version)
commistInstance.register('-h', help)
commistInstance.register('--help', help)

async function run () {
  try {
    logger.debug('Parsing command line arguments')
    const args = process.argv.slice(2)

    // Show help if no arguments are provided
    if (args.length === 0) {
      helpMe.toStdout('watt-extra')
      return
    }

    // Handle help flag directly
    if (args[0] === '--help' || args[0] === '-h') {
      helpMe.toStdout('watt-extra')
      return
    }

    // Handle the case where the first argument is a recognized command
    if (args.length > 0) {
      const command = args[0]

      if (command === 'start') {
        // Pass the rest of the arguments to the start command
        await startCommand(args.slice(1))
        return
      }

      if (command === 'help') {
        // Handle the 'help' command with optional subcommand
        const subcommand = args[1]
        helpMe.toStdout(subcommand || 'watt-extra')
        return
      }

      if (command === 'version') {
        version()
        return
      }

      logger.error(`Command "${command}" does not exist`)
      helpMe.toStdout('watt-extra')
      process.exit(1)
    }

    await commistInstance.parseAsync(args)
  } catch (err) {
    logger.error({ err }, 'Error running watt-extra')
    process.exit(1)
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run()
}
