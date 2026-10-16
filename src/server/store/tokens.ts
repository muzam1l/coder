/** Platform tokens the store holds for reuse, and the drops that retire them. */

/** A platform token held for reuse, sealed. */
export interface HeldToken {
  token: string;
  expiresAt: number;
  mintedAt: number;
}

/** An installation's or app's latest token drop. */
export interface TokenDrop {
  drop: string;
}

export const heldKey = (id: string, key = '') => `token:${id}:${key}`;
export const dropKey = (id: string) => `token-drop:${id}`;

/** An installation's held tokens and the drops of it and its app, read in one go. */
export interface TokenState {
  held: Map<string, HeldToken>;
  drops: Map<string, string | undefined>;
}

/** A minted token to hold, as long as the drops it was read under still stand. */
export interface HeldWrite {
  key: string;
  value: HeldToken;
  ttlMs: number;
  drops: Array<{ key: string; drop?: string }>;
}
