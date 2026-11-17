// Stand-in `loadout-ml embed --model <dir>` for the window checks: no model, a bag of hashed words per text (64 numbers, unit
// length), so texts sharing words come out close. It refuses a model folder without both files, like the real program.
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

const dir = process.argv[process.argv.indexOf('--model') + 1]
if (process.argv[2] !== 'embed' || !dir || !['model.onnx', 'tokenizer.json'].every((f) => existsSync(join(dir, f)))) {
  console.error('fake-ml: usage or model folder')
  process.exit(2)
}
for await (const line of createInterface({ input: process.stdin })) {
  if (!line.trim()) continue
  const v = new Array(64).fill(0)
  for (const w of JSON.parse(line).toLowerCase().split(/[^a-z0-9а-яё]+/).filter(Boolean)) {
    let h = 0
    for (const c of w) h = (h * 31 + c.charCodeAt(0)) % 64
    v[h] += 1
  }
  const n = Math.hypot(...v) || 1
  process.stdout.write(JSON.stringify(v.map((x) => x / n)) + '\n')
}
