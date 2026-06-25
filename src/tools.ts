import type { LexAPIClient } from './client.js';

interface ToolAnnotations {
  title: string;
  readOnlyHint: boolean;
  openWorldHint: boolean;
  idempotentHint?: boolean;
}

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: ToolAnnotations;
  handler: (args: Record<string, unknown>, client: LexAPIClient) => Promise<unknown>;
}

const READ_ONLY: Omit<ToolAnnotations, 'title'> = {
  readOnlyHint: true,
  openWorldHint: true,
  idempotentHint: true,
};

const LANGUAGES = [
  'en', 'fr', 'de', 'es', 'it', 'pl', 'nl', 'pt', 'ro', 'bg',
  'cs', 'da', 'el', 'et', 'fi', 'ga', 'hr', 'hu', 'lt', 'lv',
  'mt', 'sk', 'sl', 'sv',
];

const DOCUMENT_TYPES = [
  'judgment', 'opinion', 'order', 'regulation', 'directive',
  'decision', 'recommendation', 'opinion-act', 'communication',
  'proposal', 'report', 'resolution', 'declaration', 'treaty',
  'protocol', 'agreement', 'written-question', 'oral-question',
  'consolidated-text', 'guideline', 'implementing',
];

const AUTHORS = [
  'commission', 'council', 'parliament', 'court-of-justice',
  'general-court', 'ecb', 'eca', 'eesc', 'cor', 'ema', 'efsa',
];

const CITATION_TYPES = [
  'reference', 'amendment', 'repeal',
  'implementation', 'legal-basis', 'proposal',
];

const CELEX_PATTERN = '^[0-9A-Z]{2,20}$';

export const tools: ToolDef[] = [
  // ── Search ────────────────────────────────────────────────────────
  {
    name: 'lex_search',
    description:
      'Search EUR-Lex with structured filters (free text, date range, document type, author, language). Returns a paginated list of matching documents with CELEX numbers, titles, and dates. Use this when the user wants to find documents matching a topic or filter; use lex_get_document afterwards to fetch full content of a specific result.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Free-text search.' },
        textScope: {
          type: 'string',
          enum: ['title', 'text', 'title-text', 'any'],
          description: 'Where to apply the query string.',
        },
        dateFrom: { type: 'string', format: 'date' },
        dateTo: { type: 'string', format: 'date' },
        year: {
          oneOf: [
            { type: 'integer' },
            { type: 'array', items: { type: 'integer' } },
          ],
        },
        documentType: {
          oneOf: [
            { type: 'string', enum: DOCUMENT_TYPES },
            { type: 'array', items: { type: 'string', enum: DOCUMENT_TYPES } },
          ],
        },
        author: {
          oneOf: [
            { type: 'string', enum: AUTHORS },
            { type: 'array', items: { type: 'string', enum: AUTHORS } },
          ],
        },
        language: { type: 'string', enum: LANGUAGES, default: 'en' },
        maxPages: {
          type: 'integer',
          minimum: 1,
          default: 1,
          description: 'Result pages to fetch (clamped by subscription tier).',
        },
      },
      additionalProperties: false,
    },
    annotations: { title: 'Search EUR-Lex', ...READ_ONLY },
    handler: (args, client) => client.search(args as any),
  },

  // ── Document fetch ────────────────────────────────────────────────
  {
    name: 'lex_get_document',
    description:
      'Fetch the full parsed content of a single EU document by CELEX number. Returns metadata (title, type, dates, author, ECLI/ELI, keywords) plus structured body (articles, sections, tables, annexes). Articles are individually addressable with id, number, title, and content. Use this when the user has a specific CELEX or wants the body of a known document.',
    inputSchema: {
      type: 'object',
      required: ['celexNumber'],
      properties: {
        celexNumber: {
          type: 'string',
          pattern: CELEX_PATTERN,
          description: 'CELEX identifier, e.g. 32016R0679 for the GDPR.',
        },
        bypassCorpus: {
          type: 'boolean',
          description: 'Force a fresh live fetch instead of the cached copy.',
        },
      },
      additionalProperties: false,
    },
    annotations: { title: 'Fetch EU document by CELEX', ...READ_ONLY },
    handler: (args, client) => client.getDocument(args as any),
  },

  {
    name: 'lex_get_metadata',
    description:
      'Fetch metadata only for a CELEX (title, dates, type, author, ECLI/ELI, keywords, subjects) — significantly faster than lex_get_document because it skips body parsing. Use this for quick "what is this document" lookups or before deciding whether to fetch the body.',
    inputSchema: {
      type: 'object',
      required: ['celexNumber'],
      properties: {
        celexNumber: {
          type: 'string',
          pattern: CELEX_PATTERN,
          description: 'CELEX identifier.',
        },
      },
      additionalProperties: false,
    },
    annotations: { title: 'Fetch EU document metadata', ...READ_ONLY },
    handler: (args, client) => client.getMetadata(args as any),
  },

  {
    name: 'lex_get_document_by_url',
    description:
      'Fetch a parsed document from any EUR-Lex URL — useful when the user pastes a link from their browser. Extracts the CELEX from the URL and returns the same shape as lex_get_document plus sourceUrl and extractedCelex echoes.',
    inputSchema: {
      type: 'object',
      required: ['url'],
      properties: {
        url: {
          type: 'string',
          format: 'uri',
          description:
            'Any eur-lex.europa.eu URL containing a CELEX: identifier or uri= parameter.',
        },
      },
      additionalProperties: false,
    },
    annotations: { title: 'Fetch EU document by EUR-Lex URL', ...READ_ONLY },
    handler: (args, client) => client.getDocumentByUrl(args as any),
  },

  {
    name: 'lex_recent_documents',
    description:
      'List documents published to the Official Journal recently. Default window is 7 days. Filterable by document type, author, and language. Use this when the user asks "what was published this week" or wants a delta over a date window.',
    inputSchema: {
      type: 'object',
      properties: {
        days: {
          type: 'integer',
          minimum: 1,
          default: 7,
          description: 'Look-back window in days.',
        },
        documentType: { type: 'string', enum: DOCUMENT_TYPES },
        author: { type: 'string', enum: AUTHORS },
        language: { type: 'string', enum: LANGUAGES, default: 'en' },
        limit: { type: 'integer', minimum: 1, maximum: 500, default: 50 },
      },
      additionalProperties: false,
    },
    annotations: { title: 'List recent Official Journal documents', ...READ_ONLY, idempotentHint: false },
    handler: (args, client) => client.recentDocuments(args as any),
  },

  // ── Citation graph ────────────────────────────────────────────────
  {
    name: 'lex_cited_by',
    description:
      'Find documents that cite this CELEX (inbound edges). Returns source documents grouped with their edge type (reference, amendment, repeal, implementation, legal-basis, proposal). Use to see who depends on or modifies a given act.',
    inputSchema: {
      type: 'object',
      required: ['celexNumber'],
      properties: {
        celexNumber: { type: 'string', pattern: CELEX_PATTERN },
        citationType: {
          type: 'string',
          enum: CITATION_TYPES,
          description: 'Optionally filter to one edge type.',
        },
        limit: { type: 'integer', minimum: 1, maximum: 500, default: 100 },
        offset: { type: 'integer', minimum: 0, default: 0 },
      },
      additionalProperties: false,
    },
    annotations: { title: 'Find documents citing a CELEX', ...READ_ONLY },
    handler: (args, client) => {
      const { celexNumber, ...query } = args as any;
      return client.citedBy(celexNumber, query);
    },
  },

  {
    name: 'lex_cites',
    description:
      'Find documents this CELEX cites (outbound edges). Returns target documents grouped with their edge type. Use to see what an act relies on, amends, or implements.',
    inputSchema: {
      type: 'object',
      required: ['celexNumber'],
      properties: {
        celexNumber: { type: 'string', pattern: CELEX_PATTERN },
        citationType: { type: 'string', enum: CITATION_TYPES },
        limit: { type: 'integer', minimum: 1, maximum: 500, default: 100 },
        offset: { type: 'integer', minimum: 0, default: 0 },
      },
      additionalProperties: false,
    },
    annotations: { title: 'Find documents a CELEX cites', ...READ_ONLY },
    handler: (args, client) => {
      const { celexNumber, ...query } = args as any;
      return client.cites(celexNumber, query);
    },
  },

  {
    name: 'lex_citation_network',
    description:
      'Fetch both inbound and outbound citations for a CELEX in one call, with per-edge-type counts. Use when the user wants a holistic view of how a document sits in the citation graph.',
    inputSchema: {
      type: 'object',
      required: ['celexNumber'],
      properties: {
        celexNumber: { type: 'string', pattern: CELEX_PATTERN },
      },
      additionalProperties: false,
    },
    annotations: { title: 'Fetch full citation network for a CELEX', ...READ_ONLY },
    handler: (args, client) =>
      client.citationNetwork((args as any).celexNumber),
  },

  // ── Semantic ──────────────────────────────────────────────────────
  {
    name: 'lex_semantic_case_law',
    description:
      'Embedding-based search over EU case law — finds cases by meaning, not exact keywords. Returns relevance-scored matches with ECLI, court, case name/number, and (where available) full text. Requires a paid LexAPI plan; returns 403 on FREE tier.',
    inputSchema: {
      type: 'object',
      required: ['query'],
      properties: {
        query: { type: 'string', minLength: 1 },
        limit: { type: 'integer', minimum: 1, maximum: 50, default: 10 },
        min_score: {
          type: 'number',
          minimum: 0,
          maximum: 1,
          description: 'Drop results below this cosine similarity (0–1).',
        },
        filters: {
          type: 'object',
          additionalProperties: true,
          description:
            'Optional filters passed through to the LexAPI semantic backend. See the LexAPI docs at https://lex-api.com/docs for accepted filter keys (e.g. court, dateFrom, dateTo, ecli).',
        },
      },
      additionalProperties: false,
    },
    annotations: { title: 'Semantic search over EU case law', ...READ_ONLY },
    handler: (args, client) => client.semanticCaseLaw(args as any),
  },

  {
    name: 'lex_semantic_legislation',
    description:
      'Embedding-based search over EU legislation at article granularity. Returns relevance-scored article hits with parent CELEX, article reference, and law title. Requires a paid LexAPI plan; returns 403 on FREE tier.',
    inputSchema: {
      type: 'object',
      required: ['query'],
      properties: {
        query: { type: 'string', minLength: 1 },
        limit: { type: 'integer', minimum: 1, maximum: 50, default: 10 },
        min_score: { type: 'number', minimum: 0, maximum: 1 },
        filters: {
          type: 'object',
          additionalProperties: true,
          description:
            'Optional filters passed through to the LexAPI semantic backend. See the LexAPI docs at https://lex-api.com/docs for accepted filter keys (e.g. documentType, author, language, dateFrom, dateTo).',
        },
      },
      additionalProperties: false,
    },
    annotations: { title: 'Semantic search over EU legislation', ...READ_ONLY },
    handler: (args, client) => client.semanticLegislation(args as any),
  },
];

export const toolsByName: Record<string, ToolDef> = Object.fromEntries(
  tools.map((t) => [t.name, t]),
);
