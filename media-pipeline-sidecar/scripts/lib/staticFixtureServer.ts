import http from 'node:http';

export interface StaticFixtureServerOptions {
  pathname: string;
  contentType: string;
  body: Buffer;
  latencyMs?: number;
}

export interface StaticFixtureServer {
  server: http.Server;
  port: number;
  url: string;
}

export async function createStaticFixtureServer(options: StaticFixtureServerOptions): Promise<StaticFixtureServer> {
  const server = await createServer((req, res) => {
    if (req.method !== 'GET' || req.url !== options.pathname) {
      res.statusCode = 404;
      res.end('Not found');
      return;
    }

    const respond = () => {
      res.statusCode = 200;
      res.setHeader('content-type', options.contentType);
      res.setHeader('content-length', String(options.body.byteLength));
      res.end(options.body);
    };

    if (options.latencyMs && options.latencyMs > 0) {
      setTimeout(respond, options.latencyMs);
      return;
    }

    respond();
  });

  return {
    server: server.server,
    port: server.port,
    url: `http://127.0.0.1:${server.port}${options.pathname}`
  };
}

export async function closeFixtureServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

function createServer(handler: http.RequestListener): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('Failed to allocate server port'));
        return;
      }
      resolve({ server, port: addr.port });
    });
  });
}
