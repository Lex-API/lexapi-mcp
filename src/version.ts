import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Read version from package.json at load time so it can't drift from the
// published version. Works in all deploy shapes: npm tarball, source dev,
// Docker (dist/ sits next to package.json in every case).
const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string };

export const PACKAGE_VERSION: string = pkg.version;
