import { describe, expect, it } from 'vitest'
import { createErrorRegistry } from '../../src/experimental/error-registry/registry.js'
import type { ErrorContext } from '../../src/experimental/error-registry/types.js'

const ctx: ErrorContext = {
  cwd: '/tmp/proj',
  osPlatform: 'linux',
  nodeVersion: 'v20.0.0',
  tags: ['terraform'],
}

// Mismo error en dos cuentas/UUIDs/timestamps distintos pero misma forma.
// Lo que el normalizer borra: account ID, UUID, timestamp, paths.
const TF_ERROR_A = `Error at 2024-03-12T10:11:12Z: IAM principal 123456789012 cannot assume role (request 550e8400-e29b-41d4-a716-446655440000). PassRole permission missing in C:\\proj\\main.tf`
const TF_ERROR_B = `Error at 2026-01-01T00:00:00Z: IAM principal 987654321098 cannot assume role (request 11111111-2222-3333-4444-555555555555). PassRole permission missing in /home/user/main.tf`
const UNRELATED = `Error: cannot find module 'react' in /home/user/foo/bar.js`

describe('createErrorRegistry (in-memory, fuzzy mode)', () => {
  it('devuelve null si no hay entries previas', async () => {
    const r = createErrorRegistry({ hitThreshold: 0.6 })
    await r.init()
    const hit = await r.query({ rawError: TF_ERROR_A, toolName: 'bash', context: ctx })
    expect(hit).toBeNull()
  })

  it('matchea variantes del mismo error por fingerprint exacto', async () => {
    const r = createErrorRegistry({ hitThreshold: 0.6 })
    await r.init()
    await r.ensureEntry({ rawError: TF_ERROR_A, toolName: 'bash', context: ctx })
    const hit = await r.query({ rawError: TF_ERROR_B, toolName: 'bash', context: ctx })
    expect(hit).not.toBeNull()
    expect(hit!.score).toBe(1)
  })

  it('no matchea un error totalmente distinto', async () => {
    const r = createErrorRegistry({ hitThreshold: 0.6 })
    await r.init()
    await r.ensureEntry({ rawError: TF_ERROR_A, toolName: 'bash', context: ctx })
    const hit = await r.query({ rawError: UNRELATED, toolName: 'bash', context: ctx })
    expect(hit).toBeNull()
  })

  it('expone resoluciones aprobadas y oculta las pending/rejected', async () => {
    const r = createErrorRegistry({ hitThreshold: 0.6 })
    await r.init()
    const entry = await r.ensureEntry({ rawError: TF_ERROR_A, toolName: 'bash', context: ctx })

    const pend = await r.recordResolution({
      entryId: entry.id,
      description: 'agregar iam:PassRole al principal',
      toolCalls: [{ name: 'edit', input: { path: 'main.tf', oldString: 'x', newString: 'y' } }],
    })
    let hit = await r.query({ rawError: TF_ERROR_A, toolName: 'bash', context: ctx })
    expect(hit!.approvedResolutions).toHaveLength(0)

    await r.approveResolution(pend.id, 'ariel@example.com')
    hit = await r.query({ rawError: TF_ERROR_A, toolName: 'bash', context: ctx })
    expect(hit!.approvedResolutions).toHaveLength(1)
    expect(hit!.approvedResolutions[0].approvedBy).toBe('ariel@example.com')
  })

  it('rankea por successCount desc cuando hay varias aprobadas', async () => {
    const r = createErrorRegistry({ hitThreshold: 0.6 })
    await r.init()
    const entry = await r.ensureEntry({ rawError: TF_ERROR_A, toolName: 'bash', context: ctx })

    const r1 = await r.recordResolution({ entryId: entry.id, description: 'sol 1', toolCalls: [] })
    const r2 = await r.recordResolution({ entryId: entry.id, description: 'sol 2', toolCalls: [] })
    await r.approveResolution(r1.id, 'a')
    await r.approveResolution(r2.id, 'b')
    await r.noteSuccessfulReuse(r2.id)
    await r.noteSuccessfulReuse(r2.id)
    await r.noteSuccessfulReuse(r1.id)

    const hit = await r.query({ rawError: TF_ERROR_A, toolName: 'bash', context: ctx })
    expect(hit!.approvedResolutions[0].description).toBe('sol 2')
    expect(hit!.approvedResolutions[0].successCount).toBe(2)
  })

  it('rejectResolution la excluye de approvedResolutions', async () => {
    const r = createErrorRegistry({ hitThreshold: 0.6 })
    await r.init()
    const entry = await r.ensureEntry({ rawError: TF_ERROR_A, toolName: 'bash', context: ctx })
    const res = await r.recordResolution({ entryId: entry.id, description: 'mala idea', toolCalls: [] })
    await r.rejectResolution(res.id, 'no funciona en eu-west')
    const hit = await r.query({ rawError: TF_ERROR_A, toolName: 'bash', context: ctx })
    expect(hit!.approvedResolutions).toHaveLength(0)
  })

  it('listPending sólo devuelve resoluciones pending', async () => {
    const r = createErrorRegistry({ hitThreshold: 0.6 })
    await r.init()
    const entry = await r.ensureEntry({ rawError: TF_ERROR_A, toolName: 'bash', context: ctx })
    const p1 = await r.recordResolution({ entryId: entry.id, description: 'a', toolCalls: [] })
    const p2 = await r.recordResolution({ entryId: entry.id, description: 'b', toolCalls: [] })
    await r.approveResolution(p1.id, 'x')
    const pending = r.listPending()
    expect(pending).toHaveLength(1)
    expect(pending[0].resolution.id).toBe(p2.id)
  })
})
