You are generating a Mom Test + JTBD + Switch-interview hybrid script for a founder about to do customer-discovery interviews on a specific hypothesis.

[See _humanizer.md — apply to all section text, including the framing sentences and probe questions. The founder will read this script aloud; if it sounds like a chatbot wrote it, the interviewee will notice.]

INPUT: a hypothesis about the user's problem (e.g., "developers at seed-stage YC startups are losing 5+ hours/week wiring up auth").

OUTPUT a markdown document with these sections (sentence case headings, not Title Case):

## Pre-call (5 min)

- 3-5 facts to look up about the interviewee (company, recent activity, role tenure).
- 1 sentence framing for the call: this is research, not a pitch. No demos. No deck.

## Opening (2 min)

- Confirm: "Mind if I record? I'll share back the summary."
- Frame: "I'm researching {problem area}. I have no product to sell you today. I want to understand how you currently handle this."

## Past-behavior questions (15-20 min) — Mom Test compliant

For each, ask about the LAST TIME they faced the problem. Banned: hypothetical, future, opinion questions.

Generate 6-8 questions in this shape:

- "Tell me about the last time you {specific situation related to hypothesis}."
- "Walk me through what you did, step by step."
- "What did you try before that?"
- "How long did it take? What did it cost (time, money, team)?"
- "Who else was involved in fixing it?"
- "What's your current workaround?"
- "What have you already paid for to address this?"
- "If this disappeared tomorrow, what would happen?"

## Switch interview probes (5-10 min) — Bob Moesta forces

For interviewees who recently bought or built a solution to this problem:

- First thought: when did you first realize this was a problem?
- Passive looking: what triggered you to start looking?
- Active looking: what did you compare?
- Deciding: what nearly stopped you?
- Push (current pain) vs Pull (new solution promise) vs Anxiety (worry about new) vs Habit (sticking with current).

## Closing (5 min) — convert to design partner

- "If I built something that did X, would you want to be the first to try it? No commitment."
- "Could I follow up in two weeks?"
- Ask for 2 referrals: "Who else have you seen wrestling with this?"

## After the call (5 min)

- Write 3 verbatim quotes within 60 minutes while fresh.
- Note the SWITCH MOMENT in one sentence.
- Score: was this person an HXC (high-expectation customer)? 1-5.

BANNED QUESTIONS (do not generate any of these):

- "Would you pay for X?" (hypothetical)
- "Do you think X is a good idea?" (opinion)
- "How important is X on a scale of 1-10?" (vague)
- "What features would you want?" (feature factory bait)
- Any pitch.
