import { describe, expect, it } from 'vitest';
import { apiKeyScopeOf, captureStateFor } from '@knowledge/contracts';
import { resolveCaptureSettings, type CaptureSettingsRow } from '../src/ai/capture-settings.js';
import { projectPinOf } from '../src/auth/api-keys.service.js';

/**
 * Agent-session memory, phase 1 (issue #73): the pieces later phases read.
 *
 * 1. **Env is a ceiling for the switch and the limits** — a workspace may ask
 *    for less, never more, and a clamp says so (`source: 'clamped'`).
 * 2. **The thresholds are tuning, not ceilings**, but amend never sits above
 *    dedupe.
 * 3. **A stored key scope never widens** — an unknown value reads as `read`.
 * 4. **A capture's shown state is derived** from its merge request.
 */

const ENV = { enabled: true, perKeyPerHour: 30, perWorkspacePerDay: 500, dedupeThreshold: 0.92, amendThreshold: 0.8 };

const row = (over: Partial<CaptureSettingsRow> = {}): CaptureSettingsRow => ({
  captureEnabled: null,
  capturePerKeyPerHour: null,
  capturePerWorkspacePerDay: null,
  captureDedupeThreshold: null,
  captureAmendThreshold: null,
  captureParentDocumentId: null,
  ...over,
});

describe('resolveCaptureSettings', () => {
  it('reproduces the env exactly with no row, or an empty one', () => {
    for (const settings of [resolveCaptureSettings(null, ENV), resolveCaptureSettings(row(), ENV)]) {
      expect(settings.enabled).toEqual({ requested: null, ceiling: true, effective: true, source: 'env' });
      expect(settings.perKeyPerHour).toEqual({ requested: null, ceiling: 30, effective: 30, source: 'env' });
      expect(settings.dedupeThreshold).toEqual({ requested: null, effective: 0.92, source: 'env' });
      expect(settings.amendThreshold.effective).toBe(0.8);
      expect(settings.parentDocumentId).toBeNull();
    }
  });

  it('lets a workspace ask for less than the ceiling', () => {
    const settings = resolveCaptureSettings(row({ captureEnabled: false, capturePerKeyPerHour: 5 }), ENV);
    expect(settings.enabled).toMatchObject({ requested: false, effective: false, source: 'db' });
    expect(settings.perKeyPerHour).toMatchObject({ requested: 5, effective: 5, source: 'db' });
  });

  it('clamps a workspace asking for more, and says so', () => {
    const settings = resolveCaptureSettings(
      row({ captureEnabled: true, capturePerKeyPerHour: 1000, capturePerWorkspacePerDay: 10_000 }),
      { ...ENV, enabled: false },
    );
    expect(settings.enabled).toEqual({ requested: true, ceiling: false, effective: false, source: 'clamped' });
    expect(settings.perKeyPerHour).toEqual({ requested: 1000, ceiling: 30, effective: 30, source: 'clamped' });
    expect(settings.perWorkspacePerDay).toMatchObject({ effective: 500, source: 'clamped' });
  });

  it('treats a zero limit as a real setting, not as inherit', () => {
    expect(resolveCaptureSettings(row({ capturePerKeyPerHour: 0 }), ENV).perKeyPerHour).toMatchObject({
      effective: 0,
      source: 'db',
    });
  });

  it('lets the thresholds move either way, but never amend above dedupe', () => {
    const raised = resolveCaptureSettings(row({ captureDedupeThreshold: 0.97, captureAmendThreshold: 0.9 }), ENV);
    expect(raised.dedupeThreshold).toMatchObject({ effective: 0.97, source: 'db' });
    expect(raised.amendThreshold).toMatchObject({ effective: 0.9, source: 'db' });
    const inverted = resolveCaptureSettings(row({ captureDedupeThreshold: 0.7 }), ENV);
    expect(inverted.amendThreshold).toMatchObject({ requested: null, effective: 0.7 });
  });
});

describe('apiKeyScopeOf', () => {
  it('passes the known scopes and reads anything else as read', () => {
    expect(apiKeyScopeOf('read')).toBe('read');
    expect(apiKeyScopeOf('capture')).toBe('capture');
    expect(apiKeyScopeOf('write')).toBe('write');
    expect(apiKeyScopeOf('admin')).toBe('read');
    expect(apiKeyScopeOf('')).toBe('read');
  });
});

describe('projectPinOf', () => {
  it('is a non-empty id list or null', () => {
    expect(projectPinOf(null)).toBeNull();
    expect(projectPinOf([])).toBeNull();
    expect(projectPinOf({ a: 1 })).toBeNull();
    expect(projectPinOf(['p1', 7, 'p2'])).toEqual(['p1', 'p2']);
  });
});

describe('captureStateFor', () => {
  it('reads a proposed capture through its merge request and leaves every other status alone', () => {
    expect(captureStateFor('proposed', 'open')).toBe('proposed');
    expect(captureStateFor('proposed', 'merged')).toBe('merged');
    expect(captureStateFor('proposed', 'closed')).toBe('closed');
    expect(captureStateFor('proposed', null)).toBe('proposed');
    expect(captureStateFor('duplicate', 'merged')).toBe('duplicate');
    expect(captureStateFor('staged', undefined)).toBe('staged');
  });
});
