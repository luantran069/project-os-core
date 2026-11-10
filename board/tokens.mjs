// Bearer tokens the board checks: the agents' and the owner's AI's. The board
// can hold either the token itself or only its fingerprint, "sha256:<hex>".
// With the fingerprint, the token lives only on the machine that uses it, and
// whoever reads the board's environment (Dokploy) cannot act as that machine.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const hashPrefix = "sha256:";
const hashed = /^sha256:[0-9a-f]{64}$/;
const minLength = 32;

// Agent and MCP names: lowercase letters, digits and dashes.
export const tokenName = /^[a-z0-9][a-z0-9-]{0,30}$/;

export const newToken = () => randomBytes(32).toString("hex");

export const hashToken = (token) =>
  `${hashPrefix}${createHash("sha256").update(String(token)).digest("hex")}`;

export const isHash = (value) => hashed.test(String(value ?? ""));

// The fingerprint of a stored value: itself when it is one already.
export const fingerprint = (value) =>
  isHash(value) ? String(value) : hashToken(value);

// Whether a bearer header carries the token a stored value stands for. Both
// sides are compared as fingerprints, so the time taken says nothing of either.
export function matches(stored, header) {
  const given = String(header ?? "");
  if (!given.startsWith("Bearer ")) return false;
  const token = given.slice("Bearer ".length);
  if (!token) return false;
  const a = Buffer.from(fingerprint(stored));
  const b = Buffer.from(hashToken(token));
  return a.length === b.length && timingSafeEqual(a, b);
}

// Checks one stored value: a fingerprint, or a token of 32+ characters.
export function checkToken(value, label) {
  const text = String(value ?? "").trim();
  if (text.startsWith(hashPrefix) && !isHash(text))
    throw new Error(`${label}: a fingerprint is sha256: and 64 hex characters`);
  if (!isHash(text) && text.length < minLength)
    throw new Error(`${label} needs 32+ characters or a sha256: fingerprint`);
  return text;
}

// "name=value,name=value" (commas or new lines), each value a token or its
// fingerprint. `variable` names the setting in error messages.
export function parseTokens(text, variable) {
  const tokens = {};
  for (const pair of String(text ?? "")
    .split(/[,\n]/)
    .map((p) => p.trim())
    .filter(Boolean)) {
    const at = pair.indexOf("=");
    const name = pair.slice(0, at).trim();
    if (at < 1 || !tokenName.test(name))
      throw new Error(
        `${variable}: "${name || pair.slice(0, 20)}" is not a valid agent name (a-z, 0-9, -)`,
      );
    const value = checkToken(
      pair.slice(at + 1),
      `${variable}: the token for ${name}`,
    );
    if (name in tokens) throw new Error(`${variable}: ${name} appears twice`);
    tokens[name] = value;
  }
  return tokens;
}

// No two machines, agent or AI, may share a token: each must be revocable on
// its own and tell the board who it is.
export function checkDistinct(groups) {
  const seen = new Map();
  for (const [variable, values] of Object.entries(groups))
    for (const value of values.filter(Boolean)) {
      const print = fingerprint(value);
      if (seen.has(print))
        throw new Error(
          seen.get(print) === variable
            ? `${variable}: each agent needs its own token`
            : `${variable} must differ from every token in ${seen.get(print)}`,
        );
      seen.set(print, variable);
    }
}

// The name whose stored token the header carries, or null. "" is an unnamed
// token (AGENT_TOKEN, BOARD_MCP_TOKEN).
export function callerOf(tokens, header) {
  let found = null;
  for (const [name, stored] of Object.entries(tokens))
    if (matches(stored, header)) found = name;
  return found;
}
