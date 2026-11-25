// MCP prompts: guided workflows a user picks in the client (e.g. Claude's "+"
// menu). Each is a template the client's model follows with the LexAPI tools:
// the model does the reasoning, LexAPI supplies the law. Every prompt ends in a
// fixed report format and says that the report is not legal advice and does
// not establish that anyone complies.

import { z } from 'zod';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

const jurisdictionArg = () => z.string().optional().describe('Two-letter code of the country whose law applies (default "si", Slovenia).');

const DISCLAIMER = 'This is an informational review written by an AI model from the sources cited. It is not legal advice and does not establish that anyone complies with the law; have a qualified lawyer check anything you rely on.';

/** The rules every prompt shares. */
function common(code: string): string {
  return `Rules:
- Use only provisions you have read through the LexAPI tools in this conversation. Cite each one as act + article + identifier (CELEX number for EU law, LexAPI document id such as SI-PRED-ZAKO5944 for national law). Do not cite from memory; if a provision you would expect is not among the sources, say "not checked" instead of describing it.
- Start with lex_compliance_checklist (jurisdiction "${code}"). It returns the EU acts, the measures ${code.toUpperCase()} notified for them, the recorded amending acts and the matching national provisions with text. If you need a provision it did not return, use lex_national_semantic_legislation (jurisdiction "${code}") or lex_get_national_document for national law, and lex_get_document with articleId for EU law.
- Notified measures are notifications, not findings that a national act transposes the EU act completely. National consolidated texts are not authentic; only the official gazette is.
- If the user's facts needed for a point are missing, list them as open questions at the end instead of assuming them. Ask the user for them before the review only when the review cannot start without them.
- Keep the attribution of national sources (from the tool results) in a "Sources" section at the end.
- Write the report in the language the user writes in.
- End the report with this note, translated into that language: "${DISCLAIMER}"`;
}

function code(v: string | undefined): string {
  const c = (v ?? '').trim().toLowerCase();
  return /^[a-z]{2}$/.test(c) ? c : 'si';
}

function text(s: string) {
  return { messages: [{ role: 'user' as const, content: { type: 'text' as const, text: s } }] };
}

export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    'review_employment_contract',
    {
      title: 'Review an employment contract',
      description: 'Checks an employment contract against national labour law and the EU directives behind it (Slovenia first: ZDR-1). Paste the contract or attach it in the chat. Not legal advice.',
      argsSchema: {
        jurisdiction: jurisdictionArg(),
        contract: z.string().optional().describe('The contract text (or leave empty and paste or attach it in the chat).'),
        context: z.string().optional().describe('Facts that matter: fixed-term or open-ended, full or part time, remote work, sector, collective agreement.'),
      },
    },
    ({ jurisdiction, contract, context }) => {
      const c = code(jurisdiction);
      return text(`Review the employment contract below against the employment law of ${c.toUpperCase()} and the EU law behind it.

${contract?.trim() ? `Contract:\n"""\n${contract.trim()}\n"""` : 'The contract is pasted or attached in this conversation; if it is not, ask me for it and stop.'}
${context?.trim() ? `\nContext: ${context.trim()}\n` : ''}
Steps:
1. Call lex_compliance_checklist with topic "employment_contract" and jurisdiction "${c}". If the contract has unusual clauses (e.g. a non-compete, remote work, on-call duty), add one as focus.
2. Check the contract against what you read, at least: the mandatory content of the contract (for Slovenia ZDR-1 Art. 31; the written-information duty of Directive (EU) 2019/1152, Art. 4), fixed-term grounds and limits, working time, breaks, rest and annual leave, probation, notice periods and termination, non-compete and confidentiality clauses, remote work, pay and pay transparency.
3. For each clause: what the contract says, what the provision requires, and a finding.

Report format:
## Summary
Three to five sentences.
## Findings
A table: Clause / topic | Contract says | Provision (act, article, id) | Finding: "matches", "missing", "conflicts" or "check" | Note
## Missing mandatory content
Bullets, each with the provision that requires it.
## Recent changes to watch
The newest recorded amending acts from the tool result that touch this topic, if any.
## Open questions
Facts I need to give you.
## Sources

${common(c)}`);
    },
  );

  server.registerPrompt(
    'check_gdpr_documentation',
    {
      title: 'Check GDPR documentation',
      description: 'Checks an organisation\'s data-protection documents (privacy notice, records of processing, processor contracts, DPO, video surveillance) against the GDPR and national data-protection law (Slovenia first: ZVOP-2). Not legal advice.',
      argsSchema: {
        jurisdiction: jurisdictionArg(),
        organisation: z.string().optional().describe('Who the organisation is: sector, number of employees, what personal data it processes and why.'),
        documents: z.string().optional().describe('Which documents to check (or leave empty and paste or attach them in the chat).'),
      },
    },
    ({ jurisdiction, organisation, documents }) => {
      const c = code(jurisdiction);
      return text(`Check the data-protection documentation of my organisation against the GDPR and the data-protection law of ${c.toUpperCase()}.

${organisation?.trim() ? `Organisation: ${organisation.trim()}\n` : ''}${documents?.trim() ? `Documents:\n"""\n${documents.trim()}\n"""` : 'The documents are pasted or attached in this conversation; if none are, check what an organisation like mine must have and say that no document was reviewed.'}

Steps:
1. Call lex_compliance_checklist with topic "gdpr" and jurisdiction "${c}". Add a focus for anything specific to the organisation (e.g. video surveillance, biometrics, employee monitoring).
2. Check, at least: information to data subjects (GDPR Arts. 13–14), records of processing activities (Art. 30), processor contracts (Art. 28), security of processing (Art. 32), breach notification (Arts. 33–34), data protection impact assessment (Art. 35), data protection officer (Arts. 37–39), and the national rules the checklist returns (for Slovenia ZVOP-2, e.g. Art. 44 on the data protection officer, video surveillance, processing of employee data). Read each GDPR article you cite with lex_get_document (celex 32016R0679, articleId).
3. For each requirement: does it apply to this organisation, is it covered by a document, and where.

Report format:
## Summary
## Requirements
A table: Requirement | Provision (act, article, id) | Applies? | Covered by | Finding: "covered", "missing", "incomplete" or "check" | Note
## Gaps to close first
Ordered by importance, each with its provision.
## Recent changes to watch
## Open questions
## Sources

${common(c)}`);
    },
  );

  server.registerPrompt(
    'check_nis2_applicability',
    {
      title: 'Check whether NIS2 applies',
      description: 'Checks whether an organisation falls under NIS2 and the national cybersecurity law that implements it (Slovenia: ZInfV-1), and what that would require. Not legal advice.',
      argsSchema: {
        jurisdiction: jurisdictionArg(),
        sector: z.string().optional().describe('What the organisation does (sector and services).'),
        size: z.string().optional().describe('Employees, annual turnover and balance-sheet total.'),
        context: z.string().optional().describe('Anything else: part of a group, public body, provides services to essential entities, operates in other member states.'),
      },
    },
    ({ jurisdiction, sector, size, context }) => {
      const c = code(jurisdiction);
      const facts = [sector?.trim() && `Sector and services: ${sector.trim()}`, size?.trim() && `Size: ${size.trim()}`, context?.trim() && `Context: ${context.trim()}`].filter(Boolean).join('\n');
      return text(`Check whether my organisation falls under NIS2 and the cybersecurity law of ${c.toUpperCase()}, and what follows if it does.

${facts || 'I have not given the facts yet: ask me for sector and services, employees, annual turnover and balance-sheet total before you start.'}

Steps:
1. Call lex_compliance_checklist with topic "nis2" and jurisdiction "${c}". The measures ${c.toUpperCase()} notified for Directive (EU) 2022/2555 name the national law (for Slovenia ZInfV-1); read its scope provisions.
2. Decide scope step by step: sector (NIS2 Annexes I and II, read them with lex_get_document, celex 32022L2555), size (the size-cap rule in NIS2 Art. 2 and the exceptions that apply regardless of size), essential or important entity (Art. 3), and any national additions to the scope.
3. If in scope: governance and management liability (Art. 20), risk-management measures (Art. 21), incident reporting deadlines (Art. 23), registration (Art. 27), supervision and fines, with the national provisions for each.

Report format:
## Verdict on scope
"In scope as an essential entity", "in scope as an important entity", "probably out of scope" or "cannot tell yet", with the reasoning and provisions.
## Scope analysis
A table: Test | Provision (act, article, id) | Facts | Result
## If in scope: obligations
A table: Obligation | Provision | Deadline or frequency | What to prepare
## Recent changes to watch
## Open questions
## Sources

${common(c)}`);
    },
  );
}
