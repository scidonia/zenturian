// Loopback HTTP helpers shared by the payroll components.
//
// The prototype has no transport abstraction; services bind 127.0.0.1:0 and
// return their bound URL so callers and tests never hard-code a port.

import {
  createServer as createHttpServer,
  request as createHttpRequest,
} from 'node:http';

export const MAX_BODY_BYTES = 1024 * 1024;

export class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}

export function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

export function sendError(res, status, code, message) {
  sendJson(res, status, { error: { code, message } });
}

export async function readJsonBody(req, limit = MAX_BODY_BYTES) {
  const contentType = req.headers['content-type'] ?? '';
  if (!contentType.toLowerCase().startsWith('application/json')) {
    throw new HttpError(
      415,
      'unsupported_media_type',
      'content-type must be application/json',
    );
  }

  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      req.destroy();
      throw new HttpError(413, 'body_too_large', `request body exceeds ${limit} bytes`);
    }
    chunks.push(chunk);
  }

  if (size === 0) {
    throw new HttpError(400, 'invalid_json', 'request body is required');
  }

  let value;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'invalid_json', 'request body must be valid JSON');
  }

  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(400, 'invalid_json', 'request body must be a JSON object');
  }

  return value;
}

export function requireString(container, field) {
  const value = container?.[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new HttpError(400, 'invalid_args', `args.${field} must be a non-empty string`);
  }
  return value;
}

export function listen(server, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once('error', onError);
    server.listen(0, host, () => {
      server.removeListener('error', onError);
      const address = server.address();
      if (address === null || typeof address !== 'object') {
        reject(new Error('server did not report a bound TCP address'));
        return;
      }
      resolve({
        server,
        host,
        port: address.port,
        url: `http://${host}:${address.port}`,
        close: () => closeServer(server),
      });
    });
  });
}

export function closeServer(server) {
  return new Promise((resolve, reject) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

export async function createServiceServer(handler) {
  const server = createHttpServer((req, res) => {
    Promise.resolve()
      .then(() => handler(req, res))
      .catch((error) => {
        if (res.headersSent) {
          res.destroy();
          return;
        }
        if (error instanceof HttpError) {
          sendError(res, error.status, error.code, error.message);
          return;
        }
        console.error(error);
        sendError(res, 500, 'internal_error', 'unexpected server error');
      });
  });

  return listen(server);
}

export function requestJson(url, options = {}) {
  const {
    method = 'GET',
    headers = {},
    body,
    timeoutMs = 5000,
  } = options;
  const target = new URL(url);
  const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
  const requestHeaders = {
    connection: 'close',
    ...headers,
  };

  if (payload !== null) {
    requestHeaders['content-type'] = 'application/json';
    requestHeaders['content-length'] = payload.length;
  }

  const requestOptions = {
    method,
    hostname: target.hostname,
    port: target.port,
    path: `${target.pathname}${target.search}`,
    headers: requestHeaders,
    agent: false,
  };

  return new Promise((resolve, reject) => {
    const req = createHttpRequest(requestOptions, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        if (text.length > 0) {
          try {
            parsed = JSON.parse(text);
          } catch {
            parsed = text;
          }
        }
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: parsed,
        });
      });
    });

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`request to ${url} timed out after ${timeoutMs}ms`));
    });
    req.on('error', reject);
    if (payload !== null) {
      req.write(payload);
    }
    req.end();
  });
}
