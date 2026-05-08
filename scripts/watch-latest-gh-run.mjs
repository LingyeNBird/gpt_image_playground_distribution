import { execFileSync, spawnSync } from 'node:child_process'

function fail(message) {
  console.error(message)
  process.exit(1)
}

const [, , repo, workflow, delaySecondsArg] = process.argv

if (!repo || !workflow) {
  fail('Usage: node ./scripts/watch-latest-gh-run.mjs <repo> <workflow> [delaySeconds]')
}

const delaySeconds = Number(delaySecondsArg ?? '5')
if (!Number.isFinite(delaySeconds) || delaySeconds < 0) {
  fail(`Invalid delaySeconds: ${delaySecondsArg ?? ''}`)
}

await new Promise((resolve) => setTimeout(resolve, delaySeconds * 1000))

const runId = execFileSync(
  'gh',
  ['run', 'list', '--repo', repo, '--workflow', workflow, '--limit', '1', '--json', 'databaseId', '--jq', '.[0].databaseId'],
  { encoding: 'utf8' },
).trim()

if (!runId) {
  fail(`No GitHub Actions run found for workflow ${workflow}`)
}

const result = spawnSync('gh', ['run', 'watch', '--repo', repo, runId], { stdio: 'inherit' })

if (result.error) {
  throw result.error
}

process.exit(result.status ?? 0)
