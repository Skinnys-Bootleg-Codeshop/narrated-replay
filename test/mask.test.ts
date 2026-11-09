import { describe, expect, it } from 'vitest';
import { defaultMaskInput, shapeMask } from '../src/recorder/mask.js';

describe('masking', () => {
  it('records dates and emails in shape only', () => {
    expect(shapeMask('2026-11-09')).toBe('9999-99-99');
    expect(shapeMask('hello@x.com')).toBe('aaaaa@a.aaa');
    expect(defaultMaskInput('2026-11-09', { type: 'text' })).toBe('9999-99-99');
    expect(defaultMaskInput('hello@x.com', { type: 'email' })).toBe('aaaaa@a.aaa');
  });
  it('fully masks password and card fields', () => {
    expect(defaultMaskInput('hunter2', { type: 'password' })).toBe('*******');
    expect(defaultMaskInput('4111 1111', { type: 'text', autocomplete: 'cc-number' })).toBe('*********'.slice(0, 9));
  });
  it('fully masks fields whose autocomplete says password (show-password toggles)', () => {
    expect(defaultMaskInput('hunter2', { type: 'text', autocomplete: 'current-password' })).toBe('*******');
  });
  it('keeps non-ASCII letters as a', () => {
    expect(shapeMask('Zoë 7')).toBe('aaa 9');
  });
});
