import katex from 'katex';

/**
 * Checks if the given text or HTML content contains any math notation or delimiters.
 */
export function hasMath(text: string): boolean {
  if (!text) return false;
  return /\$\$[\s\S]+?\$\$|\$[^$\n\r]+?\$|\\\[[\s\S]+?\\\]|\\\([\s\S]+?\\\)|\begin\{(?:equation|align|gather|matrix|pmatrix|bmatrix)\}/.test(text);
}

/**
 * Decodes HTML entities and strips intra-formula line breaks created by contenteditable editors.
 */
function decodeFormula(raw: string): string {
  return raw
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/<br\s*\/?>/gi, ' ')
    .trim();
}

/**
 * Safely renders a LaTeX formula into HTML with KaTeX.
 */
function renderFormula(raw: string, displayMode: boolean): string {
  const clean = decodeFormula(raw);
  if (!clean) return '';
  try {
    return katex.renderToString(clean, {
      displayMode,
      throwOnError: false,
      strict: false
    });
  } catch {
    return raw;
  }
}

/**
 * Renders LaTeX equations in speaker notes (supports $...$, $$...$$, \(...\), \[...\]).
 * Preserves all surrounding HTML tags, attributes, images, and links.
 */
export function renderMathInNotes(content: string): string {
  if (!content) return '';

  // 1. Display math $$ ... $$
  let result = content.replace(/\$\$([\s\S]+?)\$\$/g, (_match, formula) => {
    return renderFormula(formula, true);
  });

  // 2. Bracket display math \[ ... \]
  result = result.replace(/\\\[([\s\S]+?)\\\]/g, (_match, formula) => {
    return renderFormula(formula, true);
  });

  // 3. Parenthesis inline math \( ... \)
  result = result.replace(/\\\(([\s\S]+?)\\\)/g, (_match, formula) => {
    return renderFormula(formula, false);
  });

  // 4. Inline math $ ... $
  // Matches $...$ where opening $ is not escaped and closing $ is not immediately followed by digits
  result = result.replace(/(^|[^\\])\$([^\s\$](?:[\s\S]*?[^\s\$\\])?)\$/g, (match, prefix, formula) => {
    // Avoid matching if formula crosses HTML block tags
    if (/<(?:p|div|ul|ol|li|h[1-6]|table|blockquote)[\s\S]*>/i.test(formula)) {
      return match;
    }
    return prefix + renderFormula(formula, false);
  });

  return result;
}
