import { describe, expect, it } from 'vitest';
import { Reflector } from '@nestjs/core';
import { FEATURE_META } from '../src/auth/access.decorator.js';
import { AssistantCaptureController } from '../src/captures/captures.controller.js';

/** #1090: "Save to knowledge base" on a reply is gone with the `captures` section, as the inbox is. */
describe('assistant reply capture', () => {
  it('carries the captures section', () => {
    const feature = new Reflector().getAllAndOverride(FEATURE_META, [
      AssistantCaptureController.prototype.capture,
      AssistantCaptureController,
    ]);
    expect(feature).toBe('captures');
  });
});
