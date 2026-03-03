# AI Rules for Lumina Deep Reader

## Tech Stack

- **React 19** — UI framework for building the interactive application
- **TypeScript** — Type-safe development language
- **Vite 6** — Fast build tool and development server
- **Tailwind CSS** — Utility-first CSS framework for styling
- **shadcn/ui** — Prebuilt accessible UI components (use instead of building custom UI primitives)
- **lucide-react** — Icon library for all icons in the app
- **@google/genai** — Google Gemini AI integration for content generation and text-to-speech
- **jszip** — ZIP file processing for handling code archives
- **react-markdown** — Markdown content rendering
- **react-syntax-highlighter** — Syntax highlighting for code blocks in markdown

## Library Usage Rules

| Feature | Library | When to Use |
|---------|---------|-------------|
| UI Components | shadcn/ui | Use prebuilt components (Button, Dialog, DropdownMenu, etc.) for all interactive UI elements. Do not build custom UI primitives. |
| Icons | lucide-react | Use only lucide-react icons throughout the app. Import from `lucide-react`. |
| Styling | Tailwind CSS | Use Tailwind utility classes for all styling. Avoid custom CSS unless absolutely necessary. |
| Markdown Rendering | react-markdown | Render user-generated content, AI responses, and lesson content. |
| Code Highlighting | react-syntax-highlighter | Display code blocks within markdown content. |
| Math Equations | remark-math + rehype-katex | Render mathematical notation in markdown content. |
| File Processing | jszip | Handle ZIP file uploads for code base analysis. |
| AI Integration | @google/genai | All AI features: chat, content generation, text-to-speech, learning plan creation. |
| State Management | React hooks (useState, useEffect, useRef) | Use built-in React hooks. Avoid external state libraries. |
| Routing | React Router | Use React Router for navigation between pages. |

## Development Guidelines

1. **Always use shadcn/ui components** when available instead of building from scratch
2. **Keep all source code in `src/`** — pages in `src/pages/`, components in `src/components/`
3. **Run tests** with `npm run test` before completing any code change
4. **Run type checks** with `run_type_checks` to verify TypeScript correctness
5. **Use TypeScript** for all new files — no plain JavaScript
6. **Keep components small and focused** — one component per file, single responsibility
