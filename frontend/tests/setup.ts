import { afterEach, beforeEach, vi } from 'vitest';
import { config } from '@vue/test-utils';

config.global.stubs = { transition: false };

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = '';
  document.documentElement.removeAttribute('data-theme');
  vi.restoreAllMocks();
  vi.stubGlobal('scrollTo', vi.fn());
});

afterEach(() => vi.unstubAllGlobals());
