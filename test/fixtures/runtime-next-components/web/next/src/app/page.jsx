import { connection } from 'next/server'
import { Suspense } from 'react'
import { getMessage } from '../lib/message.js'

export default function Home () {
  return (
    <Suspense fallback={null}>
      <Message />
    </Suspense>
  )
}

// Waiting for a request avoids calling the cached function during the build
async function Message () {
  await connection()
  return <div>{await getMessage('watt-extra')}</div>
}
