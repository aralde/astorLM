import { describe, expect, it } from 'vitest'
import {
  fingerprintError,
  jaccard,
  normalizeError,
  tokenize,
} from '../../src/experimental/error-registry/fingerprint.js'

describe('normalizeError', () => {
  it('replaces Windows paths with <PATH>/basename', () => {
    const s = normalizeError('Error: ENOENT in C:\\Users\\ariel\\proj\\src\\main.ts at line 4')
    expect(s).toContain('<path>/main.ts')
    expect(s).not.toContain('c:\\users')
  })

  it('replaces POSIX absolute paths', () => {
    const s = normalizeError('Error reading /home/user/project/foo.tf failed')
    expect(s).toContain('<path>/foo.tf')
    expect(s).not.toContain('/home/user')
  })

  it('strips UUIDs, IPs, and ARN/account ids', () => {
    const s = normalizeError(
      'request id 550e8400-e29b-41d4-a716-446655440000 from 10.0.0.5 to arn:aws:iam::123456789012:role/foo',
    )
    expect(s).toContain('<uuid>')
    expect(s).toContain('<ip>')
    expect(s).toContain('<arn>')
    // The account id is already consumed inside the ARN.
  })

  it('produces identical fingerprints for trivial variants of the same error', () => {
    const a = normalizeError(
      'Error: AccessDenied to s3://bucket-abc on 2024-03-12T10:11:12Z by 123456789012',
    )
    const b = normalizeError(
      'Error: AccessDenied to s3://bucket-abc on 2026-01-01T00:00:00Z by 987654321098',
    )
    expect(fingerprintError(a, 'bash')).toBe(fingerprintError(b, 'bash'))
  })

  it('produces different fingerprints when the tool changes', () => {
    const n = normalizeError('boom')
    expect(fingerprintError(n, 'bash')).not.toBe(fingerprintError(n, 'edit'))
  })
})

describe('jaccard', () => {
  it('scores high when token sets overlap', () => {
    const a = tokenize('terraform iam permission denied passrole eu-west-3')
    const b = tokenize('terraform iam permission denied passrole us-east-1')
    expect(jaccard(a, b)).toBeGreaterThan(0.4)
  })

  it('returns 0 when token sets do not overlap', () => {
    const a = tokenize('foo bar')
    const b = tokenize('baz qux')
    expect(jaccard(a, b)).toBe(0)
  })
})
