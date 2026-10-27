import * as B from './balance';
import { randomName } from './names';
import type { Rng } from './rng';

// Staff rules: skills, traits, needs. See plan.md §5.

export type Trait = 'hardWorker' | 'lazy' | 'cheerful' | 'grumpy' | 'strong';

export interface TraitDef {
  label: string;
  hint: string;
  /** Multiplier on energy used while working. */
  drain: number;
  /** Multiplier on morale lost from bad breaks. */
  moraleLoss: number;
  /** Multiplier on time spent lifting and stacking crates. */
  handling: number;
  /** Multiplier on the asking wage. */
  wage: number;
}

export const TRAITS: Record<Trait, TraitDef> = {
  hardWorker: {
    label: 'Hard worker',
    hint: 'Tires slowly',
    drain: 0.7,
    moraleLoss: 1,
    handling: 1,
    wage: 1.15,
  },
  lazy: {
    label: 'Lazy',
    hint: 'Tires quickly, but cheap',
    drain: 1.35,
    moraleLoss: 1,
    handling: 1,
    wage: 0.8,
  },
  cheerful: {
    label: 'Cheerful',
    hint: 'Shrugs off bad days',
    drain: 1,
    moraleLoss: 0.5,
    handling: 1,
    wage: 1,
  },
  grumpy: {
    label: 'Grumpy',
    hint: 'Loses morale fast',
    drain: 1,
    moraleLoss: 1.6,
    handling: 1,
    wage: 0.9,
  },
  strong: {
    label: 'Strong',
    hint: 'Lifts crates quickly',
    drain: 1,
    moraleLoss: 1,
    handling: 0.6,
    wage: 1.1,
  },
};

const NEUTRAL: TraitDef = {
  label: '',
  hint: '',
  drain: 1,
  moraleLoss: 1,
  handling: 1,
  wage: 1,
};

export function traitDef(t: Trait | null): TraitDef {
  return t ? TRAITS[t] : NEUTRAL;
}

export interface Candidate {
  id: number;
  name: string;
  /** 1 to 5; faster on their feet. */
  skill: number;
  trait: Trait | null;
  /** Per day. */
  wage: number;
}

export function makeCandidate(rng: Rng, id: number): Candidate {
  const skill = Math.min(5, Math.max(1, Math.round(rng.range(0.6, 4.4) + rng.range(0, 0.9))));
  const trait = rng.next() < 0.65 ? rng.pick(Object.keys(TRAITS) as Trait[]) : null;
  const wage = (B.WAGE_BASE + skill * B.WAGE_PER_SKILL) * traitDef(trait).wage;
  return { id, name: randomName(rng), skill, trait, wage: Math.round(wage / 5) * 5 };
}

/** Walking speed multiplier from skill and morale. */
export function paceFactor(skill: number, morale: number, energy: number): number {
  const skillF = 0.8 + skill * 0.1;
  const moraleF = 0.85 + (0.3 * morale) / 100;
  const tiredF = energy <= 0 ? 0.6 : 1;
  return skillF * moraleF * tiredF;
}

export interface Needs {
  blocked: boolean;
  energy: number;
  morale: number;
  resting: boolean;
  hasHut: boolean;
  carrying: boolean;
  idle: boolean;
}

/** A short line for the inspector, Theme Hospital style. */
export function thought(n: Needs): string {
  if (n.blocked) return 'Out of the way, please!';
  if (n.resting) return n.hasHut ? 'Ahh, a cup of tea.' : 'Nowhere to sit down around here…';
  if (n.morale < 25) return "I'm thinking about quitting.";
  if (n.energy < B.TIRED_ENERGY) return "I'm exhausted.";
  if (n.carrying) return 'These crates smell of fish.';
  if (n.idle) return 'Nothing to do. Am I still being paid?';
  if (n.morale > 85) return 'Best job on the coast!';
  return 'Another day at the docks.';
}
