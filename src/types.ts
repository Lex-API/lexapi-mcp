// Types mirror the LexAPI OpenAPI spec at
// https://github.com/lexapi/eurlex-parser/blob/main/openapi.yaml
//
// Kept narrow on purpose — every endpoint response is much wider than this,
// but the MCP server only forwards the fields a model actually needs to
// reason about. Anything not modeled is passed through as `unknown`.

export type Language =
  | 'en' | 'fr' | 'de' | 'es' | 'it' | 'pl' | 'nl' | 'pt' | 'ro' | 'bg'
  | 'cs' | 'da' | 'el' | 'et' | 'fi' | 'ga' | 'hr' | 'hu' | 'lt' | 'lv'
  | 'mt' | 'sk' | 'sl' | 'sv';

export type DocumentType =
  | 'judgment' | 'opinion' | 'order' | 'regulation' | 'directive'
  | 'decision' | 'recommendation' | 'opinion-act' | 'communication'
  | 'proposal' | 'report' | 'resolution' | 'declaration' | 'treaty'
  | 'protocol' | 'agreement' | 'written-question' | 'oral-question'
  | 'consolidated-text' | 'guideline' | 'implementing';

export type Author =
  | 'commission' | 'council' | 'parliament' | 'court-of-justice'
  | 'general-court' | 'ecb' | 'eca' | 'eesc' | 'cor' | 'ema' | 'efsa';

export type CitationType =
  | 'reference' | 'amendment' | 'repeal'
  | 'implementation' | 'legal-basis' | 'proposal';

export interface SearchRequest {
  query?: string;
  textScope?: 'title' | 'text' | 'title-text' | 'any';
  dateFrom?: string;
  dateTo?: string;
  year?: number | number[];
  month?: number | number[];
  documentType?: DocumentType | DocumentType[];
  author?: Author | Author[];
  domain?: 'EU_LAW' | 'NATIONAL_LAW' | 'ALL';
  subdomain?: string | string[];
  language?: Language;
  maxPages?: number;
}

export interface DocumentContentRequest {
  celexNumber: string;
  bypassCorpus?: boolean;
}

export interface RecentDocumentsQuery {
  days?: number;
  documentType?: DocumentType;
  author?: Author;
  domain?: string;
  subdomain?: string;
  language?: Language;
  limit?: number;
}

export interface CitationsQuery {
  limit?: number;
  offset?: number;
  citationType?: CitationType;
}

export interface SemanticSearchRequest {
  query: string;
  limit?: number;
  min_score?: number;
  filters?: Record<string, unknown>;
}

// Response shapes are intentionally permissive — the model consumes them as
// JSON. We keep them typed-but-open so changes server-side don't break us.
export type AnyResponse = Record<string, unknown>;
