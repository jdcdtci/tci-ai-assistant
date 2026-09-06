import type { DistressLevel } from "./distress";

// The student-facing half of stage 2.
//
// SOURCING
//
// The crisis and possible-risk texts are not authored from a list of
// required content. They are built against the 988 Suicide and Crisis
// Lifeline's own #BeThe1To framework, whose five evidence-based steps are
// Ask, Be There, Keep Them Safe, Help Them Connect, and Follow Up. Mapping a
// course assistant honestly against those steps is what determines both what
// these texts say and what they must refuse to do:
//
//   Ask               -> the assistant CAN do this, and the recommended
//                        wording is direct and non-euphemistic ("Are you
//                        thinking about suicide?"). Asking does not increase
//                        ideation and may reduce it. This is the centrepiece
//                        of the possible_risk response.
//   Be There          -> partially, within a single turn only. The governing
//                        rule is "do not commit to anything you are not
//                        willing or able to accomplish", and the related one,
//                        focus on the person's own reasons for living rather
//                        than imposing reasons for them. So: no motivational
//                        content, no argument, no promise to check back.
//   Keep Them Safe    -> means restriction. A course assistant CANNOT do
//                        this and must not approximate it. Handed to 988.
//   Help Them Connect -> the strongest genuinely available action, and why
//                        988 appears in every one of these texts.
//   Follow Up         -> structurally impossible here. There is no scheduler.
//                        Nothing may imply the assistant will check back.
//
// One prohibition is carried directly from the guidance: never promise to
// keep thoughts of suicide a secret. Since the exchange is logged, honesty
// requires saying so. It is placed LAST in every text, never leading,
// because a privacy caveat ahead of the direct ask would chill the exact
// disclosure the direct ask exists to invite.
//
// WHY THESE ARE FIXED STRINGS
//
// Same reasoning spec 3.8 uses for assessment mode: structural enforcement
// beats behavioural instruction. A fixed response cannot drift between
// runs, cannot be argued out of by a persistent student, and cannot be
// prompt-injected. For the two highest levels the tutoring model is not
// asked to generate anything at all.

// Substring used to detect, from conversation history alone, that a crisis
// response has already been given in this conversation. History-based rather
// than database-based on purpose: it works for anonymous students, who have
// no student_id to look up.
export const CRISIS_MARKER = "the coursework will keep";

const CRISIS_FIRST = `I am going to stop the coursework here, because what you have just said matters more than that.

Let me be straightforward with you. I am a course assistant. I am not a counselor, I cannot stay with you, and I am not able to give you the kind of help this deserves. What I can do is point you to people who can.

You can call or text 988, the Suicide and Crisis Lifeline. It is free, confidential, and staffed at every hour.

If you are in immediate danger, please call 911 or go to your nearest emergency room.

One thing I would rather say than let you assume: this conversation is recorded, so I cannot promise you privacy about what you have written here.

The coursework will keep. Whenever you want to come back to it, I am here.`;

// Shown when a crisis classification recurs in a conversation that has
// already had one. Approved separately, and sourced the same way rather than
// written freehand on the theory that a shorter message is lower stakes: it
// is Be There (present without pressure, promising nothing it cannot do) and
// Help Them Connect (the route stays visible rather than being withdrawn),
// and it does not pretend the earlier exchange did not happen.
const CRISIS_REPEAT = `Okay. I am not going to push on that, and I am not going to pretend I did not hear it either.

988 is still there whenever you want it, by call or text, at any hour.

If you want to pick the coursework back up, we can do that.`;

const POSSIBLE_RISK = `Before we go further, I want to ask you something directly rather than talk around it: are you thinking about suicide?

I am asking plainly because it is a question worth asking straight, and because guessing at what you meant would not serve you well. If the answer is no, that is completely fine. Tell me and we will pick the coursework straight back up.

If the answer is yes, or something near it, you can call or text 988 at any hour. That is the Suicide and Crisis Lifeline, free and confidential, and they are far better placed to help with this than I am.

I should be honest that this conversation is recorded, so I cannot promise privacy about what you say here.`;

/**
 * Appends a course's own crisis contact when one has been verified and
 * recorded. Null is a working state, not a gap: the 988 baseline is complete
 * on its own, and an invented or stale institutional number handed to a
 * student in crisis is the worst available failure of this feature.
 */
function withInstitutionalResource(text: string, resource: unknown): string {
  if (typeof resource !== "string" || resource.trim() === "") return text;
  return `${text}\n\nYour institution also lists this contact: ${resource.trim()}`;
}

/**
 * The fixed response for possible_risk and crisis. Returns null for levels
 * that are not answered with fixed text.
 */
export function fixedDistressResponse(
  level: DistressLevel,
  opts: { crisisAlreadyRaised: boolean; institutionalResource?: unknown },
): string | null {
  if (level === "crisis") {
    const base = opts.crisisAlreadyRaised ? CRISIS_REPEAT : CRISIS_FIRST;
    // The repeat text deliberately stays short; adding an institutional
    // block back onto it would undo the point of it being brief.
    return opts.crisisAlreadyRaised
      ? base
      : withInstitutionalResource(base, opts.institutionalResource);
  }
  if (level === "possible_risk") {
    return withInstitutionalResource(POSSIBLE_RISK, opts.institutionalResource);
  }
  return null;
}

/**
 * True when a crisis response has already been given earlier in this
 * conversation, so a recurrence gets the brief acknowledging text rather
 * than a verbatim re-run of the full script. Also covers the retraction
 * case: a student who says "I was joking" after a crisis turn still
 * classifies as crisis, and should be met with the short text rather than
 * the whole thing again.
 */
export function hasCrisisAlreadyBeenRaised(
  priorTurns: { role: string; content: string }[],
): boolean {
  return priorTurns.some(
    (t) => t.role === "assistant" && t.content.toLowerCase().includes(CRISIS_MARKER),
  );
}

// personal_distress: ONE generated clause, then fixed text.
//
// WHY THIS IS SPLIT RATHER THAN FULLY GENERATED
//
// This level was originally generated end to end, on the argument that a
// canned reply to a specific personal disclosure is worse than a warm
// specific one. Six live samples showed that argument only holds for the
// first clause. All six opened with a demonstrative plus a reflection verb
// ("that sounds like" four times, "makes sense" twice, one of them the exact
// phrase already flagged elsewhere in this project), and three of the four
// moves were near-identical across all six: the limitation sentence, the
// instructor routing, and the three-option close. Only the reflection
// genuinely varied.
//
// The prompt already forbade stock openers, and so does the tutoring prompt.
// Two instructions did not prevent it. So this stopped being treated as a
// prompting problem: the parts that are in practice fixed are now actually
// fixed, and only the part that must vary is generated. That is honest about
// what the response is, costs less, and cannot drift.
//
// SOURCING (the fixed portion is not freehand)
//
// SAMHSA's guidance on talking to someone about help supplies the shape:
// listen and repeat back what you heard "so they feel understood and
// [to correct] any misunderstandings" (the generated reflection), and
// ask what would help rather than deciding for them (the close).
// #BeThe1To supplies the two prohibitions that bound it: "do not commit to
// anything you are not willing or able to accomplish", which is why nothing
// here offers follow-up the system cannot perform, and the rule against
// imposing your own reasons on someone, which is why nothing here reassures
// or motivates. Spec 3.1 governs the instructor sentence: it names the right
// human without implying any authority over extensions or accommodations.
//
// DELIBERATE OMISSION: no 988, and no crisis resource of any kind. This
// level means a wellbeing signal with NO indication of danger. Handing a
// suicide line to a student who said they are behind because things are hard
// at home is exactly the over-response the level scale exists to prevent,
// and it is what teaches students to disregard the response when it matters.
//
// DELIBERATE OMISSION: no "I will not be able to check on you later". It is
// true, and it is in the crisis text where a student may actually be relying
// on continued presence. Volunteering it to someone who has just mentioned a
// bereavement is gratuitously cold. The rule is not to imply follow-up, which
// this does not.
export const PERSONAL_DISTRESS_FIXED = `I am a course assistant, so I can help with the material, but I am not the right kind of support for what you are carrying.

If it is affecting your coursework, your instructor is the person to talk to about that.

What would help most right now: carrying on with the material, leaving it for today, or nothing more than having said it?`;

// Used when the reflection cannot be generated. Sending the fixed portion
// alone is honest and safe; inventing a generic sympathy line as a fallback
// would reintroduce exactly the stock opener this change removes.
export const PERSONAL_DISTRESS_FALLBACK = PERSONAL_DISTRESS_FIXED;

// The generated part is now scoped to the reflection only. max_tokens is kept
// low at the call site as a structural bound, not just an instruction.
export const PERSONAL_DISTRESS_REFLECTION_SYSTEM = `A student has said something indicating a genuine wellbeing concern in their own life. Your entire job is to write ONE or TWO sentences reflecting back the specific thing they actually said, so they can tell they were heard and can correct you if you have it wrong.

Write only that reflection. Something else already follows it, so do not write anything beyond it.

Reflect what is specific to them: the actual circumstance, in your own words. Do not open with a stock formula such as "that sounds like", "that makes sense", "it makes sense that", or "it sounds like". Vary how you begin.

Do not diagnose, interpret, or name what they must be feeling.
Do not give advice, offer coping strategies, or reassure them that things will improve.
Do not teach, explain course content, or ask any question.
Do not mention yourself, your limitations, their instructor, or what happens next.
Do not promise anything, including confidentiality, follow-up, or that anyone has been told.

Never use em dashes and never use bold text.`;

export function assemblePersonalDistressResponse(reflection: string): string {
  const trimmed = reflection.trim();
  if (!trimmed) return PERSONAL_DISTRESS_FALLBACK;
  return `${trimmed}\n\n${PERSONAL_DISTRESS_FIXED}`;
}
