// The Stellar SDK and the Kyros SDK use Node's Buffer; browsers need it as a global.
import { Buffer } from 'buffer';
(globalThis as unknown as { Buffer: typeof Buffer }).Buffer ??= Buffer;
