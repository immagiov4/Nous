---
title: "Lesson Generation"
wiki_page_id: "p-lesson-gen"
---

# Lesson Generation

Lesson generation turns a course objective into a lesson the learner can read, hear and explore. It uses the approved course plan, relevant source material, and the learner’s course preferences.

## From objective to lesson

The workflow prepares the lesson context, gathers additional research when needed, drafts the content and checks its claims. It reviews the lesson against its objective and prerequisite order, then prepares visuals and saves the result.

A learner can also request a focused follow-up lesson based on an existing lesson. The new lesson keeps the course context while focusing on the requested question.

## Sources and factual support

The factual review checks whether a lesson’s claims are supported by its supplied material and research, including valid conclusions drawn from stated premises.

When matching a source across course and lesson generation, the system prefers an explicit source ID, then a normalized URL, then a normalized title. URL matching ignores case in the scheme and host and trims trailing slashes, while preserving path, query and fragment case.

## Visuals and exercises

A lesson can include illustrations, lesson scenes, HTML demonstrations, videos and quizzes. HTML examples can be static or interactive, but must not fetch external scripts or resources. Exercises follow the explanation they test and reveal their explanation after the learner answers.

The available visual formats and learning goals are described in the [product manifesto](../01-section-overview/02-p-manifesto.md). The shared quiz rules are in [Interactive exercises](08-p-interactive-exercises.md).

## Recovery and evaluation

Generation saves progress between stages so interrupted work can resume, while a failed attempt leaves the last saved lesson available.

Structural validation checks the lesson’s format. Factual and teaching reviews assess its supported claims and explanation.

Provider-backed evaluations use an authenticated, configured provider and store run evidence outside the repository. See [Testing and quality checks](../09-section-tools/02-p-testing-quality.md) for the safe evaluation setup and its limits.
