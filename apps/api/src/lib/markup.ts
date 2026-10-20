import type { NormalizedFare } from "@poomas/suppliers";

interface MarkupRule {
  agentId?:    string | null;
  markupType:  string;
  markupValue: string;
  airline?:    string | null;
  origin?:     string | null;
  destination?: string | null;
  cabinClass?: string | null;
  supplier?:   string | null;
  tripType?:   string | null;
  priority:    number;
  isActive:    boolean;
  validFrom?:  Date | null;
  validTo?:    Date | null;
}

// Evaluates markup rules in order (agent-specific first, then priority) and applies the first match
export function applyMarkup(fare: NormalizedFare, rules: MarkupRule[]): number {
  const now = new Date();

  const active = rules
    .filter((r) => r.isActive)
    .filter((r) => !r.validFrom || r.validFrom <= now)
    .filter((r) => !r.validTo   || r.validTo   >= now)
    // Rules allocated to an agent beat the tenant-wide defaults, then highest priority first.
    .sort((a, b) => Number(Boolean(b.agentId)) - Number(Boolean(a.agentId)) || b.priority - a.priority);

  for (const rule of active) {
    if (ruleMatches(rule, fare)) {
      const value = parseFloat(rule.markupValue);
      if (rule.markupType === "FLAT") {
        return fare.totalFare + value;
      }
      if (rule.markupType === "PERCENTAGE") {
        return fare.totalFare * (1 + value / 100);
      }
    }
  }

  return fare.totalFare;  // No matching rule → no markup
}

function ruleMatches(rule: MarkupRule, fare: NormalizedFare): boolean {
  if (rule.airline    && rule.airline    !== fare.airline)    return false;
  if (rule.origin     && rule.origin     !== fare.origin)     return false;
  if (rule.destination && rule.destination !== fare.destination) return false;
  if (rule.cabinClass && rule.cabinClass !== fare.cabinClass) return false;
  if (rule.supplier   && rule.supplier   !== fare.supplier)   return false;
  return true;
}
