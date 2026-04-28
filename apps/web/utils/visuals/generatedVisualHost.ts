export const GENERATED_VISUAL_HOST_STYLES = `
:root {
  --font-serif: "Merriweather", serif;
  --font-sans: "Inter", sans-serif;
  --bg-paper: #fdfbf7;
  --bg-surface: #ffffff;
  --ink-primary: #1f1f1f;
  --ink-secondary: #4a4a4a;
  --accent: #d97757;
  --border-subtle: rgba(229, 231, 235, 1);
  --border-strong: rgba(209, 213, 219, 1);
  --color-background-primary: transparent;
  --color-background-secondary: var(--bg-surface);
  --color-background-tertiary: var(--bg-paper);
  --color-background-info: #fafafa;
  --color-text-primary: var(--ink-primary);
  --color-text-secondary: var(--ink-secondary);
  --color-border-tertiary: var(--border-subtle);
  --color-border-primary: var(--ink-primary);
}
html.dark {
  --bg-paper: #252526;
  --bg-surface: #2f3031;
  --ink-primary: #e4e4e7;
  --ink-secondary: #a1a1aa;
  --accent: #fb923c;
  --border-subtle: rgba(113, 113, 122, 0.6);
  --border-strong: rgba(161, 161, 170, 0.78);
  --color-background-primary: transparent;
  --color-background-secondary: var(--bg-surface);
  --color-background-tertiary: var(--bg-paper);
  --color-background-info: var(--bg-paper);
  --color-text-primary: var(--ink-primary);
  --color-text-secondary: var(--ink-secondary);
  --color-border-tertiary: var(--border-subtle);
  --color-border-primary: var(--ink-primary);
}
html {
  background: transparent;
  overflow: hidden;
}
body {
  margin: 0;
  padding: 0;
  overflow: hidden;
  background: transparent;
  color: var(--ink-primary);
  font-family: var(--font-sans), system-ui, sans-serif;
}
svg {
  display: block;
  width: 100%;
  height: auto;
  overflow: visible;
}
.t  { font: 400 14px/1.5 var(--font-sans); fill: var(--color-text-primary) }
.ts { font: 400 12px/1.5 var(--font-sans); fill: var(--color-text-secondary) }
.th { font: 500 14px/1.5 var(--font-sans); fill: var(--color-text-primary) }
.box { fill: var(--color-background-secondary); stroke: var(--color-border-tertiary); stroke-width: .5 }
.node { cursor: pointer }
.node:hover { opacity: .85 }
.arr { fill: none; stroke: var(--color-border-primary); stroke-width: 1.5 }
.leader { fill: none; stroke: var(--color-border-tertiary); stroke-width: .5; stroke-dasharray: 3 3 }
.c-purple rect,.c-purple circle,.c-purple ellipse { fill:#EEEDFE; stroke:#534AB7; stroke-width:.5 }
.c-purple .t,.c-purple .th { fill:#3C3489 }
.c-purple .ts { fill:#534AB7 }
.c-teal rect,.c-teal circle,.c-teal ellipse { fill:#E1F5EE; stroke:#0F6E56; stroke-width:.5 }
.c-teal .t,.c-teal .th { fill:#085041 }
.c-teal .ts { fill:#0F6E56 }
.c-coral rect,.c-coral circle,.c-coral ellipse { fill:#FAECE7; stroke:#993C1D; stroke-width:.5 }
.c-coral .t,.c-coral .th { fill:#712B13 }
.c-coral .ts { fill:#993C1D }
.c-blue rect,.c-blue circle,.c-blue ellipse { fill:#E6F1FB; stroke:#185FA5; stroke-width:.5 }
.c-blue .t,.c-blue .th { fill:#0C447C }
.c-blue .ts { fill:#185FA5 }
.c-amber rect,.c-amber circle,.c-amber ellipse { fill:#FAEEDA; stroke:#854F0B; stroke-width:.5 }
.c-amber .t,.c-amber .th { fill:#633806 }
.c-amber .ts { fill:#854F0B }
.c-gray rect,.c-gray circle,.c-gray ellipse { fill:#F1EFE8; stroke:#5F5E5A; stroke-width:.5 }
.c-gray .t,.c-gray .th { fill:#444441 }
.c-gray .ts { fill:#5F5E5A }
.c-green rect,.c-green circle,.c-green ellipse { fill:#EAF3DE; stroke:#3B6D11; stroke-width:.5 }
.c-green .t,.c-green .th { fill:#27500A }
.c-green .ts { fill:#3B6D11 }
.c-red rect,.c-red circle,.c-red ellipse { fill:#FCEBEB; stroke:#A32D2D; stroke-width:.5 }
.c-red .t,.c-red .th { fill:#791F1F }
.c-red .ts { fill:#A32D2D }
.c-pink rect,.c-pink circle,.c-pink ellipse { fill:#FBEAF0; stroke:#993556; stroke-width:.5 }
.c-pink .t,.c-pink .th { fill:#72243E }
.c-pink .ts { fill:#993556 }
html.dark .c-purple rect, html.dark .c-purple circle, html.dark .c-purple ellipse { fill:#3C3489; stroke:#AFA9EC }
html.dark .c-purple .t, html.dark .c-purple .th { fill:#CECBF6 }
html.dark .c-purple .ts { fill:#AFA9EC }
html.dark .c-teal rect, html.dark .c-teal circle, html.dark .c-teal ellipse { fill:#085041; stroke:#5DCAA5 }
html.dark .c-teal .t, html.dark .c-teal .th { fill:#9FE1CB }
html.dark .c-teal .ts { fill:#5DCAA5 }
html.dark .c-blue rect, html.dark .c-blue circle, html.dark .c-blue ellipse { fill:#0C447C; stroke:#85B7EB }
html.dark .c-blue .t, html.dark .c-blue .th { fill:#B5D4F4 }
html.dark .c-blue .ts { fill:#85B7EB }
html.dark .c-gray rect, html.dark .c-gray circle, html.dark .c-gray ellipse { fill:#444441; stroke:#B4B2A9 }
html.dark .c-gray .t, html.dark .c-gray .th { fill:#D3D1C7 }
html.dark .c-gray .ts { fill:#B4B2A9 }
html.dark .c-amber rect, html.dark .c-amber circle, html.dark .c-amber ellipse { fill:#633806; stroke:#EF9F27 }
html.dark .c-amber .t, html.dark .c-amber .th { fill:#FAC775 }
html.dark .c-amber .ts { fill:#EF9F27 }
html.dark .c-coral rect, html.dark .c-coral circle, html.dark .c-coral ellipse { fill:#712B13; stroke:#F0997B }
html.dark .c-coral .t, html.dark .c-coral .th { fill:#F5C4B3 }
html.dark .c-coral .ts { fill:#F0997B }
html.dark svg text:not(.t):not(.ts):not(.th) {
  fill: var(--ink-primary);
}
html.dark svg text[fill="#000"],
html.dark svg text[fill="#000000"],
html.dark svg text[fill="#111"],
html.dark svg text[fill="#111111"],
html.dark svg text[fill="#1f1f1f"],
html.dark svg text[fill="#1F1F1F"],
html.dark svg text[fill="#1e293b"],
html.dark svg text[fill="#1E293B"],
html.dark svg text[fill="#334155"],
html.dark svg text[fill="#334155"],
html.dark svg text[fill="#374151"],
html.dark svg text[fill="#374151"],
html.dark svg text[fill="#4a4a4a"],
html.dark svg text[fill="#4A4A4A"],
html.dark svg text[fill="#555"],
html.dark svg text[fill="#555555"],
html.dark svg tspan[fill="#000"],
html.dark svg tspan[fill="#000000"],
html.dark svg tspan[fill="#1f1f1f"],
html.dark svg tspan[fill="#1F1F1F"],
html.dark svg tspan[fill="#1e293b"],
html.dark svg tspan[fill="#1E293B"],
html.dark svg tspan[fill="#334155"],
html.dark svg tspan[fill="#334155"],
html.dark svg tspan[fill="#374151"],
html.dark svg tspan[fill="#374151"],
html.dark svg tspan[fill="#4a4a4a"],
html.dark svg tspan[fill="#4A4A4A"] {
  fill: var(--ink-primary);
}
html.dark svg rect[fill="#fff"],
html.dark svg rect[fill="#FFF"],
html.dark svg rect[fill="#ffffff"],
html.dark svg rect[fill="#FFFFFF"],
html.dark svg rect[fill="white"],
html.dark svg rect[fill="#f8f8f8"],
html.dark svg rect[fill="#F8F8F8"],
html.dark svg rect[fill="#f4f4f4"],
html.dark svg rect[fill="#F4F4F4"],
html.dark svg rect[fill="#f3f4f6"],
html.dark svg rect[fill="#F3F4F6"],
html.dark svg rect[fill="#f1f5f9"],
html.dark svg rect[fill="#F1F5F9"] {
  fill: var(--bg-surface);
}
html.dark svg path[fill="#fff"],
html.dark svg path[fill="#FFF"],
html.dark svg path[fill="#ffffff"],
html.dark svg path[fill="#FFFFFF"],
html.dark svg path[fill="white"],
html.dark svg polygon[fill="#fff"],
html.dark svg polygon[fill="#FFF"],
html.dark svg polygon[fill="#ffffff"],
html.dark svg polygon[fill="#FFFFFF"],
html.dark svg polygon[fill="white"],
html.dark svg polyline[fill="#fff"],
html.dark svg polyline[fill="#FFF"],
html.dark svg polyline[fill="#ffffff"],
html.dark svg polyline[fill="#FFFFFF"],
html.dark svg polyline[fill="white"] {
  fill: var(--bg-paper);
}
html.dark svg rect[stroke="#ddd"],
html.dark svg rect[stroke="#DDD"],
html.dark svg rect[stroke="#d1d5db"],
html.dark svg rect[stroke="#D1D5DB"],
html.dark svg rect[stroke="#bbb"],
html.dark svg rect[stroke="#BBB"],
html.dark svg rect[stroke="#aaa"],
html.dark svg rect[stroke="#AAA"] {
  stroke: var(--border-strong);
}
html.dark svg path[stroke="#888"],
html.dark svg path[stroke="#888888"],
html.dark svg path[stroke="#999"],
html.dark svg path[stroke="#999999"],
html.dark svg path[stroke="#94a3b8"],
html.dark svg path[stroke="#94A3B8"],
html.dark svg path[stroke="#64748b"],
html.dark svg path[stroke="#64748B"],
html.dark svg line[stroke="#888"],
html.dark svg line[stroke="#888888"],
html.dark svg line[stroke="#94a3b8"],
html.dark svg line[stroke="#94A3B8"],
html.dark svg polyline[stroke="#888"],
html.dark svg polyline[stroke="#888888"],
html.dark svg polyline[stroke="#94a3b8"],
html.dark svg polyline[stroke="#94A3B8"],
html.dark svg polygon[stroke="#888"],
html.dark svg polygon[stroke="#888888"],
html.dark svg polygon[stroke="#94a3b8"],
html.dark svg polygon[stroke="#94A3B8"] {
  stroke: var(--ink-secondary);
}
`;
