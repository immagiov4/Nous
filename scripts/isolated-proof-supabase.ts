import { cp, mkdir, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { join } from 'node:path';

async function availablePorts(): Promise<Record<'api' | 'db' | 'shadow', number>> {
  const reservations: Server[] = [];
  const ports = { api: 0, db: 0, shadow: 0 };
  try {
    for (const name of ['api', 'db', 'shadow'] as const) {
      const server = createServer();
      reservations.push(server);
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing proof port.');
      ports[name] = address.port;
    }
    return ports;
  } finally {
    await Promise.all(
      reservations
        .filter(server => server.listening)
        .map(
          server =>
            new Promise<void>((resolve, reject) =>
              server.close(error => (error ? reject(error) : resolve()))
            )
        )
    );
  }
}

/** Dedicated project and OS-selected ports; stop retains its database volume and configuration. */
export async function prepareIsolatedProof(
  root: string,
  state: string
): Promise<{ workdir: string; project: string }> {
  const project = crypto.randomUUID();
  const workdir = join(state, 'isolated', project);
  await mkdir(join(workdir, 'supabase'), { recursive: true });
  const { api, db, shadow } = await availablePorts();
  await cp(join(root, 'supabase/migrations'), join(workdir, 'supabase/migrations'), {
    recursive: true,
  });
  await writeFile(
    join(workdir, 'supabase/config.toml'),
    `project_id = "${project}"
[api]
port = ${api}
schemas = ["public"]
extra_search_path = ["public", "extensions"]
[db]
port = ${db}
shadow_port = ${shadow}
major_version = 15
[auth]
site_url = "http://localhost:5173"
enable_signup = false
[auth.email]
enable_signup = true
enable_confirmations = true
[studio]
enabled = false
[inbucket]
enabled = false
[analytics]
enabled = false
[edge_runtime]
enabled = false
[db.pooler]
enabled = false
`
  );
  return { workdir, project };
}
