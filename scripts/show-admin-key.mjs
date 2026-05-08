import { spawnSync } from 'node:child_process'

const [, , service] = process.argv

if (!service) {
  console.error('Usage: node ./scripts/show-admin-key.mjs <service>')
  process.exit(1)
}

const result = spawnSync('docker', ['logs', service], { encoding: 'utf8' })

if (result.error) {
  throw result.error
}

const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
const matches = output
  .split(/\r?\n/)
  .filter((line) => line.includes('IMPORTANT: admin key:'))

if (matches.length === 0) {
  console.log('未找到管理员密钥日志。')
  process.exit(0)
}

for (const line of matches) {
  console.log(line)
}

process.exit(0)
