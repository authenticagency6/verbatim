# Verbatim

Verbatim turns a mortgage team's calls into things a person reviews: follow-ups, tasks and
figures, each tied to the exact words it came from. Quote it or drop it; nothing counts until a
person approves it.

## Calls

**Call**:
One conversation between the team and a client, submitted as a transcript with the date it happened.
_Avoid_: recording, conversation, ticket

**Transcript**:
The words of a Call, one line per speaker turn. Only the redacted transcript is ever kept.
_Avoid_: raw text, script

**Redaction**:
Replacing sensitive identifiers in a Transcript with placeholders before anything is stored or read by the model.
_Avoid_: masking, scrubbing (scrubbing means removing real names from the public repo)

**Call status**:
Where a Call is in processing: processing, ready, or failed.

**Needs review**:
A flag on a Call saying the extraction looked weak (low confidence or a structural problem), so a person should look more carefully.
_Avoid_: flagged, warning

**Call context**:
The read-only summary shown above a Call's Proposals: the CRM note and the urgency.
_Avoid_: header, summary card

**Sample**:
A ready-made synthetic Call a viewer can load instead of pasting one.
_Avoid_: demo call, fixture (fixtures are the private regression calls)

## What comes out of a Call

**Extraction**:
Everything the model returned for one Call, before validation.
_Avoid_: output, result, response

**Proposal**:
Something the model says happened on the Call, backed by a Quote, waiting for a person to approve or reject it. Its kind is follow-up, task or figure.
_Avoid_: suggestion, card (a card is how a Proposal is drawn), item

**Follow-up**:
A Proposal that the team will get back to the client on a date.
_Avoid_: callback, reminder

**Task**:
A Proposal that someone has a concrete thing to do, with an owner and sometimes a due date.
_Avoid_: action item, to-do

**Figure**:
A Proposal that a number or date was said on the Call, such as a payment, an approved amount or a rate.
_Avoid_: guardrail (the engine's internal grouping), metric, stat

**Quote**:
The verbatim words from the Transcript that prove a Proposal. A value without a Quote never becomes a Proposal.
_Avoid_: evidence (the engine's field name), citation, source

**Highlight**:
Where a Quote sits in the Transcript, so a person sees the words in place. A Quote that can't be found is shown unhighlighted, never dropped.
_Avoid_: span (in conversation), anchor

**Dropped**:
A value the model returned that failed grounding or validation. It is shown with its reason and can never be approved.
_Avoid_: rejected (that's a person's decision), discarded, filtered

## Decisions

**Approve**:
A person accepting a Proposal. In slice 1 approved means done; nothing is sent or written elsewhere.
_Avoid_: accept, confirm, send

**Reject**:
A person refusing a Proposal. It cannot be undone or edited in slice 1.
_Avoid_: dismiss, decline, drop

**Reject reason**:
The optional why behind a Reject: wrong value, wrong person, not agreed, or other.

## Operations

**Run**:
The record of one model call for one Call: model, tokens, cost, duration and what failed validation. The only source for any cost or duration quoted publicly.
_Avoid_: job, execution, invocation

**Org**:
The team a Call belongs to. Slice 1 has one: the synthetic Tallbrook Home Loans.
_Avoid_: tenant, account, branch
