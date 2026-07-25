import { useEffect, useRef, useState } from 'react';

/** What the dialog is asking for: a password choice for a room we're about to start, or
 * the password of a room whose URL says it has one (see ROOM_LOCK_SUFFIX in App.tsx). */
export type CollabPrompt = { kind: 'start' } | { kind: 'join'; roomId: string };

/**
 * Modal shown before a collab room is created or joined. Starting a room is the only
 * moment its password can be chosen — it's baked into the trystero room key, so there's
 * no changing it later without moving everyone to a new room.
 */
export function CollabDialog({
  prompt,
  onSubmit,
  onCancel,
}: {
  prompt: CollabPrompt;
  /** null = open room (start only); a non-empty string = the room's password. */
  onSubmit: (password: string | null) => void;
  onCancel: () => void;
}) {
  const joining = prompt.kind === 'join';
  // Joining a locked room isn't a choice — the URL already said a password is required.
  const [locked, setLocked] = useState(joining);
  const [password, setPassword] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLFormElement>(null);

  // The overlay's key handler below is a React listener on the root container, so it only
  // sees keys pressed while focus is *inside* the dialog — with focus left on <body> every
  // keystroke goes straight to the canvas's window-level handler behind the modal. Take
  // focus on mount so that can't happen; the password field, when there is one, wants it
  // anyway.
  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  useEffect(() => {
    if (locked) inputRef.current?.focus();
  }, [locked]);

  // An empty password would silently become an open room, so require some text for it.
  const canSubmit = !locked || password.length > 0;

  return (
    <div
      className="collab-overlay"
      onClick={onCancel}
      // Escape closes; the rest is stopped here so the canvas's global keys (which ignore
      // INPUT targets but not the buttons) don't fire behind the modal.
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Escape') onCancel();
      }}
    >
      <form
        ref={panelRef}
        className="collab-panel"
        // Not in the tab order, but focusable so the dialog can hold focus before the user
        // has touched any control (see the mount effect above).
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          if (canSubmit) onSubmit(locked ? password : null);
        }}
      >
        <h2>{joining ? '共同編集ルームに参加' : '共同編集を開始'}</h2>
        {joining ? (
          <p className="collab-note">
            ルーム <code>{prompt.roomId}</code> はパスワードで保護されています。参加するにはパスワードを入力してください。
          </p>
        ) : (
          <div className="collab-choices">
            <label>
              <input type="radio" name="collab-lock" checked={!locked} onChange={() => setLocked(false)} />
              <span>
                パスワードなし
                <small>URLを知っている人は誰でも参加できます</small>
              </span>
            </label>
            <label>
              <input type="radio" name="collab-lock" checked={locked} onChange={() => setLocked(true)} />
              <span>
                パスワードあり
                <small>URLに加えてパスワードを知っている人だけが参加できます</small>
              </span>
            </label>
          </div>
        )}
        {locked && (
          <input
            ref={inputRef}
            className="collab-password"
            type="password"
            value={password}
            autoComplete={joining ? 'current-password' : 'new-password'}
            placeholder="パスワード"
            onChange={(e) => setPassword(e.target.value)}
          />
        )}
        {!joining && locked && (
          <p className="collab-note">パスワードはURLに含まれないので、参加者には別の手段で伝えてください。</p>
        )}
        <div className="collab-actions">
          <button type="button" onClick={onCancel}>
            キャンセル
          </button>
          <button type="submit" className="primary" disabled={!canSubmit}>
            {joining ? '参加' : '開始'}
          </button>
        </div>
      </form>
    </div>
  );
}
