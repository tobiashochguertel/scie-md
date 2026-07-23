import { Sparkles } from 'lucide-react';

interface AmbientSuggestionsProps {
  hasPasteReview: boolean;
  onOpenPasteReview: () => void;
}

export function AmbientSuggestions({ hasPasteReview, onOpenPasteReview }: AmbientSuggestionsProps) {
  if (!hasPasteReview) return null;

  return (
    <div className="ambient-strip" aria-label="Paste review">
      <button className="ambient-pill ai-review" onClick={onOpenPasteReview}>
        <Sparkles size={14} />
        Review pasted changes
      </button>
    </div>
  );
}
