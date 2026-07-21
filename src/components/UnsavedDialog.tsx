import { ModalShell } from './ModalShell';
import { DialogActions } from './DialogActions';

interface UnsavedDialogProps {
  open: boolean;
  documentCount?: number;
  onSave: () => void;
  onDiscard: () => void;
  onCancel: () => void;
}

export function UnsavedDialog({ open, documentCount = 1, onSave, onDiscard, onCancel }: UnsavedDialogProps) {
  return (
    <ModalShell open={open} titleId="unsaved-title" onCancel={onCancel}>
      <h2 id="unsaved-title">Unsaved changes</h2>
      <p>{documentCount > 1 ? `Save changes in ${documentCount} documents before closing?` : 'Save changes before closing?'}</p>
      <DialogActions>
        <button type="button" onClick={onCancel}>Cancel</button>
        <button type="button" onClick={onDiscard}>{documentCount > 1 ? 'Discard Selected' : 'Discard'}</button>
        <button type="button" className="primary" onClick={onSave}>{documentCount > 1 ? 'Save Selected' : 'Save'}</button>
      </DialogActions>
    </ModalShell>
  );
}
