import { expect, it } from 'vitest'
import { CaptureRetention } from '../src/capture-retention.ts'

it('bounds live previews while retaining tool screenshots until Host disposal', async () => {
  const removed: string[] = []
  const retention = new CaptureRetention(2, async path => { removed.push(path) })
  await retention.record('tool-shot.png', false)
  await retention.record('preview-1.png', true)
  await retention.record('preview-2.png', true)
  await retention.record('preview-3.png', true)
  expect(removed).toEqual(['preview-1.png'])

  await retention.dispose()
  expect(removed.sort()).toEqual([
    'preview-1.png', 'preview-2.png', 'preview-3.png', 'tool-shot.png',
  ].sort())

  // A capture already in flight when the Host stops must also be removed.
  await retention.record('late-preview.png', true)
  expect(removed).toContain('late-preview.png')
})
