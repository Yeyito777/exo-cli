import type { ModelId, ProviderId } from "./shared/protocol";

export interface ModelSelection {
  provider: ProviderId | null;
  model: ModelId | null;
}

const ANTHROPIC_ALIASES: Record<string, ModelId> = {
  opus: "claude-opus-4-6",
  "opus-4.6": "claude-opus-4-6",
  "claude-opus-4-6": "claude-opus-4-6",
  sonnet: "claude-sonnet-4-6",
  "sonnet-4.6": "claude-sonnet-4-6",
  "claude-sonnet-4-6": "claude-sonnet-4-6",
  haiku: "claude-haiku-4-5-20251001",
  "haiku-4.5": "claude-haiku-4-5-20251001",
  "claude-haiku-4-5-20251001": "claude-haiku-4-5-20251001",
};

export function isProviderId(value: string): value is ProviderId {
  return value === "anthropic" || value === "openai";
}

export function inferProviderForModel(model: ModelId | null): ProviderId | undefined {
  if (!model) return undefined;
  const lowered = model.trim().toLowerCase();
  return lowered in ANTHROPIC_ALIASES ? "anthropic" : undefined;
}

export function normalizeModelForProvider(provider: ProviderId | null, model: string): ModelId {
  const trimmed = model.trim();
  const lowered = trimmed.toLowerCase();
  if (provider === "anthropic" || provider === null) {
    const anthropic = ANTHROPIC_ALIASES[lowered];
    if (anthropic) return anthropic;
  }
  return trimmed;
}

export function parseModelSpecifier(spec: string): ModelSelection {
  const trimmed = spec.trim();
  if (!trimmed) {
    throw new Error("--model requires a non-empty value");
  }

  const slash = trimmed.indexOf("/");
  if (slash !== -1) {
    const providerPart = trimmed.slice(0, slash).trim().toLowerCase();
    const modelPart = trimmed.slice(slash + 1).trim();
    if (!isProviderId(providerPart)) {
      throw new Error(`Unknown provider in model spec: ${providerPart}`);
    }
    if (!modelPart) {
      throw new Error(`Missing model name after provider in --model ${JSON.stringify(spec)}`);
    }
    return {
      provider: providerPart,
      model: normalizeModelForProvider(providerPart, modelPart),
    };
  }

  const anthropic = ANTHROPIC_ALIASES[trimmed.toLowerCase()];
  if (anthropic) {
    return { provider: "anthropic", model: anthropic };
  }

  return { provider: null, model: trimmed };
}

