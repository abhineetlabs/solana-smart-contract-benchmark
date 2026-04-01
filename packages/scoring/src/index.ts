import type { ScoreWeights } from "../../core/src/index.js";

export interface StageSummary {
  passed: number;
  total: number;
  failures: string[];
}

export interface ScoreBreakdown {
  build: number;
  public: number;
  hidden: number;
  adversarial: number;
  efficiency: number;
}

export function computeAttemptScore(
  weights: ScoreWeights,
  buildSuccess: boolean,
  summaries: {
    public: StageSummary;
    hidden: StageSummary;
    adversarial: StageSummary;
  },
): { total: number; breakdown: ScoreBreakdown } {
  const breakdown: ScoreBreakdown = {
    build: round(buildSuccess ? weights.build : 0),
    public: round(ratioScore(summaries.public, weights.public)),
    hidden: round(ratioScore(summaries.hidden, weights.hidden)),
    adversarial: round(ratioScore(summaries.adversarial, weights.adversarial)),
    efficiency: round(0),
  };

  return {
    breakdown,
    total: round(
      breakdown.build +
        breakdown.public +
        breakdown.hidden +
        breakdown.adversarial +
        breakdown.efficiency,
    ),
  };
}

export function inferFailureClasses(input: {
  buildSuccess: boolean;
  buildStderr: string;
  public: StageSummary;
  hidden: StageSummary;
  adversarial: StageSummary;
}): string[] {
  const failures = [
    ...(input.buildSuccess ? [] : [input.buildStderr]),
    ...input.public.failures,
    ...input.hidden.failures,
    ...input.adversarial.failures,
  ];

  const classes = new Set<string>();

  if (!input.buildSuccess) {
    classes.add("build_error");
  }

  for (const failure of failures) {
    const normalized = failure.toLowerCase();

    if (normalized.includes("authority") || normalized.includes("unauthorized") || normalized.includes("signer")) {
      classes.add("signer_validation");
    }

    if (normalized.includes("owner") || normalized.includes("ownership")) {
      classes.add("ownership_validation");
    }

    if (normalized.includes("pda")) {
      classes.add("pda_validation");
    }

    if (normalized.includes("token") || normalized.includes("mint")) {
      classes.add("token_validation");
    }

    if (normalized.includes("cpi")) {
      classes.add("cpi_authorization");
    }

    if (normalized.includes("overflow") || normalized.includes("arithmetic")) {
      classes.add("arithmetic_safety");
    }

    if (normalized.includes("substitution")) {
      classes.add("account_substitution");
    }

    if (normalized.includes("close")) {
      classes.add("close_authorization");
    }

    if (normalized.includes("interface")) {
      classes.add("interface_mismatch");
    }
  }

  if (classes.size === 0 && (input.public.failures.length > 0 || input.hidden.failures.length > 0 || input.adversarial.failures.length > 0)) {
    classes.add("functional_logic");
  }

  return [...classes].sort();
}

function ratioScore(summary: StageSummary, weight: number): number {
  if (summary.total === 0 || weight === 0) {
    return 0;
  }

  return (summary.passed / summary.total) * weight;
}

function round(value: number): number {
  return Number(value.toFixed(4));
}
