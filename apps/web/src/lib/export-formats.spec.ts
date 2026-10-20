import { describe, expect, it } from 'vitest'
import { publicShareExportPath, publicShareExportsPath } from '@knowledge/contracts/publishing'
import { exportFormatAvailable } from './export-formats'

/**
 * The format rule the app's export dialog and the share reader's download
 * share (docs/features/45, #161), and the reader's export URLs.
 */
describe('exportFormatAvailable', () => {
  it('follows what the deployment reports', () => {
    const formats = { zip: true, html: false, pdf: true }
    expect(exportFormatAvailable(formats, 'zip')).toBe(true)
    expect(exportFormatAvailable(formats, 'html')).toBe(false)
    expect(exportFormatAvailable(formats, 'pdf')).toBe(true)
  })

  it('assumes ZIP and HTML but never PDF before the answer arrives', () => {
    expect(exportFormatAvailable(undefined, 'zip')).toBe(true)
    expect(exportFormatAvailable(null, 'html')).toBe(true)
    expect(exportFormatAvailable(undefined, 'pdf')).toBe(false)
  })
})

describe('share export paths', () => {
  it('hang off the token, encoded, with the download as its own segment', () => {
    expect(publicShareExportsPath('kp_a/b')).toBe('/v1/public/shares/kp_a%2Fb/exports')
    expect(publicShareExportPath('kp_x', 'job-1')).toBe('/v1/public/shares/kp_x/exports/job-1')
    expect(publicShareExportPath('kp_x', 'job-1', true)).toBe('/v1/public/shares/kp_x/exports/job-1/download')
  })
})
