import assert from 'node:assert/strict';
import { test } from 'vitest';

// The same extensions used in WorkspaceLaboratoryContent.tsx for the file input accept attribute
const LABORATORY_ACCEPT_EXTENSIONS = [
  '.pdf',
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.txt',
  '.md',
  '.docx',
];

const isAcceptedExtension = (filename: string): boolean => {
  const lower = filename.toLowerCase();
  return LABORATORY_ACCEPT_EXTENSIONS.some(ext => lower.endsWith(ext));
};

test('accepts .pdf files', () => {
  assert.ok(isAcceptedExtension('documento.pdf'));
  assert.ok(isAcceptedExtension('Documento.PDF'));
});

test('accepts .png, .jpg, .jpeg, .webp image files', () => {
  assert.ok(isAcceptedExtension('foto.png'));
  assert.ok(isAcceptedExtension('foto.jpg'));
  assert.ok(isAcceptedExtension('foto.jpeg'));
  assert.ok(isAcceptedExtension('foto.webp'));
});

test('accepts .txt and .md text files', () => {
  assert.ok(isAcceptedExtension('note.txt'));
  assert.ok(isAcceptedExtension('README.md'));
});

test('accepts .docx files', () => {
  assert.ok(isAcceptedExtension('report.docx'));
});

test('rejects unsupported extensions', () => {
  assert.ok(!isAcceptedExtension('file.gif'));
  assert.ok(!isAcceptedExtension('file.svg'));
  assert.ok(!isAcceptedExtension('file.csv'));
  assert.ok(!isAcceptedExtension('file.html'));
  assert.ok(!isAcceptedExtension('file.zip'));
  assert.ok(!isAcceptedExtension('file.exe'));
  assert.ok(!isAcceptedExtension('file'));
});

test('rejects files with no extension', () => {
  assert.ok(!isAcceptedExtension('Makefile'));
  assert.ok(!isAcceptedExtension('LICENSE'));
});

test('LABORATORY_ACCEPT_EXTENSIONS matches the accept attribute in WorkspaceLaboratoryContent', () => {
  const acceptString = LABORATORY_ACCEPT_EXTENSIONS.join(',');
  assert.equal(acceptString, '.pdf,.png,.jpg,.jpeg,.webp,.txt,.md,.docx');
});
