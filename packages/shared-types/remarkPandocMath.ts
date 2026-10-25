import remarkMath from 'remark-math';
import type { Processor } from 'unified';
import {
  getMarkdownMathDelimitersAt,
  getMarkdownMathRangeAt,
  isEscapedMarkdownCharacter,
} from './markdownMathSyntax';

interface MathNode {
  type: string;
  value?: string;
  position?: { start: { offset?: number } };
  data?: object;
  children?: MathNode[];
}

function displayMath(node: MathNode, source: string) {
  const offset = node.position?.start.offset;
  return (
    node.type === 'inlineMath' &&
    offset !== undefined &&
    getMarkdownMathDelimitersAt(source, offset)?.display
  );
}

function displayPresentation(node: MathNode, source: string) {
  for (const child of node.children ?? []) displayPresentation(child, source);
  if (displayMath(node, source)) {
    node.data = { ...node.data, hProperties: { className: ['language-math', 'math-display'] } };
  }
  const child = node.children?.[0];
  if (
    node.type === 'paragraph' &&
    node.children?.length === 1 &&
    child &&
    displayMath(child, source)
  ) {
    node.type = 'math';
    node.value = child.value;
    node.data = {
      hName: 'pre',
      hChildren: [
        {
          type: 'element',
          tagName: 'code',
          properties: { className: ['language-math', 'math-display'] },
          children: [{ type: 'text', value: child.value }],
        },
      ],
    };
    delete node.children;
  }
}

function sourceCharacter(code: number | null) {
  if (code === null) return '';
  if (code === -1 || code === -2) return '\t';
  return code < 0 ? '\n' : String.fromCodePoint(code);
}

function presentDisplayMath(tree: MathNode, file: { toString(): string }) {
  displayPresentation(tree, file.toString());
}

/** Adapt the shared math grammar to Markdown tokens without changing source positions. */
export default function remarkPandocMath(this: Processor) {
  remarkMath.call(this);
  const extension = this.data().micromarkExtensions?.at(-1);
  const original = extension?.text?.[36];
  if (!extension?.text || !original || Array.isArray(original)) {
    throw new Error('The installed math extension must expose one dollar text construct.');
  }
  type Tokenizer = typeof original.tokenize;
  type State = ReturnType<Tokenizer>;
  const tokenize: Tokenizer = (effects, ok, nok) => {
    type TokenKind = Parameters<typeof effects.enter>[0];
    let source = '';
    let delimiters: NonNullable<ReturnType<typeof getMarkdownMathDelimitersAt>>;
    let inData = false;
    const probe: Tokenizer = (checkEffects, checkOk, checkNo) => {
      let suffix = '';
      const read: State = code => {
        if (suffix.length < delimiters.close.length) {
          if (sourceCharacter(code) !== delimiters.close[suffix.length]) return checkNo(code);
          checkEffects.consume(code);
          suffix += sourceCharacter(code);
          return read;
        }
        checkEffects.exit('mathTextSequence' as TokenKind);
        const candidate = source + suffix;
        const range = getMarkdownMathRangeAt(candidate + sourceCharacter(code), 0);
        return range?.end === candidate.length ? checkOk(code) : checkNo(code);
      };
      return code => {
        checkEffects.enter('mathTextSequence' as TokenKind);
        return read(code);
      };
    };
    const closing: State = code => {
      if (inData) effects.exit('mathTextData' as TokenKind);
      effects.enter('mathTextSequence' as TokenKind);
      let count = 0;
      const consume: State = next => {
        if (count < delimiters.close.length) {
          effects.consume(next);
          count++;
          return consume;
        }
        effects.exit('mathTextSequence' as TokenKind);
        effects.exit('mathText' as TokenKind);
        return ok(next);
      };
      return consume(code);
    };
    const consumeBody: State = code => {
      if (code === null) return nok(code);
      if (code === -3 || code === -4 || code === -5) {
        if (inData) effects.exit('mathTextData' as TokenKind);
        inData = false;
        effects.enter('lineEnding');
        effects.consume(code);
        effects.exit('lineEnding');
      } else {
        if (!inData) effects.enter('mathTextData' as TokenKind);
        inData = true;
        effects.consume(code);
      }
      source += sourceCharacter(code);
      return data;
    };
    const data: State = code => {
      if (code === null) return nok(code);
      if (
        sourceCharacter(code) === delimiters.close[0] &&
        !isEscapedMarkdownCharacter(source + sourceCharacter(code), source.length)
      ) {
        return effects.check({ tokenize: probe, partial: true }, closing, consumeBody)(code);
      }
      return consumeBody(code);
    };
    const opening: State = code => {
      const candidate = getMarkdownMathDelimitersAt(source + sourceCharacter(code), 0);
      if (!candidate) return nok(code);
      delimiters = candidate;
      if (candidate.open.length === 2) {
        if (code === null) return nok(code);
        effects.consume(code);
        source += sourceCharacter(code);
        effects.exit('mathTextSequence' as TokenKind);
        return data;
      }
      effects.exit('mathTextSequence' as TokenKind);
      return data(code);
    };
    const start: State = code => {
      if (code === null) return nok(code);
      effects.enter('mathText' as TokenKind);
      effects.enter('mathTextSequence' as TokenKind);
      effects.consume(code);
      source = sourceCharacter(code);
      return opening;
    };
    return start;
  };
  extension.text[36] = { name: 'pandocMath', tokenize };
  extension.text[92] = { name: 'pandocMath', tokenize };
  if (extension.flow) delete extension.flow[36];
  return presentDisplayMath;
}
