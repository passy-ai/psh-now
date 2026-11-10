import type { PromptRisk } from "../db/schema";

interface RiskRule {
  pattern: RegExp;
  risk: PromptRisk;
  reason: string;
}

/**
 * Ordered from most to least severe. Every matching rule contributes a reason;
 * the final risk is the most severe match.
 */
const RULES: RiskRule[] = [
  // Catastrophic / irreversible
  { pattern: /\brm\s+-[a-z]*r[a-z]*f|\brm\s+-[a-z]*f[a-z]*r/i, risk: "critical", reason: "Recursive force delete (rm -rf)" },
  { pattern: /\bmkfs(\.[a-z0-9]+)?\b/i, risk: "critical", reason: "Filesystem format (mkfs)" },
  { pattern: /\bdd\s+.*\bof=\/dev\//i, risk: "critical", reason: "Raw disk write (dd of=/dev/...)" },
  { pattern: /:\(\)\s*\{\s*:\|:&\s*\}\s*;:/, risk: "critical", reason: "Fork bomb" },
  { pattern: /\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(ba|z|d)?sh\b/i, risk: "critical", reason: "Pipe remote script into a shell" },
  { pattern: /\bgit\s+push\b.*(--force\b|(?<!\w)-f(?!\w))/i, risk: "critical", reason: "Force push overwrites remote history" },
  { pattern: /\b(DROP|TRUNCATE)\s+(TABLE|DATABASE|SCHEMA)\b/i, risk: "critical", reason: "Destructive SQL DDL" },
  { pattern: /\bDELETE\s+FROM\b(?!.*\bWHERE\b)/i, risk: "critical", reason: "DELETE without WHERE clause" },
  { pattern: /\bshutdown\b|\breboot\b|\binit\s+0\b/i, risk: "critical", reason: "System shutdown/reboot" },
  { pattern: /\bterraform\s+destroy\b/i, risk: "critical", reason: "Terraform destroy" },
  { pattern: /\bkubectl\s+delete\b.*\b(namespace|ns|pvc|pv)\b/i, risk: "critical", reason: "Kubernetes destructive delete" },

  // Elevated / hard to undo
  { pattern: /\bsudo\b/i, risk: "high", reason: "Elevated privileges (sudo)" },
  { pattern: /\bchmod\s+(777|a\+rwx)\b/i, risk: "high", reason: "World-writable permissions (chmod 777)" },
  { pattern: /\bchown\s+-R\b/i, risk: "high", reason: "Recursive ownership change" },
  { pattern: /\b--force\b|\s-f\b/i, risk: "high", reason: "Forced execution flag (--force)" },
  { pattern: /\bnpm\s+(publish|unpublish)\b|\byarn\s+publish\b|\bpnpm\s+publish\b/i, risk: "high", reason: "Publishing a package" },
  { pattern: /\bdocker\s+(rm|rmi|system\s+prune)\b.*(-f|--force)/i, risk: "high", reason: "Force-removing Docker resources" },
  { pattern: /\b(heroku|vercel|netlify|flyctl?)\b.*\b(deploy|destroy|delete)\b/i, risk: "high", reason: "Production deployment action" },
  { pattern: /\bgit\s+(reset\s+--hard|clean\s+-[a-z]*f)\b/i, risk: "high", reason: "Discarding uncommitted work" },
  { pattern: /\bnpm\s+(install|ci)\b.*\b--force\b/i, risk: "high", reason: "Forced dependency reinstall" },
  { pattern: /\bpip\s+install\b.*--(force-reinstall|break-system-packages)/i, risk: "high", reason: "Forced Python dependency reinstall" },
  { pattern: /\bkill\s+-9\b|\bpkill\s+-9\b/i, risk: "high", reason: "Force-killing processes (SIGKILL)" },
];

// Medium / noteworthy writes and network egress.
const NOTE_RULES: RiskRule[] = [
  { pattern: />>?(?!\s*\/dev\/null)\s*\S+/, risk: "medium", reason: "Shell output redirection" },
  { pattern: /\b(curl|wget|nc|ncat|telnet)\b/i, risk: "medium", reason: "Network request" },
  { pattern: /\bnpm\s+(install|i|ci)\b|\bbun\s+(add|install)\b|\byarn\s+add\b|\bpip\s+install\b/i, risk: "medium", reason: "Dependency installation" },
];

const RANK: Record<PromptRisk, number> = {
  unknown: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

const LABEL: Record<PromptRisk, string> = {
  unknown: "Unclassified",
  low: "Low",
  medium: "Medium",
  high: "High",
  critical: "Critical",
};

export interface RiskAssessment {
  risk: PromptRisk;
  reasons: string[];
  label: string;
}

/** Scan a raw command string and bucket its risk with human-readable reasons. */
export function assessCommand(command: string): RiskAssessment {
  const reasons: string[] = [];
  let risk: PromptRisk = "low";

  for (const rule of RULES) {
    if (rule.pattern.test(command)) {
      reasons.push(rule.reason);
      if (RANK[rule.risk] > RANK[risk]) risk = rule.risk;
    }
  }

  if (risk === "low") {
    for (const rule of NOTE_RULES) {
      if (rule.pattern.test(command)) {
        reasons.push(rule.reason);
        if (RANK[rule.risk] > RANK[risk]) risk = rule.risk;
      }
    }
  }

  if (risk === "low" && reasons.length === 0) {
    risk = "unknown";
    reasons.push("No known risky patterns detected");
  }

  return { risk, reasons: [...new Set(reasons)], label: LABEL[risk] };
}
