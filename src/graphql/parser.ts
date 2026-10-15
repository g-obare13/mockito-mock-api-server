/**
 * A small, dependency-free GraphQL *query* parser. It understands documents,
 * operations, fragments, inline fragments, aliases, arguments, variables and
 * directives — everything needed to project mock data. It deliberately does
 * not validate against a schema.
 */

/** A selected field, with optional alias, arguments and nested selection. */
export interface FieldNode {
  kind: 'field';
  name: string;
  alias: string | null;
  args: Record<string, unknown>;
  directives: string[];
  selection: SelectionNode[];
}

/** A `...FragmentName` spread. */
export interface SpreadNode {
  kind: 'spread';
  name: string;
}

/** An inline fragment, optionally constrained to a type. */
export interface InlineFragmentNode {
  kind: 'inline';
  typeCondition: string | null;
  selection: SelectionNode[];
}

/** Any node that can appear inside a selection set. */
export type SelectionNode = FieldNode | SpreadNode | InlineFragmentNode;

/** A named or anonymous operation. */
export interface OperationNode {
  kind: 'operation';
  operation: 'query' | 'mutation' | 'subscription';
  name: string | null;
  selection: SelectionNode[];
}

/** A named fragment definition. */
export interface FragmentNode {
  kind: 'fragment';
  name: string;
  typeCondition: string;
  selection: SelectionNode[];
}

/** A parsed GraphQL document: its operations and fragment lookup table. */
export interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, FragmentNode>;
}

/** Thrown when a query cannot be lexed or parsed. */
export class GraphQLSyntaxError extends Error {
  constructor(message: string, public position: number) {
    super(`${message} (at position ${position})`);
    this.name = 'GraphQLSyntaxError';
  }
}

/* -------------------------------------------------------------------------- */
/*  Lexer                                                                     */
/* -------------------------------------------------------------------------- */

type TokenType = 'name' | 'int' | 'float' | 'string' | 'punct' | 'eof';

interface Token {
  type: TokenType;
  value: string;
  pos: number;
}

const PUNCTUATORS = new Set(['!', '$', '(', ')', ':', '=', '@', '[', ']', '{', '}', '|', '&']);

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = source.length;

  while (i < n) {
    const ch = source[i]!;

    // Ignore whitespace, commas and BOM.
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === '\uFEFF') {
      i++;
      continue;
    }

    // Comments.
    if (ch === '#') {
      while (i < n && source[i] !== '\n') i++;
      continue;
    }

    // Spread operator.
    if (ch === '.') {
      if (source.slice(i, i + 3) === '...') {
        tokens.push({ type: 'punct', value: '...', pos: i });
        i += 3;
        continue;
      }
      throw new GraphQLSyntaxError('Unexpected "."', i);
    }

    if (PUNCTUATORS.has(ch)) {
      tokens.push({ type: 'punct', value: ch, pos: i });
      i++;
      continue;
    }

    // Block string.
    if (source.slice(i, i + 3) === '"""') {
      i += 3;
      let value = '';
      while (i < n && source.slice(i, i + 3) !== '"""') {
        value += source[i];
        i++;
      }
      if (i >= n) throw new GraphQLSyntaxError('Unterminated block string', i);
      i += 3;
      tokens.push({ type: 'string', value: value.trim(), pos: i });
      continue;
    }

    // String literal.
    if (ch === '"') {
      const start = i;
      i++;
      let value = '';
      while (i < n && source[i] !== '"') {
        const c = source[i]!;
        if (c === '\\') {
          const nextChar = source[i + 1];
          switch (nextChar) {
            case 'n': value += '\n'; break;
            case 't': value += '\t'; break;
            case 'r': value += '\r'; break;
            case 'b': value += '\b'; break;
            case 'f': value += '\f'; break;
            case '"': value += '"'; break;
            case '\\': value += '\\'; break;
            case '/': value += '/'; break;
            case 'u': {
              const hex = source.slice(i + 2, i + 6);
              value += String.fromCharCode(parseInt(hex, 16));
              i += 4;
              break;
            }
            default: value += nextChar ?? '';
          }
          i += 2;
          continue;
        }
        value += c;
        i++;
      }
      if (i >= n) throw new GraphQLSyntaxError('Unterminated string', start);
      i++;
      tokens.push({ type: 'string', value, pos: start });
      continue;
    }

    // Number.
    if (ch === '-' || (ch >= '0' && ch <= '9')) {
      const start = i;
      if (ch === '-') i++;
      while (i < n && source[i]! >= '0' && source[i]! <= '9') i++;
      let isFloat = false;
      if (source[i] === '.') {
        isFloat = true;
        i++;
        while (i < n && source[i]! >= '0' && source[i]! <= '9') i++;
      }
      if (source[i] === 'e' || source[i] === 'E') {
        isFloat = true;
        i++;
        if (source[i] === '+' || source[i] === '-') i++;
        while (i < n && source[i]! >= '0' && source[i]! <= '9') i++;
      }
      tokens.push({ type: isFloat ? 'float' : 'int', value: source.slice(start, i), pos: start });
      continue;
    }

    // Name.
    if (/[_A-Za-z]/.test(ch)) {
      const start = i;
      while (i < n && /[_0-9A-Za-z]/.test(source[i]!)) i++;
      tokens.push({ type: 'name', value: source.slice(start, i), pos: start });
      continue;
    }

    throw new GraphQLSyntaxError(`Unexpected character ${JSON.stringify(ch)}`, i);
  }

  tokens.push({ type: 'eof', value: '', pos: n });
  return tokens;
}

/* -------------------------------------------------------------------------- */
/*  Parser                                                                    */
/* -------------------------------------------------------------------------- */

class Parser {
  private tokens: Token[];
  private pos = 0;
  private variables: Record<string, unknown>;

  constructor(source: string, variables: Record<string, unknown>) {
    this.tokens = lex(source);
    this.variables = { ...variables };
  }

  private peek(): Token {
    return this.tokens[this.pos]!;
  }

  private next(): Token {
    return this.tokens[this.pos++]!;
  }

  private isPunct(value: string): boolean {
    const token = this.peek();
    return token.type === 'punct' && token.value === value;
  }

  private isName(value: string): boolean {
    const token = this.peek();
    return token.type === 'name' && token.value === value;
  }

  private expectPunct(value: string): Token {
    const token = this.peek();
    if (token.type !== 'punct' || token.value !== value) {
      throw new GraphQLSyntaxError(`Expected "${value}" but found ${describe(token)}`, token.pos);
    }
    return this.next();
  }

  private expectName(): string {
    const token = this.peek();
    if (token.type !== 'name') {
      throw new GraphQLSyntaxError(`Expected a name but found ${describe(token)}`, token.pos);
    }
    return this.next().value;
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, FragmentNode>();

    while (this.peek().type !== 'eof') {
      if (this.isName('fragment')) {
        const fragment = this.parseFragment();
        fragments.set(fragment.name, fragment);
      } else {
        operations.push(this.parseOperation());
      }
    }

    if (operations.length === 0) {
      throw new GraphQLSyntaxError('No executable operation found', 0);
    }
    return { operations, fragments };
  }

  private parseFragment(): FragmentNode {
    this.next(); // `fragment`
    const name = this.expectName();
    if (!this.isName('on')) {
      throw new GraphQLSyntaxError('Expected "on" in fragment definition', this.peek().pos);
    }
    this.next();
    const typeCondition = this.expectName();
    this.parseDirectives();
    const selection = this.parseSelectionSet();
    return { kind: 'fragment', name, typeCondition, selection };
  }

  private parseOperation(): OperationNode {
    let operation: OperationNode['operation'] = 'query';
    let name: string | null = null;

    if (this.isName('query') || this.isName('mutation') || this.isName('subscription')) {
      operation = this.next().value as OperationNode['operation'];
      if (this.peek().type === 'name') name = this.next().value;
    } else if (this.peek().type === 'name' && !this.isPunct('{')) {
      // Lenient: allow a bare operation name.
      name = this.next().value;
    }

    this.parseVariableDefinitions();
    this.parseDirectives();
    const selection = this.parseSelectionSet();
    return { kind: 'operation', operation, name, selection };
  }

  private parseVariableDefinitions(): void {
    if (!this.isPunct('(')) return;
    this.next();
    while (!this.isPunct(')')) {
      this.expectPunct('$');
      const name = this.expectName();
      this.expectPunct(':');
      this.parseTypeReference();
      if (this.isPunct('=')) {
        this.next();
        const defaultValue = this.parseValue();
        if (this.variables[name] === undefined) this.variables[name] = defaultValue;
      }
      if (this.peek().type === 'eof') throw new GraphQLSyntaxError('Unterminated variable definitions', this.peek().pos);
    }
    this.expectPunct(')');
  }

  private parseTypeReference(): void {
    if (this.isPunct('[')) {
      this.next();
      this.parseTypeReference();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    if (this.isPunct('!')) this.next();
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!this.isPunct('}')) {
      if (this.peek().type === 'eof') throw new GraphQLSyntaxError('Unterminated selection set', this.peek().pos);
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): SelectionNode {
    if (this.isPunct('...')) {
      this.next();
      if (this.isName('on')) {
        this.next();
        const typeCondition = this.expectName();
        this.parseDirectives();
        const selection = this.parseSelectionSet();
        return { kind: 'inline', typeCondition, selection };
      }
      const name = this.expectName();
      this.parseDirectives();
      return { kind: 'spread', name };
    }
    return this.parseField();
  }

  private parseField(): FieldNode {
    let name = this.expectName();
    let alias: string | null = null;

    if (this.isPunct(':')) {
      this.next();
      alias = name;
      name = this.expectName();
    }

    const args = this.parseArguments();
    const directives = this.parseDirectives();
    const selection = this.isPunct('{') ? this.parseSelectionSet() : [];
    return { kind: 'field', name, alias, args, directives, selection };
  }

  private parseArguments(): Record<string, unknown> {
    const args: Record<string, unknown> = {};
    if (!this.isPunct('(')) return args;
    this.next();
    while (!this.isPunct(')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args[name] = this.parseValue();
      if (this.peek().type === 'eof') throw new GraphQLSyntaxError('Unterminated arguments', this.peek().pos);
    }
    this.expectPunct(')');
    return args;
  }

  private parseDirectives(): string[] {
    const directives: string[] = [];
    while (this.isPunct('@')) {
      this.next();
      directives.push(this.expectName());
      this.parseArguments();
    }
    return directives;
  }

  private parseValue(): unknown {
    const token = this.next();

    if (token.type === 'int') return parseInt(token.value, 10);
    if (token.type === 'float') return parseFloat(token.value);
    if (token.type === 'string') return token.value;

    if (token.type === 'punct' && token.value === '$') {
      const name = this.expectName();
      return this.variables[name];
    }
    if (token.type === 'punct' && token.value === '[') {
      const list: unknown[] = [];
      while (!this.isPunct(']')) list.push(this.parseValue());
      this.expectPunct(']');
      return list;
    }
    if (token.type === 'punct' && token.value === '{') {
      const object: Record<string, unknown> = {};
      while (!this.isPunct('}')) {
        const key = this.expectName();
        this.expectPunct(':');
        object[key] = this.parseValue();
      }
      this.expectPunct('}');
      return object;
    }

    if (token.type === 'name') {
      if (token.value === 'true') return true;
      if (token.value === 'false') return false;
      if (token.value === 'null') return null;
      return token.value; // enum value
    }

    throw new GraphQLSyntaxError(`Unexpected value ${describe(token)}`, token.pos);
  }
}

function describe(token: Token): string {
  if (token.type === 'eof') return 'end of input';
  return `"${token.value}"`;
}

/** Parse a GraphQL document/query string into an AST. */
export function parseGraphQL(source: string, variables: Record<string, unknown> = {}): DocumentNode {
  return new Parser(source, variables).parseDocument();
}

/** Select the operation to execute from a parsed document. */
export function selectOperation(doc: DocumentNode, operationName?: string | null): OperationNode {
  if (operationName) {
    const match = doc.operations.find((op) => op.name === operationName);
    if (!match) throw new GraphQLSyntaxError(`Unknown operation "${operationName}"`, 0);
    return match;
  }
  if (doc.operations.length > 1) {
    throw new GraphQLSyntaxError('Must provide operationName when the document has multiple operations', 0);
  }
  return doc.operations[0]!;
}
