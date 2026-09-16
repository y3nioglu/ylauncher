import { strict as assert } from 'node:assert'
import { PERF_PRESETS, getPreset } from '../src/shared/perfPresets'

assert.equal(PERF_PRESETS.length, 3)
assert.equal(getPreset('low').id, 'low')
assert.equal(getPreset(undefined).id, 'balanced')
assert.equal(getPreset('bilmemne' as never).id, 'balanced')
for (const p of PERF_PRESETS) {
  assert.ok(p.args.length > 0, `${p.id} arguman ici bos olamaz`)
  assert.ok(p.label.length > 3)
}

console.log('perfPresets.ts testleri OK')
