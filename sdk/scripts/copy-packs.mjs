// Copies the repository's rule packs into the package so `loadRulePack('es')`
// works from npm installs as well as from a checkout.
import { cpSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const from = join(here, '..', '..', 'rule-packs');
const to = join(here, '..', 'rule-packs');
mkdirSync(to, { recursive: true });
cpSync(from, to, { recursive: true });
