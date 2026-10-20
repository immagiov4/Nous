---
title: "Projects and Workspace"
wiki_page_id: "p-project-workspace"
---

# Projects and Workspace

A project brings a learner’s source material, course, lessons and study progress together. The library helps organize projects into folders and return to them later.

## Saving changes

Nous saves course changes and learner progress as the project changes. If two sessions edit the same project, the server checks the project revision before accepting a save. A conflict asks the client to reload or reconcile the latest version instead of silently replacing it.

Some small changes, such as navigation or notes, can be saved without sending the entire project. If a save is still in progress, the app keeps subsequent changes pending and sends them after it finishes.

## Organizing projects

Learners can create, rename and move folders, and move projects between folders. Deleting a folder moves its contents to the parent folder; it does not delete the projects.

## Sources and files

A project can use one or more uploaded files. ZIP sources can be browsed through an index of their files. Source files are stored separately from project details, and each uploaded source belongs to its project; matching files in different projects are stored separately.

Generated lesson images are also stored apart from lesson text. A workflow prepares a file before the project saves a reference to it. If the project save fails, the unused file can be cleaned up.

## Import and export

Learners can export one project or the full library. A library export prepares projects one at a time and records progress so it can continue after a server restart. If a project changes during preparation, the attempt fails; when the learner retries, Nous starts a new export with a fresh library snapshot.

Imports convert older project archives to the current format. References to images and PDF pages are updated when the imported archive contains the corresponding files; unmatched references remain available for review.

The browser can start a download after the server verifies an export, but it cannot confirm that the file was saved on the learner’s device. For file storage and restore details, see [Project files and storage](../04-section-data/02-p-asset-management.md).
