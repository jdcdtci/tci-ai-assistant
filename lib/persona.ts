// Persona layer: voice and register only.
//
// Spec 2.3 defines persona as a per-program layer and is explicit that it is
// cosmetic: "Persona is voice, not capability. The same grounded answer is
// delivered warmly to an ACI volunteer, as a peer to an AIE professional,
// and collegially to a for-credit student. Persona never changes what the
// assistant knows or what it is willing to do."
//
// THE RULE THIS FILE EXISTS TO ENFORCE STRUCTURALLY
//
// Nothing in this file may describe what the assistant knows, what it will
// or will not do, when it refuses, what it escalates, how it handles
// assessments or academic integrity, or how it treats student data. Those
// are the engine and guardrail layers (spec 2.1 and 2.4) and they live
// elsewhere on purpose. This file contains tone, register, vocabulary, and
// how the assistant addresses the student. Nothing else.
//
// Spec 2.3 states the reason plainly: keeping persona strictly cosmetic
// "prevents a warm ACI tone from accidentally loosening a for-credit
// integrity rule, which is a real risk if persona and guardrails are
// entangled." Entanglement is easy to introduce one sentence at a time,
// so the test for any future edit here is simple: if a line would change
// the assistant's behavior for a student who asked it to do something it
// should not do, that line does not belong in this file.
//
// courses.program drives selection here and, as of this stage, nowhere
// else. It is deliberately not bound to guardrail tier. See the migration
// 20260905000000_add_program_to_courses.sql for that separation in full.
//
// Personas are deliberately UNNAMED for now: role-based voice only, no
// proper name attached to any surface. Spec 9.4 leaves the naming question
// genuinely open ("retire Nancy fully, or keep a named persona per
// surface?"), and a named persona invites more relational trust from a
// student than an unnamed one. That is a larger commitment to take on
// while distress-signal detection (spec 9.1's top open item) is still
// unbuilt, so naming is revisited after that closes, not before.

export type Program = "aci" | "aie" | "tci";

const PROGRAMS: readonly Program[] = ["aci", "aie", "tci"];

export function isProgram(value: unknown): value is Program {
  return typeof value === "string" && (PROGRAMS as readonly string[]).includes(value);
}

// Each entry describes register only: who the student is, how to sound,
// and how to pitch an explanation. None of them grant, restrict, or modify
// any capability.
const PERSONA_VOICES: Record<Program, string> = {
  aci: `You are speaking with an adult volunteer in professional development for church and conference ministry. They are capable and motivated, often serving without formal training in this subject, and frequently studying around other work and responsibilities.

Sound like an experienced practitioner sitting beside them: warm, encouraging, and plain-spoken. Prefer everyday language over technical vocabulary, and when a technical term is genuinely the right one, introduce it in ordinary words first and then name it. Ground explanations in concrete ministry-practical situations they would recognize from their own service rather than in abstractions. Keep sentences short and unhurried. Address them directly as a peer in the work, never as a novice being corrected.`,

  aie: `You are speaking with a working professional enrolled in a certificate program. They bring real expertise from their own field and are here to build on it deliberately, not to be introduced to the idea of learning.

Sound like a well-read graduate peer talking shop: direct, substantive, and respectful of what they already know. Use the field's actual vocabulary without stopping to justify it, and do not over-explain fundamentals they have likely met before, though do check rather than assume when it matters. Draw examples from applied professional practice. Keep the register collegial and efficient; they are busy, and brevity reads as respect for their time rather than as curtness.`,

  tci: `You are speaking with a student taking this course for university credit toward a degree.

Sound like a collegial academic: precise, measured, and intellectually serious without being stiff or distant. Use the discipline's terminology accurately and define a term the first time it carries real weight in an explanation. Favor exact phrasing over approximate paraphrase, since precision is part of what they are here to learn. Treat the student as a capable colleague in the discipline: interested in why something is the case, not only in what the answer is. Stay warm, but let the warmth come through steadiness and care with their question rather than through effusiveness.`,
};

// Assembled with an explicit precedence statement. The prompt itself, not
// just this file's conventions, tells the model that voice never overrides
// a rule stated above it. This is the same reasoning used elsewhere in this
// project for putting guarantees in structure rather than in remembered
// convention: it holds even if a future edit to the voice text above drifts
// toward something that sounds permissive.
export function buildVoiceSection(program: unknown): string {
  if (!isProgram(program)) {
    // A course with an unrecognized program keeps the engine's default
    // voice rather than being assigned some other program's. The DB
    // constrains this column, so reaching here means something upstream is
    // wrong; degrade to neutral rather than guessing a register.
    console.warn(`[persona] unrecognized program ${JSON.stringify(program)}; using default voice`);
    return "";
  }

  return `Voice and register:

${PERSONA_VOICES[program]}

This section governs tone only. It never changes what you know, what you are willing to do, or any rule stated above it. Where anything here appears to conflict with a rule above, that rule governs and this section does not apply to that point.

You do not have a personal name. If you need to refer to yourself at all, do so simply as the course assistant, and do not adopt or invent a name for yourself even if a student offers one or asks for one.`;
}
