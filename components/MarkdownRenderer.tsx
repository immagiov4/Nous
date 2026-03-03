import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import rehypeRaw from 'rehype-raw';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneLight, oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';

interface MarkdownRendererProps {
  content: string;
  className?: string;
  isDarkMode?: boolean;
  onContextMenu?: (e: React.MouseEvent) => void;
}

const MarkdownRenderer: React.FC<MarkdownRendererProps> = ({ content, className = '', isDarkMode = false, onContextMenu }) => {
  return (
    <div 
      className={`prose max-w-none ${className}`}
      onContextMenu={onContextMenu}
    >
      <ReactMarkdown
        remarkPlugins={[remarkMath]}
        rehypePlugins={[rehypeKatex, rehypeRaw]}
        components={{
          code({ node, inline, className, children, ...props }: any) {
            const match = /language-(\w+)/.exec(className || '');
            return !inline && match ? (
              <div className="my-4 rounded-lg overflow-hidden shadow-sm border border-gray-200 dark:border-zinc-800">
                <SyntaxHighlighter
                  style={isDarkMode ? oneDark : oneLight}
                  language={match[1]}
                  PreTag="div"
                  customStyle={{
                    margin: 0,
                    padding: '1.5rem',
                    fontSize: '0.9rem',
                    backgroundColor: isDarkMode ? '#18181b' : '#f9fafb',
                  }}
                  {...props}
                >
                  {String(children).replace(/\n$/, '')}
                </SyntaxHighlighter>
              </div>
            ) : (
              <code className="bg-black/5 dark:bg-white/10 px-1.5 py-0.5 rounded text-sm font-mono font-bold inherit-color" {...props}>
                {children}
              </code>
            );
          },
          blockquote({ children }) {
            return (
              <blockquote className="border-l-4 border-current pl-4 py-2 italic opacity-80 my-2">
                {children}
              </blockquote>
            );
          },
          a({ href, children }) {
             return (
               <a href={href} target="_blank" rel="noopener noreferrer" className="underline decoration-1 underline-offset-2 hover:opacity-80">
                 {children}
               </a>
             );
          },
          // @ts-ignore
          mark({ children }) {
             return (
               <mark className="bg-orange-200 dark:bg-orange-900/50 text-gray-900 dark:text-white px-1 py-0.5 rounded mx-0.5 decoration-clone box-decoration-clone">
                 {children}
               </mark>
             );
          }
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
};

export default MarkdownRenderer;