import { truncate } from "@/lib/text-truncation";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

// Renders `truncate()`'s output (#128), reused as-is by Analyses, CV
// versions, and Agents. An untruncated value renders as plain text with no
// tooltip wiring at all; a truncated one wraps in a Tooltip so the full value
// is reachable on hover or keyboard focus.
export function TruncatedCell({
  text,
  maxLength,
}: {
  text: string;
  maxLength: number;
}) {
  const result = truncate(text, maxLength);

  if (!result.truncated) return <>{result.text}</>;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0}>{result.text}</span>
      </TooltipTrigger>
      <TooltipContent>{text}</TooltipContent>
    </Tooltip>
  );
}
