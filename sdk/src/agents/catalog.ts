/**
 * The agents and whether each is switched on. `active`: on now, in the app,
 * the law watch or the keeper. `ready`: built and tested in the SDK, waiting
 * for what it needs to be useful (mainnet, an anchor, a partner's server).
 * The app and the assistant only offer the active ones.
 */
export type AgentId =
  | 'assistant'
  | 'law'
  | 'documents'
  | 'reconcile'
  | 'payouts'
  | 'treasury-fx'
  | 'treasury-yield'
  | 'residence'
  | 'expenses'
  | 'guardian'
  | 'x402'
  | 'settlement';

export interface AgentInfo {
  id: AgentId;
  status: 'active' | 'ready';
  /** Where it runs. */
  runs: 'device' | 'law-watch' | 'keeper' | 'seller-server' | 'cli';
  /** Why it is on, or what switches it on. */
  why: string;
}

export const AGENTS: AgentInfo[] = [
  { id: 'assistant', status: 'active', runs: 'device', why: 'Answers every user from their rule pack and vault; the other agents speak through it.' },
  { id: 'documents', status: 'active', runs: 'device', why: 'Tax office notices and invoices are the most common paperwork; reading them sets due dates and exact split terms.' },
  { id: 'reconcile', status: 'active', runs: 'device', why: 'Explains every figure with its transaction and checks exports for the accountant or Koinly.' },
  { id: 'law', status: 'active', runs: 'law-watch', why: 'Keeps 46 rule packs current every Monday with reviewed pull requests.' },
  { id: 'guardian', status: 'active', runs: 'device', why: 'Non-custody only holds if a stolen key cannot redirect the reserve: every pending change is flagged with its cancel button (and, from the keeper, sent to Telegram or a webhook).' },
  { id: 'expenses', status: 'active', runs: 'device', why: 'Every country’s rules for expenses: what they save in income tax and contributions, the input VAT that comes back, the prepayments, and a lower reserve when they justify it.' },
  { id: 'residence', status: 'active', runs: 'device', why: 'Freelancers who move between countries: days against each country’s test, and the switch signed from the app for the right date, with the same payment address.' },
  { id: 'payouts', status: 'active', runs: 'device', why: 'Platforms and DAOs paying many freelancers at once: a checked CSV into one signature per run.' },
  { id: 'treasury-fx', status: 'active', runs: 'device', why: 'Users paid in dollars who owe tax in euros: when to convert, against the oracle and the due date.' },
  { id: 'treasury-yield', status: 'ready', runs: 'device', why: 'Needs a Blend v2 pool for the reserve’s asset on the network and the owner’s strategy; until then it projects with a rate the user gives.' },
  { id: 'x402', status: 'active', runs: 'seller-server', why: 'Runs in the API seller’s server through the @kyros/x402 plugin; the app’s Sell online screen makes one payment address per VAT rate. The same addresses serve the WooCommerce plugin.' },
  { id: 'settlement', status: 'ready', runs: 'device', why: 'Needs a regulated anchor paying out euros (mainnet); on testnet the tax destination is a plain account.' },
];

export const isActive = (id: AgentId): boolean => AGENTS.find((a) => a.id === id)?.status === 'active';
