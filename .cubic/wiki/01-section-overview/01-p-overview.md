---
title: "Project Overview"
wiki_page_id: "p-overview"
---

# Project Overview

Nous Reader turns a topic or uploaded source material into a structured course. Learners move through lessons in order, ask questions about what they read, listen to lesson content and complete exercises.

## How the parts fit together

The web app presents the library and reader. A backend manages accounts, project data, source processing and longer generation tasks. PostgreSQL stores project information and learning progress; file storage holds uploaded documents and generated images.

Shared contracts keep the web app and backend aligned on saved project data and lesson requirements. The [system architecture](../02-section-architecture/01-p-architecture.md) explains how those parts work together.

## A course from source to lesson

Learners can start with a topic or upload documents. The app extracts useful text and builds a course plan. It then generates lessons, exercises and supporting visuals as needed.

A project keeps its course, lessons, settings and progress together. Learners can organize projects in their library and return to them later.

The [product manifesto](02-p-manifesto.md) describes the learning goals behind these features.
