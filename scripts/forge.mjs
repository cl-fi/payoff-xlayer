// The pinned npm launcher does not propagate Forge's exit status. Spawn its native binary directly.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { BINARY_NAME, PLATFORM_SPECIFIC_PACKAGE_NAME } from '../node_modules/@foundry-rs/forge/const.mjs';

const require = createRequire(import.meta.url);
const name = BINARY_NAME('forge');
const platform = PLATFORM_SPECIFIC_PACKAGE_NAME('forge');
if (!platform) throw new Error(`Unsupported Foundry platform: ${process.platform}/${process.arch}`);
let binary;
try {
  binary = require.resolve(`${platform}/bin/${name}`);
} catch {
  binary = join(dirname(require.resolve('@foundry-rs/forge/package.json')), '..', 'dist', name);
}
const child = spawn(binary, process.argv.slice(2), { stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', (code, signal) => { process.exitCode = code ?? (signal === 'SIGINT' ? 130 : 1); });
