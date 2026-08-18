import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Guards the hardcoded runtime-container catalogue against docker-compose.yml
 * drifting away from it.
 *
 * THE FAILURE THIS PREVENTS, WHICH ALREADY HAPPENED ONCE
 * ---------------------------------------------------------------------------
 * `RuntimeContainersService` returns a list of Compose services written as
 * TypeScript string literals — the backend has no Docker socket, so it cannot
 * enumerate anything. That list had fallen seven services behind Compose:
 * reverse-proxy, reverse-proxy-tls, scheduler, backup-service, watchdog, loki
 * and promtail were all missing.
 *
 * A catalogue that is a SUBSET of reality is worse than no catalogue. An
 * operator reads the screen, concludes that is the estate, and never asks why
 * the backup service is not on it. Nothing in the code or the UI could have
 * told them otherwise.
 *
 * So this re-derives the service list from `docker-compose.yml` on every run
 * and asserts the catalogue covers it. Add a Compose service without adding it
 * here and this test fails, which is the point.
 */
const REPO_ROOT = resolve(__dirname, '../../..');
const COMPOSE = resolve(REPO_ROOT, 'docker-compose.yml');
const CATALOGUE = resolve(__dirname, 'runtime-containers.service.ts');

/**
 * Top-level service keys under `services:`.
 *
 * Parsed by indentation rather than with a YAML library: the file also has
 * top-level `networks:` and `volumes:` blocks whose keys sit at the same depth,
 * so the section boundary is what distinguishes them.
 */
function composeServices(): string[] {
  const lines = readFileSync(COMPOSE, 'utf8').split('\n');
  const names: string[] = [];
  let inServices = false;
  for (const line of lines) {
    if (/^services:\s*$/.test(line)) {
      inServices = true;
      continue;
    }
    // Any other top-level key ends the services block.
    if (inServices && /^[a-zA-Z]/.test(line)) break;
    if (!inServices) continue;
    const match = /^ {2}([a-z][a-z0-9._-]*):\s*$/.exec(line);
    if (match) names.push(match[1]);
  }
  return names.sort();
}

/** `service: '...'` literals in the catalogue. */
function catalogueServices(): string[] {
  const source = readFileSync(CATALOGUE, 'utf8');
  return [...source.matchAll(/^\s*service: '([a-z][a-z0-9._-]*)',$/gm)]
    .map((match) => match[1])
    .sort();
}

describe('the runtime container catalogue', () => {
  const compose = composeServices();
  const catalogue = catalogueServices();

  it('finds the Compose services at all', () => {
    // Sanity check on the parser: if this returned nothing, the completeness
    // assertion below would pass vacuously.
    expect(compose.length).toBeGreaterThan(10);
    expect(compose).toContain('backend');
    expect(compose).toContain('postgres');
    // And it must NOT have picked up network or volume names.
    expect(compose).not.toContain('appnet');
    expect(compose).not.toContain('postgres-data');
  });

  it('covers every service declared in docker-compose.yml', () => {
    const missing = compose.filter((service) => !catalogue.includes(service));
    expect(missing).toEqual([]);
  });

  it('names the seven services that were missing before', () => {
    for (const service of [
      'reverse-proxy',
      'reverse-proxy-tls',
      'scheduler',
      'backup-service',
      'watchdog',
      'loki',
      'promtail',
    ])
      expect(catalogue).toContain(service);
  });

  it('does not invent a service Compose has never heard of', () => {
    // Drift in the other direction: a row for something that does not exist is
    // just as misleading as a missing one.
    const invented = catalogue.filter((service) => !compose.includes(service));
    expect(invented).toEqual([]);
  });

  it('states in the payload that it is a catalogue, not an enumeration', () => {
    const source = readFileSync(CATALOGUE, 'utf8');
    // A caller must be able to tell "these are the services we declare" from
    // "these are the containers that are running", without reading our code.
    expect(source).toContain("source: 'declared-catalogue'");
    expect(source).toMatch(/not an enumeration of running containers/);
  });
});
