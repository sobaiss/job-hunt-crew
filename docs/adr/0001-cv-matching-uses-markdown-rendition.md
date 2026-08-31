# CV matching uses a Markdown rendition, not extracted structured data

The comparison step originally fed `ComparisonAnalysisAgent` a JSON summary of the
CV (`{skills, experience, education}`) produced by `CVExtractionAgent`, symmetric
with the JobOffer side. We replaced that: every CVVersion now has a **Markdown
rendition** (`CVVersion.markdownContent`) — the uploaded file itself when it is
already Markdown or plain text, otherwise mechanical text extraction plus one LLM
normalisation pass — and the comparison reads that Markdown directly.
`CVExtractionAgent`, `CVVersion.structuredData` / `structuredDataVer`, and
`parseStatus` leave the CV path, replaced by `conversionStatus`.

Why: the JSON summary was a lossy bottleneck — it dropped seniority signals,
career progression, phrasing, and quantified results the match could have used —
and an extra failure mode, while it was never shown to the candidate or read by
anything but the comparison. Feeding the whole CV is roughly cost-neutral here
because the conversion pass replaces the extraction call one-for-one, and its
result is cached on the row.

## Consequences

- The comparison is now asymmetric: JobOffer as structured JSON, CV as Markdown
  prose. Accepted deliberately; moving the JobOffer side to text is out of scope.
- Accepted CV upload formats widen from PDF/DOCX to PDF, DOCX, Markdown, and plain
  text. Scanned/image PDFs stay out of scope — a near-empty extraction is a failed
  conversion, not an OCR trigger.
- The Markdown rendition is a matching input, shown to the candidate read-only. It
  is not a "rewrite my CV" feature; the PRD §8.1 non-goal stands.
- `AnalysisWorkflow`'s `EnsureCVParsed` step becomes `EnsureCVConverted`. The API
  context gains a manual `POST /v1/cv-versions/{id}/convert` that drives the same
  conversion code off an SQS message; the pipeline step remains as the guarantee
  for CVs the candidate never converts by hand.
