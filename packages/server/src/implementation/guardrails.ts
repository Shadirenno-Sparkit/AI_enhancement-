import type { PermissionScope, RiskTier, SpecItem, TrustPosture, User } from '@aiapp/shared';
import { ITEM_TYPE_SCOPES, TRUST_AUTO_TIERS } from '@aiapp/shared';
import { config } from '../config.js';
import { audit } from '../repo/audit.js';
import { usageToday } from '../repo/users.js';
import { HttpError } from '../util/errors.js';

/**
 * Guardrails & Sandbox (spec §4.6, §9).
 *
 * Everything the implementation engine does passes through here. The contract
 * is narrow on purpose: an item may only use the scopes its *type* implies,
 * assigned server-side, so neither a model response nor a crafted request can
 * widen what a run is allowed to touch.
 */

export class ScopeViolation extends Error {
  constructor(
    readonly itemId: string,
    readonly scope: PermissionScope,
    readonly allowed: PermissionScope[],
  ) {
    super(`Item ${itemId} attempted to use scope "${scope}" which it did not declare (allowed: ${allowed.join(', ')})`);
    this.name = 'ScopeViolation';
  }
}

export interface ItemSandbox {
  readonly itemId: string;
  readonly allowed: PermissionScope[];
  /** Throws unless the scope was declared by this item's type. */
  require(scope: PermissionScope): void;
  /** Non-throwing check, for optional capabilities. */
  has(scope: PermissionScope): boolean;
}

export function sandboxFor(item: SpecItem): ItemSandbox {
  // Recomputed from the item type rather than trusting the stored column: a
  // tampered database row cannot grant an item extra reach.
  const allowed = ITEM_TYPE_SCOPES[item.type];
  return {
    itemId: item.itemId,
    allowed,
    require(scope: PermissionScope) {
      if (!allowed.includes(scope)) throw new ScopeViolation(item.itemId, scope, allowed);
    },
    has(scope: PermissionScope) {
      return allowed.includes(scope);
    },
  };
}

export interface AutonomyDecision {
  /** May this item run without a second confirmation from the user? */
  autoImplement: boolean;
  /** Force preview-only for this item. */
  dryRun: boolean;
  reason: string;
}

/**
 * Applies the trust dial (spec §9). Approval is always required first; this
 * decides whether an *approved* item executes immediately or waits for an
 * explicit "yes, really" on higher-risk categories.
 */
export function evaluateAutonomy(user: User, item: SpecItem, requestedDryRun: boolean): AutonomyDecision {
  const cfg = config();

  if (!cfg.enableAutonomousImplementation) {
    return { autoImplement: false, dryRun: true, reason: 'Autonomous implementation is disabled on this deployment.' };
  }
  if (requestedDryRun || user.preferences.dryRunFirst) {
    return { autoImplement: true, dryRun: true, reason: 'Preview requested — nothing will be changed.' };
  }

  const posture: TrustPosture = user.preferences.trustPosture;
  const autoTiers: RiskTier[] = user.preferences.autoImplementTiers ?? TRUST_AUTO_TIERS[posture];

  if (autoTiers.includes(item.riskTier)) {
    return { autoImplement: true, dryRun: false, reason: `Trust posture "${posture}" auto-implements ${item.riskTier} items.` };
  }

  return {
    autoImplement: false,
    dryRun: false,
    reason: `Your trust posture "${posture}" asks for an extra confirmation before ${item.riskTier} items run.`,
  };
}

/**
 * Enforces per-user daily spend before a paid stage (spec §15, BRD R4).
 * Throws a 402 so the caller surfaces it as a budget message, not a crash.
 */
export function assertWithinDailyBudget(userId: string): void {
  const cfg = config();
  const usage = usageToday(userId);
  if (usage.usd >= cfg.maxUsdPerUserPerDay) {
    audit({ userId, event: 'budget.blocked', detail: `daily spend ${usage.usd.toFixed(4)} USD reached the ceiling` });
    throw new HttpError(
      402,
      'budget_exceeded',
      `You have reached your daily processing budget of $${cfg.maxUsdPerUserPerDay.toFixed(2)}. It resets at midnight UTC.`,
    );
  }
}

/** Per-link ceiling checked between pipeline stages. Returns false to stop early. */
export function withinLinkBudget(spentUsd: number): boolean {
  return spentUsd < config().maxUsdPerLink;
}

/**
 * Commands the engine will never run, regardless of approval. `run_command`
 * items are prepared and explained but require explicit user execution; this
 * list is a second line of defence for any future path that does execute.
 */
const FORBIDDEN_COMMAND = [
  /\brm\s+-rf?\s+[/~]/,
  /\bmkfs\b/,
  /\bdd\s+if=/,
  /\b(shutdown|reboot|halt)\b/,
  /\bchmod\s+-R\s+777\s+\//,
  /\bcurl\b[^|]*\|\s*(ba)?sh/,
  /\bwget\b[^|]*\|\s*(ba)?sh/,
  /:\(\)\s*\{.*\}\s*;:/,
  /\bsudo\b/,
  /\b(passwd|useradd|usermod)\b/,
  />\s*\/dev\/sd[a-z]/,
];

export function isForbiddenCommand(command: string): boolean {
  return FORBIDDEN_COMMAND.some((pattern) => pattern.test(command));
}

/** Hosts the download handler refuses, to keep fetches to ordinary web content. */
export function isAllowedDownloadUrl(rawUrl: string): { ok: boolean; reason?: string } {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, reason: 'not a valid URL' };
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { ok: false, reason: `unsupported protocol ${parsed.protocol}` };
  }

  const host = parsed.hostname.toLowerCase();
  // Block loopback, link-local and private ranges: an item must not be able to
  // make the server fetch its own internal services (SSRF).
  const PRIVATE = [
    /^localhost$/,
    /^127\./,
    /^0\./,
    /^10\./,
    /^192\.168\./,
    /^172\.(1[6-9]|2\d|3[01])\./,
    /^169\.254\./,
    /^::1$/,
    /^\[?::1\]?$/,
    /^fc00:/i,
    /^fe80:/i,
    /\.local$/,
    /\.internal$/,
  ];
  if (PRIVATE.some((pattern) => pattern.test(host))) {
    return { ok: false, reason: 'refusing to fetch a private or loopback address' };
  }
  return { ok: true };
}
