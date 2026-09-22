#!/usr/bin/env node
import commist from 'commist'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import helpMeInit from 'help-me'
import { readFileSync } from 'node:fs'
import { once } from 'node:events'
import { start, logger } from './index.js'
import { getSimpleBanner } from './lib/banner.js'
import { applyStartArgs } from './lib/start-args.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const helpMe = helpMeInit({
  dir: join(__dirname, 'help'),
  ext: '.txt'
})

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
const commistInstance = commist()

async function writeHelpPage (page = 'watt-extra') {
  try {
    for await (const chunk of helpMe.createStream(page)) {
      if (!process.stdout.write(chunk)) {
        await once(process.stdout, 'drain')
      }
    }
  } catch {
    process.stdout.write(`no such help file: ${page}.\n\n`)
    if (page !== 'watt-extra') {
      await writeHelpPage()
    }
  }
}

function version () {
  if (process.stdout.isTTY) {
    console.log(getSimpleBanner(pkg.version))
  } else {
    logger.info(`WattExtra v${pkg.version}`)
  }
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
    await writeHelpPage('start')
    return true
  }

  await start()
  return true
}

// Handle help command
async function help (args) {
  // Make sure args exists and has the expected structure
  const command = args && args._ ? args._[0] : undefined
  await writeHelpPage(command || 'watt-extra')
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
      await writeHelpPage()
      return
    }

    // Handle help flag directly
    if (args[0] === '--help' || args[0] === '-h') {
      await writeHelpPage()
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
        await writeHelpPage(subcommand || 'watt-extra')
        return
      }

      if (command === 'version') {
        version()
        return
      }

      logger.error(`Command "${command}" does not exist`)
      await writeHelpPage()
      process.exit(1)
    }

    await commistInstance.parseAsync(args)
  } catch (err) {
    logger.error({ err }, 'Error running watt-extra')
    process.exit(1)
  }
}

await run()
