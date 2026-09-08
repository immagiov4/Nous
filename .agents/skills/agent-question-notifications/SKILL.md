---
name: agent-question-notifications
description: Show a persistent desktop note when a long-running agent task needs a user answer, including questions from PR reviews, local agents, or self-review. Answers remain in the original conversation.
---

# Agent question notifications

When a long-running task needs a decision, post the question in the conversation
where the user should answer and show a desktop note.
Use notices for actual questions, not routine updates or decisions already received.

## Send a notice

1. Use the bundled [scripts/questions.py](scripts/questions.py), or
   `AGENT_QUESTIONS_SCRIPT` if configured. Python 3.11 or later with Tk is required;
   Linux may require the `python3-tk` package and a local graphical session.
2. Write a UTF-8 JSON file with four fields:
   - `id`: a stable identifier for the project, task, and decision, such as
     `nous-pr164-review-storage-1`;
   - `source`: the agent and task;
   - `context`: the project, the title of the conversation where the user should
     answer, and the PR or document reference when applicable;
   - `question`: the complete question, with enough decision context and options
     to understand it without reading other subthreads.
3. Run `python <script-path> notify <json-file>` with properly quoted paths.
   Keep the text in the file, outside shell interpolation.
4. Check the result. Saving a notice does not prove that the window is visible:
   if no graphical session is available or startup fails, report that limitation
   in the conversation. Inspect `window.log` under `~/.agent-questions`, or the
   directory specified by `AGENT_QUESTIONS_HOME`. Avoid repeated attempts without
   new evidence.

Reuse the ID and content when retrying the same question. Previously dismissed
notes are also deduplicated. A changed question requires a new ID.
For delegated work, assign one owner and one ID to the question: either the agent
or the orchestrator sends the notice, without both notifying the same decision.

## Receive the decision

The “Ho letto” (“I've read it”) button only dismisses the note; it is not an answer
or approval. Read the answer in the original conversation and relay it to the
relevant agent when necessary. Continue independent authorized work while waiting.

To evaluate review findings before deciding whether a question is needed, use
[receiving-pr-reviews](../receiving-pr-reviews/SKILL.md).
