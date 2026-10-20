export async function getMessage (name) {
  'use cache'
  return `Hello ${name}`
}
