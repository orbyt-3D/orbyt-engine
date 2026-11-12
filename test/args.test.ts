import { describe, expect, it } from 'vitest';
import { parseArgs } from '../src/mcp/args';
import { limitsFor, backendArgs } from '../src/mcp/host';

describe('orbyt-mcp flags', () => {
  it('parses the website command line', () => {
    expect(parseArgs(['--backend', 'gpu', '--memory', '256'])).toMatchObject({ backend: 'gpu', memory: 256 });
  });
  it('accepts --flag=value and defaults', () => {
    expect(parseArgs(['--backend=cpu'])).toMatchObject({ backend: 'cpu', memory: 256 });
    expect(parseArgs([])).toMatchObject({ backend: 'gpu', memory: 256, help: false });
  });
  it('rejects bad values', () => {
    expect(() => parseArgs(['--backend', 'tpu'])).toThrow(/gpu" or "cpu/);
    expect(() => parseArgs(['--memory', '8'])).toThrow(/>= 32/);
    expect(() => parseArgs(['--wat'])).toThrow(/Unknown option/);
    expect(() => parseArgs(['--memory'])).toThrow(/needs a value/);
  });
  it('maps memory to render limits and backends to Chromium flags', () => {
    expect(limitsFor(256).maxPixels).toBe(4 * 1024 * 1024);
    expect(limitsFor(256).maxFileBytes).toBe(128 * 1024 * 1024);
    expect(backendArgs('cpu')).toContain('--use-angle=swiftshader');
    expect(backendArgs('gpu')).toContain('--ignore-gpu-blocklist');
  });
});
