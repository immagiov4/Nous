// Shared with the real parser test so visual generation tests can isolate process startup.
export const mermaidParseCases: [string, boolean][] = [
  [
    'classDiagram\n--- title: Il flusso end-to-end della software factory agent-assisted ---',
    false,
  ],
  ['classDiagram\nclass Animal {\n+String name\n}\nAnimal <|-- Duck', true],
  ['erDiagram\nCUSTOMER ||--o{ ORDER : places', true],
];
