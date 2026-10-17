// Stand-ins for the Node modules the Kyros SDK uses only on the server (reading rule packs from disk).
const unavailable = () => {
  throw new Error('not available in the browser');
};
export const readFileSync = unavailable;
export const existsSync = () => false;
export const readdirSync = () => [] as string[];
export const join = (...p: string[]) => p.join('/');
export const dirname = (p: string) => p;
export const fileURLToPath = (u: string) => u;
export default {};
