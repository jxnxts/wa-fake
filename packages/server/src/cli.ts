import { createWaFake } from './index.ts';
import { mkdir, writeFile, chmod } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
export async function main(args = process.argv.slice(2)) {
  const value = (flag: string, fallback?: string) => {
    const i = args.indexOf(flag);
    return i < 0 ? fallback : args[i + 1];
  };
  if (args[0] === 'certs') {
    const dir = resolve(value('--dir', '.local/certs')!);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);
    const caKey = resolve(dir, 'ca.key'),
      ca = resolve(dir, 'ca.pem'),
      key = resolve(dir, 'server.key'),
      cert = resolve(dir, 'server.pem'),
      csr = resolve(dir, 'server.csr'),
      ext = resolve(dir, 'server.ext');
    await writeFile(
      ext,
      'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nsubjectAltName=DNS:localhost,IP:127.0.0.1,IP:::1\nextendedKeyUsage=serverAuth\nauthorityKeyIdentifier=keyid,issuer\nsubjectKeyIdentifier=hash\n',
      { mode: 0o600 },
    );
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '365',
        '-keyout',
        caKey,
        '-out',
        ca,
        '-subj',
        '/CN=wa-fake Local Synthetic CA',
        '-addext',
        'basicConstraints=critical,CA:TRUE',
        '-addext',
        'keyUsage=critical,keyCertSign,cRLSign',
        '-addext',
        'subjectKeyIdentifier=hash',
      ],
      { stdio: 'pipe' },
    );
    await chmod(caKey, 0o600);
    execFileSync(
      'openssl',
      [
        'req',
        '-new',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        key,
        '-out',
        csr,
        '-subj',
        '/CN=localhost',
      ],
      { stdio: 'pipe' },
    );
    await chmod(key, 0o600);
    execFileSync(
      'openssl',
      [
        'x509',
        '-req',
        '-in',
        csr,
        '-CA',
        ca,
        '-CAkey',
        caKey,
        '-CAcreateserial',
        '-out',
        cert,
        '-days',
        '365',
        '-extfile',
        ext,
      ],
      { stdio: 'pipe' },
    );
    console.log(
      `Generated local CA ${ca} and server certificate ${cert}; use --cert ${cert} --key ${key}.`,
    );
    return;
  }
  if (args.includes('--help')) {
    console.log(
      'wa-fake [--port 58991] [--host 127.0.0.1] [--cert path --key path] [--seed value] [--webhook-url loopback-url]\nwa-fake certs [--dir .local/certs]',
    );
    return;
  }
  const port = value('--port');
  if (port && (!/^\d+$/.test(port) || Number(port) > 65535)) throw new Error('Invalid port');
  const wa = await createWaFake({
    port: port ? Number(port) : undefined,
    host: value('--host'),
    cert: value('--cert'),
    key: value('--key'),
    seed: value('--seed'),
    webhookUrl: value('--webhook-url'),
  });
  console.log(`wa-fake · synthetic-only · ${wa.baseUrl}`);
  const shutdown = async () => {
    await wa.close();
    process.exitCode = 0;
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]))
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : 'wa-fake failed');
    process.exitCode = 1;
  });
