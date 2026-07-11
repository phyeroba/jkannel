'use strict';

const http = require('node:http');
const https = require('node:https');
const { URL } = require('node:url');
const { performance } = require('node:perf_hooks');

/**
 * Minimal, dependency-free HTTP client for the load harness. Uses a keep-alive
 * agent so connection reuse mirrors a real API client and the reverse proxy /
 * backend keep-alive path is actually exercised.
 */
function makeAgent(isHttps) {
  const Agent = isHttps ? https.Agent : http.Agent;
  return new Agent({ keepAlive: true, maxSockets: 4096, maxFreeSockets: 512 });
}

class Client {
  constructor(baseUrl, apiPrefix) {
    this.base = new URL(baseUrl);
    this.isHttps = this.base.protocol === 'https:';
    this.transport = this.isHttps ? https : http;
    this.agent = makeAgent(this.isHttps);
    this.apiPrefix = apiPrefix ?? '/api/v1';
    this.token = null;
  }

  /** Absolute path for an API route, prefixed with the global API prefix. */
  apiPath(path) {
    const p = path.startsWith('/') ? path : `/${path}`;
    return `${this.apiPrefix}${p}`;
  }

  /**
   * Performs one request. Resolves with { status, ms, ok, body, reason }.
   * Never rejects — network/timeout failures resolve with ok:false so the
   * runner records them as errors rather than crashing a virtual user.
   */
  request(method, path, { body, headers, timeoutMs = 30000, expect } = {}) {
    const url = new URL(path, this.base);
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const hdrs = {
      accept: 'application/json',
      'user-agent': 'jkannel-perf/1.0',
      ...(headers || {}),
    };
    if (this.token) hdrs.authorization = `Bearer ${this.token}`;
    if (payload !== undefined) {
      hdrs['content-type'] = 'application/json';
      hdrs['content-length'] = Buffer.byteLength(payload);
    }
    const options = {
      method,
      hostname: url.hostname,
      port: url.port || (this.isHttps ? 443 : 80),
      path: `${url.pathname}${url.search}`,
      headers: hdrs,
      agent: this.agent,
    };

    return new Promise((resolve) => {
      const start = performance.now();
      const finish = (status, ok, bodyText, reason) =>
        resolve({
          status,
          ms: performance.now() - start,
          ok,
          body: bodyText,
          reason,
        });

      const req = this.transport.request(options, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          const codeOk = res.statusCode >= 200 && res.statusCode < 400;
          const ok = expect ? res.statusCode === expect : codeOk;
          finish(
            res.statusCode,
            ok,
            text,
            ok ? undefined : `http_${res.statusCode}`,
          );
        });
      });
      req.on('error', (err) => finish(0, false, '', `neterr_${err.code || err.message}`));
      req.setTimeout(timeoutMs, () => {
        req.destroy(new Error('timeout'));
        finish(0, false, '', 'timeout');
      });
      if (payload !== undefined) req.write(payload);
      req.end();
    });
  }

  /** Unwraps the JKANNEL response envelope ({ success, data, ... }). */
  static data(bodyText) {
    try {
      const parsed = JSON.parse(bodyText);
      return parsed && typeof parsed === 'object' && 'data' in parsed ? parsed.data : parsed;
    } catch {
      return undefined;
    }
  }

  /**
   * Authenticates and stores the bearer token on the client.
   * POST {prefix}/auth/login -> data.accessToken.
   */
  async login(tenant, username, password) {
    const res = await this.request('POST', this.apiPath('/auth/login'), {
      body: { tenant, username, password },
      expect: 201,
    });
    // Login may respond 200 or 201 depending on Nest defaults; accept any 2xx.
    if (res.status < 200 || res.status >= 300) {
      throw new Error(
        `login failed: HTTP ${res.status} ${res.body?.slice(0, 200) || res.reason || ''}`,
      );
    }
    const data = Client.data(res.body);
    const token = data && (data.accessToken || data.access_token);
    if (!token) throw new Error(`login response had no accessToken: ${res.body?.slice(0, 200)}`);
    this.token = token;
    return token;
  }

  destroy() {
    this.agent.destroy();
  }
}

module.exports = { Client };
